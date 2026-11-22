// apps/documents/src/compare/viewer/CompareViewer.tsx
//
// Self-contained compare viewer: paints the engine's rasters into canvases
// and drives pan/zoom itself (does not use PdfOverlay). Modes:
//  - side-by-side: Base | Revision panes, optionally sharing one transform
//  - overlay: one canvas composited from `result.classes`
//  - changes: dimmed Revision + region outlines (cloud / box)

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";

import { useIsMobile } from "../../../../../packages/ff-viewer-tools/src/hooks/useIsMobile";
import { useCompareStore, type OverlayColors } from "../compareStore";
import { cloudPath } from "../cloudPath";
import { logPaint } from "../engine/debugTiming";
import type { ChangeRegion, CompareResult, CompareSide, HighlightStyle } from "../types";
import {
  KIND_COLOR,
  cloudArcFor,
  compositeOverlay,
  paintRaster,
  regionPx,
  releaseCanvas,
} from "./composite";
import {
  focusBox,
  fitView,
  panBy,
  useSyncedView,
  zoomAt,
  type PaneId,
  type Size,
  type ViewTransform,
} from "./useSyncedView";

const ZERO: Size = { width: 0, height: 0 };

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

function useVersionNumber(versionId: string | undefined): number | null {
  const row = useLiveQuery(
    async () => (versionId ? (await db.pdfVersions.get(versionId)) ?? null : null),
    [versionId],
  );
  return row?.versionNumber ?? null;
}

function sideLabel(prefix: string, side: CompareSide | undefined, n: number | null): string {
  if (!side) return prefix;
  return `${prefix} · v${n ?? "?"} · p${side.page}`;
}

export default function CompareViewer(): ReactNode {
  const isMobile = useIsMobile();
  const mode = useCompareStore((s) => s.mode);
  const status = useCompareStore((s) => s.status);
  const progress = useCompareStore((s) => s.progress);
  const error = useCompareStore((s) => s.error);
  const result = useCompareStore((s) => s.result);
  const base = useCompareStore((s) => s.base);
  const revision = useCompareStore((s) => s.revision);
  const resultSides = useCompareStore((s) => s.resultSides);
  const selectedId = useCompareStore((s) => s.selectedRegionId);
  const focusNonce = useCompareStore((s) => s.focusNonce);
  const style = useCompareStore((s) => s.settings.highlightStyle);
  const syncViews = useCompareStore((s) => s.syncViews);
  const setSyncViews = useCompareStore((s) => s.setSyncViews);
  const selectRegion = useCompareStore((s) => s.selectRegion);
  const nextRegion = useCompareStore((s) => s.nextRegion);
  const prevRegion = useCompareStore((s) => s.prevRegion);
  const layerVisibility = useCompareStore((s) => s.layerVisibility);
  const layerOpacity = useCompareStore((s) => s.layerOpacity);
  const colors = useCompareStore((s) => s.overlayColors);
  const setLayerVisibility = useCompareStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useCompareStore((s) => s.setLayerOpacity);

  const labelBase = resultSides?.base ?? base ?? undefined;
  const labelRev = resultSides?.revision ?? revision ?? undefined;
  const baseNum = useVersionNumber(labelBase?.pdfVersionId);
  const revNum = useVersionNumber(labelRev?.pdfVersionId);

  const { views, sync, update, setView, setSync } = useSyncedView(syncViews);
  // Keep the shared store flag and the hook in step.
  useEffect(() => {
    setSync(syncViews);
  }, [syncViews, setSync]);

  const sideBySide = mode === "side-by-side";
  const paneCount = sideBySide ? 2 : 1;
  const sizes = useRef<[Size, Size]>([ZERO, ZERO]);
  const pendingFit = useRef(true);
  const live = useRef({ result, sync, paneCount });
  live.current = { result, sync, paneCount };

  const doFit = useCallback((): void => {
    const { result: r, sync: sy, paneCount: pc } = live.current;
    if (!r) return;
    const s0 = sizes.current[0];
    if (s0.width <= 0) return;
    const content = { width: r.width, height: r.height };
    if (sy || pc === 1) {
      setView("all", fitView(content, s0));
    } else {
      setView(0, fitView(content, s0));
      const s1 = sizes.current[1];
      if (s1.width <= 0) return;
      setView(1, fitView(content, s1));
    }
    pendingFit.current = false;
  }, [setView]);

  useEffect(() => {
    pendingFit.current = true;
    doFit();
  }, [result, mode, isMobile, doFit]);

  const handleSize = useCallback(
    (pane: PaneId, size: Size) => {
      sizes.current[pane] = size;
      if (pendingFit.current) doFit();
    },
    [doFit],
  );

  // Centre + zoom to the selected region.
  useEffect(() => {
    if (selectedId === null || !result) return;
    const region = result.regions.find((r) => r.id === selectedId);
    if (!region) return;
    const b = regionPx(region, result.scale);
    const s0 = sizes.current[0];
    if (s0.width <= 0) return;
    if (live.current.sync || live.current.paneCount === 1) {
      setView("all", focusBox(b, s0));
    } else {
      setView(0, focusBox(b, s0));
      if (sizes.current[1].width > 0) setView(1, focusBox(b, sizes.current[1]));
    }
  }, [selectedId, focusNonce, result, setView]);

  // `[` / `]` step through regions; ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") useCompareStore.getState().prevRegion();
      else if (e.key === "]") useCompareStore.getState().nextRegion();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const zoomButton = (factor: number) => {
    const s = sizes.current[0];
    update(0, (v) => zoomAt(v, factor, s.width / 2, s.height / 2));
  };

  const regionLayer = (
    <RegionLayer
      result={result}
      style={style}
      selectedId={selectedId}
      onSelect={selectRegion}
    />
  );

  const hasSides = base !== null && revision !== null;
  const changeIndex = result ? result.regions.findIndex((r) => r.id === selectedId) : -1;

  return (
    <div
      style={rootStyle}
      tabIndex={0}
      data-testid="documents-compare-viewer"
      data-mode={mode}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !isTypingTarget(e.target)) selectRegion(null);
      }}
    >
      {result ? (
        <div
          style={{ ...panesStyle, flexDirection: isMobile ? "column" : "row" }}
          data-testid="documents-compare-panes"
        >
          {sideBySide ? (
            <>
              <ViewPane
                paneId={0}
                view={views[0]}
                result={result}
                onView={update}
                onSize={handleSize}
                label={sideLabel("Base", labelBase, baseNum)}
                testId="documents-compare-pane-base"
              >
                <RasterCanvas page={result.base} testId="documents-compare-canvas-base" />
                {regionLayer}
              </ViewPane>
              <ViewPane
                paneId={1}
                view={views[1]}
                result={result}
                onView={update}
                onSize={handleSize}
                label={sideLabel("Revision", labelRev, revNum)}
                testId="documents-compare-pane-revision"
              >
                <RasterCanvas page={result.revision} testId="documents-compare-canvas-revision" />
                {regionLayer}
              </ViewPane>
            </>
          ) : mode === "overlay" ? (
            <ViewPane
              paneId={0}
              view={views[0]}
              result={result}
              onView={update}
              onSize={handleSize}
              label="Overlay"
              testId="documents-compare-pane-overlay"
            >
              <OverlayCanvas
                classes={result.classes}
                width={result.width}
                height={result.height}
                showBase={layerVisibility.base}
                showRevision={layerVisibility.revision}
                baseOpacity={layerOpacity.base}
                revisionOpacity={layerOpacity.revision}
                colors={colors}
              />
            </ViewPane>
          ) : (
            <ViewPane
              paneId={0}
              view={views[0]}
              result={result}
              onView={update}
              onSize={handleSize}
              label={sideLabel("Revision", labelRev, revNum)}
              testId="documents-compare-pane-changes"
            >
              <RasterCanvas
                page={result.revision}
                dim
                testId="documents-compare-canvas-changes"
              />
              {regionLayer}
            </ViewPane>
          )}
        </div>
      ) : (
        <div style={centerStyle} data-testid="documents-compare-empty">
          {hasSides && status !== "error"
            ? status === "running"
              ? ""
              : "Press Run compare to start"
            : status === "error"
              ? ""
              : "Pick a Base and a Revision to compare"}
        </div>
      )}

      {status === "running" ? (
        <div style={loadingStyle} data-testid="documents-compare-loading" role="status">
          <style>{"@keyframes ff-compare-spin{to{transform:rotate(360deg)}}"}</style>
          <div style={spinnerStyle} />
          <div>
            {progress ? `${capitalize(progress.stage)}… ${Math.round(progress.fraction * 100)}%` : "Starting…"}
          </div>
        </div>
      ) : null}

      {status === "error" ? (
        <div style={errorCardStyle} data-testid="documents-compare-viewer-error" role="alert">
          <strong>Compare failed</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <div style={toolbarStyle} data-testid="documents-compare-toolbar">
          {mode === "overlay" ? (
            <div style={layersStyle} data-testid="documents-compare-layers">
              <LayerRow
                label="Base"
                color={colors.base}
                visible={layerVisibility.base}
                opacity={layerOpacity.base}
                onVisible={(v) => setLayerVisibility({ base: v })}
                onOpacity={(o) => setLayerOpacity({ base: o })}
                testId="base"
              />
              <LayerRow
                label="Revision"
                color={colors.revision}
                visible={layerVisibility.revision}
                opacity={layerOpacity.revision}
                onVisible={(v) => setLayerVisibility({ revision: v })}
                onOpacity={(o) => setLayerOpacity({ revision: o })}
                testId="revision"
              />
            </div>
          ) : null}
          <div style={buttonRowStyle}>
            {result.regions.length > 0 ? (
              <>
                <ToolButton label="Previous change" testId="documents-compare-viewer-prev" onClick={prevRegion}>
                  <path d="M15 6l-6 6 6 6" />
                </ToolButton>
                <span style={counterStyle} data-testid="documents-compare-viewer-counter" aria-live="polite">
                  {changeIndex >= 0 ? changeIndex + 1 : "–"} / {result.regions.length}
                </span>
                <ToolButton label="Next change" testId="documents-compare-viewer-next" onClick={nextRegion}>
                  <path d="M9 6l6 6-6 6" />
                </ToolButton>
                <span style={dividerStyle} aria-hidden="true" />
              </>
            ) : null}
            <ToolButton label="Zoom out" testId="documents-compare-zoom-out" onClick={() => zoomButton(1 / 1.25)}>
              <path d="M5 12h14" />
            </ToolButton>
            <ToolButton label="Zoom in" testId="documents-compare-zoom-in" onClick={() => zoomButton(1.25)}>
              <path d="M12 5v14M5 12h14" />
            </ToolButton>
            <ToolButton
              label="Fit to view"
              testId="documents-compare-fit"
              onClick={() => {
                pendingFit.current = true;
                doFit();
              }}
            >
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </ToolButton>
            {sideBySide ? (
              <ToolButton
                label={syncViews ? "Unlock views" : "Lock views"}
                testId="documents-compare-sync"
                active={syncViews}
                onClick={() => setSyncViews(!syncViews)}
              >
                {syncViews ? (
                  <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" />
                ) : (
                  <path d="M7 11V8a5 5 0 0 1 9.5-2M6 11h12v9H6z" />
                )}
              </ToolButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Pane ───────────────────────────────────────────────────────

interface ViewPaneProps {
  paneId: PaneId;
  view: ViewTransform;
  result: CompareResult;
  onView: (pane: PaneId, fn: (v: ViewTransform) => ViewTransform) => void;
  onSize: (pane: PaneId, size: Size) => void;
  label: string;
  testId: string;
  children: ReactNode;
}

function ViewPane({ paneId, view, result, onView, onSize, label, testId, children }: ViewPaneProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef<number | null>(null);
  const moved = useRef(0);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  const rel = (clientX: number, clientY: number) => {
    const r = ref.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  };

  // Size reporting.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onSize(paneId, { width: el.clientWidth, height: el.clientHeight });
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [paneId, onSize]);

  // Wheel zoom needs a non-passive listener to preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = rel(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * 0.0015);
      onViewRef.current(paneId, (v) => zoomAt(v, factor, p.x, p.y));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [paneId]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = 0;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchDist.current = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
    try {
      ref.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best effort */
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      pointers.current.set(e.pointerId, cur);
      moved.current += Math.abs(dx) + Math.abs(dy);
      onView(paneId, (v) => panBy(v, dx, dy));
    } else if (pointers.current.size === 2) {
      const oldPts = [...pointers.current.values()];
      pointers.current.set(e.pointerId, cur);
      const newPts = [...pointers.current.values()];
      const oldMid = { x: (oldPts[0]!.x + oldPts[1]!.x) / 2, y: (oldPts[0]!.y + oldPts[1]!.y) / 2 };
      const newMid = { x: (newPts[0]!.x + newPts[1]!.x) / 2, y: (newPts[0]!.y + newPts[1]!.y) / 2 };
      const dist = Math.hypot(newPts[0]!.x - newPts[1]!.x, newPts[0]!.y - newPts[1]!.y);
      const factor = pinchDist.current && pinchDist.current > 0 ? dist / pinchDist.current : 1;
      pinchDist.current = dist;
      const m = rel(newMid.x, newMid.y);
      moved.current += 10;
      onView(paneId, (v) => zoomAt(panBy(v, newMid.x - oldMid.x, newMid.y - oldMid.y), factor, m.x, m.y));
    }
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinchDist.current = null;
  };

  return (
    <div
      ref={ref}
      style={paneStyle}
      data-testid={testId}
      data-scale={view.scale.toFixed(4)}
      data-tx={view.tx.toFixed(2)}
      data-ty={view.ty.toFixed(2)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // A drag must not end up as a region click.
      onClickCapture={(e) => {
        if (moved.current > 4) {
          e.stopPropagation();
          moved.current = 0;
        }
      }}
    >
      <div
        style={{
          ...pageStyle,
          width: result.width,
          height: result.height,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
        }}
      >
        {children}
      </div>
      <div style={paneLabelStyle} data-testid={`${testId}-label`}>
        {label}
      </div>
    </div>
  );
}

// ── Raster + regions ───────────────────────────────────────────

const RasterCanvas = memo(function RasterCanvas({
  page,
  dim,
  testId,
}: {
  page: { width: number; height: number; data: Uint8ClampedArray };
  dim?: boolean;
  testId: string;
}): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // One paint per raster (pan/zoom is a CSS transform on the pane).
  useEffect(() => {
    if (ref.current) {
      paintRaster(ref.current, page.width, page.height, page.data);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => logPaint(testId));
    }
  }, [page, testId]);
  // Free the (up to 48 MB) backing store as soon as the canvas goes away.
  useEffect(() => {
    const c = ref.current;
    return () => releaseCanvas(c);
  }, []);
  return (
    <canvas
      ref={ref}
      width={page.width}
      height={page.height}
      data-testid={testId}
      style={{ ...canvasStyle, opacity: dim ? 0.35 : 1 }}
    />
  );
});

/**
 * Overlay: composites `classes` into one reusable buffer inside the paint
 * effect (no 48 MB buffer kept in a memo) and releases the buffer and the
 * canvas on unmount.
 */
function OverlayCanvas({
  classes,
  width,
  height,
  showBase,
  showRevision,
  baseOpacity,
  revisionOpacity,
  colors,
}: {
  classes: Uint8Array;
  width: number;
  height: number;
  showBase: boolean;
  showRevision: boolean;
  baseOpacity: number;
  revisionOpacity: number;
  colors: OverlayColors;
}): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const buf = useRef<Uint8ClampedArray | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const opts = { showBase, showRevision, baseOpacity, revisionOpacity, colors };
    const px = compositeOverlay(classes, width, height, opts, buf.current);
    buf.current = px;
    paintRaster(c, width, height, px);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => logPaint("documents-compare-canvas-overlay"));
  }, [classes, width, height, showBase, showRevision, baseOpacity, revisionOpacity, colors]);
  useEffect(() => {
    const c = ref.current;
    return () => {
      buf.current = null;
      releaseCanvas(c);
    };
  }, []);
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      data-testid="documents-compare-canvas-overlay"
      style={canvasStyle}
    />
  );
}

function RegionLayer({
  result,
  style,
  selectedId,
  onSelect,
}: {
  result: CompareResult | null;
  style: HighlightStyle;
  selectedId: number | null;
  onSelect: (id: number) => void;
}): ReactNode {
  if (!result || result.regions.length === 0) return null;
  return (
    <svg
      width={result.width}
      height={result.height}
      viewBox={`0 0 ${result.width} ${result.height}`}
      style={svgStyle}
      data-testid="documents-compare-regions"
    >
      {result.regions.map((r: ChangeRegion) => {
        const b = regionPx(r, result.scale);
        const selected = r.id === selectedId;
        const color = KIND_COLOR[r.kind];
        const common = {
          fill: selected ? color : "transparent",
          fillOpacity: selected ? 0.18 : 0,
          stroke: color,
          strokeWidth: selected ? 4 : 2,
          vectorEffect: "non-scaling-stroke" as const,
          style: { cursor: "pointer", pointerEvents: "all" as const },
          "data-testid": `documents-compare-region-${r.id}`,
          "data-selected": selected ? "true" : "false",
          "data-kind": r.kind,
          onClick: () => onSelect(r.id),
        };
        return style === "cloud" ? (
          <path key={r.id} d={cloudPath(b.x, b.y, b.w, b.h, cloudArcFor(b.w, b.h))} {...common} />
        ) : (
          <rect key={r.id} x={b.x} y={b.y} width={b.w} height={b.h} {...common} />
        );
      })}
    </svg>
  );
}

// ── Toolbar bits ───────────────────────────────────────────────

function ToolButton({
  label,
  testId,
  onClick,
  active,
  children,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      style={{ ...toolButtonStyle, color: active ? "var(--ff-blue-active)" : "var(--ff-text-primary)" }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function LayerRow({
  label,
  color,
  visible,
  opacity,
  onVisible,
  onOpacity,
  testId,
}: {
  label: string;
  color: string;
  visible: boolean;
  opacity: number;
  onVisible: (v: boolean) => void;
  onOpacity: (o: number) => void;
  testId: string;
}): ReactNode {
  return (
    <label style={layerRowStyle}>
      <input
        type="checkbox"
        checked={visible}
        onChange={(e) => onVisible(e.target.checked)}
        data-testid={`documents-compare-layer-${testId}`}
        aria-label={`Show ${label}`}
      />
      <span style={{ ...swatchStyle, background: color }} />
      <span style={{ width: 62 }}>{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={opacity}
        onChange={(e) => onOpacity(Number(e.target.value))}
        data-testid={`documents-compare-opacity-${testId}`}
        aria-label={`${label} opacity`}
      />
    </label>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const rootStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
  outline: "none",
  overflow: "hidden",
};

const panesStyle: CSSProperties = { flex: 1, display: "flex", minHeight: 0, minWidth: 0, gap: 2 };

const paneStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  background: "var(--ff-bg-panel)",
  touchAction: "none",
  cursor: "grab",
  userSelect: "none",
};

const pageStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  transformOrigin: "0 0",
  background: "#ffffff",
  boxShadow: "0 1px 6px rgba(0,0,0,0.25)",
};

const canvasStyle: CSSProperties = { display: "block", position: "absolute", left: 0, top: 0, width: "100%", height: "100%" };

const svgStyle: CSSProperties = { position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" };

const paneLabelStyle: CSSProperties = {
  position: "absolute",
  left: 8,
  top: 8,
  padding: "3px 8px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  background: "var(--ff-bg-panel)",
  border: "1px solid var(--ff-border)",
  color: "var(--ff-text-primary)",
  pointerEvents: "none",
};

const centerStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  textAlign: "center",
  fontSize: 14,
  color: "var(--ff-text-muted)",
};

const loadingStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: "rgba(0,0,0,0.25)",
  color: "var(--ff-text-primary)",
  fontSize: 13,
  zIndex: 5,
};

const spinnerStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "3px solid var(--ff-border)",
  borderTopColor: "var(--ff-blue-active)",
  animation: "ff-compare-spin 0.8s linear infinite",
  // Own compositor layer: keeps spinning while the main thread is busy rendering.
  willChange: "transform",
};

const errorCardStyle: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  maxWidth: 420,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "14px 18px",
  borderRadius: 10,
  background: "var(--ff-bg-panel)",
  border: "1px solid #e5484d",
  color: "var(--ff-text-primary)",
  fontSize: 13,
  zIndex: 6,
};

const toolbarStyle: CSSProperties = {
  position: "absolute",
  bottom: 14,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  zIndex: 4,
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 4,
  borderRadius: 10,
  background: "var(--ff-bg-panel)",
  border: "1px solid var(--ff-border)",
};

const layersStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 10px",
  borderRadius: 10,
  background: "var(--ff-bg-panel)",
  border: "1px solid var(--ff-border)",
  fontSize: 12,
};

const counterStyle: CSSProperties = {
  minWidth: 44,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
  color: "var(--ff-text-primary)",
};

const dividerStyle: CSSProperties = { width: 1, margin: "4px 2px", background: "var(--ff-border)" };

const layerRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const swatchStyle: CSSProperties = { width: 10, height: 10, borderRadius: 2, flexShrink: 0 };

const toolButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
