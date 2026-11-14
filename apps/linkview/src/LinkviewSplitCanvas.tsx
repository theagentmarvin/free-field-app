// apps/linkview/src/LinkviewSplitCanvas.tsx
//
// Wave 52 — the Linkview canvas, reworked around the shared 3D surface.
//
//   Split View (default):
//     ┌────────────────────────────────────────────┐
//     │  Left: IfcViewer (level-plan / PdfOverlay) │  Right: shared
//     │         + EmptyPane when nothing picked    │  3D surface
//     └────────────────────────────────────────────┘
//
//   Overlap:
//     ┌────────────────────────────────────────────┐
//     │  Single pane = the shared 3D surface,      │
//     │  with the 2D plan overlaid on top via      │
//     │  <useFloorPlanOverlay> (LinkviewApp).      │
//     └────────────────────────────────────────────┘
//
// The RIGHT pane is NOT an IfcViewer anymore — it portals the shared
// persistent surface (from apps/settings' <ViewerKeepAlive>) into a
// <ViewerSurfaceHostSlot>, and layers <LinkviewToolbar> + the shared
// <PropertiesDrawer> on top of it. There are still exactly two WebGL
// cameras (the shared surface + the left level-plan viewer); the old
// dedicated right IfcViewer and its spawn-point walk-through are gone.
//
// Wave 55: the right pane also hosts `chrome` (the tools toolbar +
// panel slot from LinkviewApp, anchored top-left of the 3D viewer
// per docs/ux/toolbar-nomenclature.md), and the left pane gains the
// PDF-style navigation cluster (<PlanNavToolbar>: zoom out · zoom in
// · fit plan) over model level plans.

import { PdfMeasureLayer } from "@ff/viewer-tools/pdf-measure";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import {
  IfcViewer,
  PdfOverlay,
  type IfcViewerHandle,
  type IfcViewerSlice,
  type PdfOverlayHandle,
} from "@ff/viewer-react";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { useIfcFiles } from "@ff/data/hooks";
import {
  useIfcPipeline,
  getStoreysForBuilding,
} from "@ff/data/hooks";
import { useIsMobile } from "@ff/viewer-tools";

// Direct import (not the @free-field/models barrel) for the same
// reason the sidebar imports BuildingPicker directly: the barrel
// re-exports ModelsApp/PersistentViewerSurface, which transitively
// pull three.js + the IFC viewer (+ the tasks-react firebase chain)
// and break jsdom.
import { ViewerSurfaceHostSlot } from "../../models/src/viewerSurfaceHost";
import { useProjectId } from "@ff/auth";
import LinkviewPropertiesPanel from "./LinkviewPropertiesPanel";
import LinkviewToolbar from "./LinkviewToolbar";
import type { LinkviewMode } from "./linkviewMode";

const STORAGE_KEY = "ff:linkview:split-fraction";
const DEFAULT_LEFT_FRACTION = 0.5;
const MIN_LEFT_FRACTION = 0.2;
const MAX_LEFT_FRACTION = 0.8;
const DIVIDER_WIDTH = 8;

export interface LinkviewSplitCanvasProps {
  buildingId: string | null;
  activePdfVersionId: string | null;
  activeStoreyId: string | null;
  setActiveStoreyName: (name: string | null) => void;
  /** Imperative ref to the LEFT level-plan IfcViewer. */
  leftViewerRef: RefObject<IfcViewerHandle>;
  /** Current layout mode. */
  mode: LinkviewMode;
  /** The shared persistent surface handle (right pane). */
  surfaceViewerRef: RefObject<IfcViewerHandle>;
  /** Register the right pane as the shared surface's portal target. */
  registerHost: (node: HTMLElement | null) => void;
  /** True once the shared surface has loaded ≥1 model. */
  surfaceLoaded: boolean;
  /** Wave 55 — the tools toolbar + panel slot, rendered inside the
   *  right (3D) pane's relative container so they anchor to the
   *  viewer's top-left in BOTH split and overlap modes. */
  chrome?: ReactNode;
  /** Wave 57 — imperative handle to the left-pane <PdfOverlay> so
   *  the parent can reach getAnnotationLayer()/getTotalScale()/
   *  onReady() for the navigation marker. Null while no PDF is open. */
  pdfOverlayRef: RefObject<PdfOverlayHandle>;
  /** Wave 58 — click-to-place: fired with PDF page coords when the
   *  user clicks (not drags) on the PDF while nav is active. The
   *  parent moves the nav marker there and re-centers the camera.
   *  When undefined, the PDF stays fully interactive (no click
   *  capture). */
  onPdfClick?: (coords: { x: number; y: number }) => void;
  /** Measuring on the left PDF: metres per PDF point from the page's
   *  calibration (page 1) + its size in points. Null → uncalibrated. */
  measureCalibration?: {
    metresPerUnit: number;
    pageWidth: number;
    pageHeight: number;
  } | null;
}

function LinkviewSplitCanvas({
  buildingId,
  activePdfVersionId,
  activeStoreyId,
  setActiveStoreyName,
  leftViewerRef,
  mode,
  surfaceViewerRef,
  registerHost,
  surfaceLoaded,
  chrome,
  pdfOverlayRef,
  onPdfClick,
  measureCalibration = null,
}: LinkviewSplitCanvasProps): ReactNode {
  const files = useIfcFiles(buildingId);
  const { registerFragments } = useIfcPipeline();
  const isMobile = useIsMobile();

  // LEFT slice: activeStoreyName is OUTBOUND-only; setActiveStoreyName
  // mirrors openLevel/closeLevel back to the parent.
  const projectId = useProjectId();
  const leftViewerSlice = useMemo<IfcViewerSlice>(
    () => ({ activeStoreyName: null, setActiveStoreyName }),
    [setActiveStoreyName],
  );

  // ── Split position (persisted to localStorage) ─────────────────────
  const [leftFraction, setLeftFraction] = useState<number>(
    DEFAULT_LEFT_FRACTION,
  );
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed = Number(raw);
      if (
        Number.isFinite(parsed) &&
        parsed >= MIN_LEFT_FRACTION &&
        parsed <= MAX_LEFT_FRACTION
      ) {
        setLeftFraction(parsed);
      }
    } catch {
      // ignore
    }
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<boolean>(false);
  const fractionRef = useRef(leftFraction);
  useEffect(() => {
    fractionRef.current = leftFraction;
  }, [leftFraction]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    let next = (e.clientX - rect.left) / rect.width;
    if (next < MIN_LEFT_FRACTION) next = MIN_LEFT_FRACTION;
    if (next > MAX_LEFT_FRACTION) next = MAX_LEFT_FRACTION;
    setLeftFraction(next);
    fractionRef.current = next;
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(fractionRef.current));
    } catch {
      // ignore
    }
  }, []);

  const shellStyle: CSSProperties = useMemo(
    () => ({
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      display: "flex",
      flexDirection: isMobile ? ("column" as const) : ("row" as const),
      background: "var(--ff-bg-panel)",
      position: "relative",
      overflow: "hidden",
    }),
    [isMobile],
  );

  // ── LEFT pane overlay priority ────────────────────────────────────
  //   1. PDF selected → PdfOverlay covers (Split mode)
  //   2. Storey selected → no overlay (level-plan shows through)
  //   3. Neither → empty-state pane
  let leftOverlay: ReactNode = null;
  if (activePdfVersionId !== null) {
    leftOverlay = (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          zIndex: 2,
          background: "var(--ff-bg-canvas)",
          touchAction: isMobile ? "none" : undefined,
        }}
        data-testid="linkview-pdf-overlay"
      >
        <PdfOverlay
          ref={pdfOverlayRef}
          key={activePdfVersionId}
          pdfVersionId={activePdfVersionId}
          getPdfVersion={getPdfVersion}
          getPdfBlob={getPdfBlob}
          captureClicks={onPdfClick !== undefined}
          onPdfClick={onPdfClick}
        />
        <PdfMeasureLayer
          key={`measure-${activePdfVersionId}`}
          overlayRef={pdfOverlayRef}
          pdfVersionId={activePdfVersionId}
          calibrationMetresPerUnit={measureCalibration?.metresPerUnit ?? null}
          fallbackPageSize={
            measureCalibration
              ? { width: measureCalibration.pageWidth, height: measureCalibration.pageHeight }
              : null
          }
        />
      </div>
    );
  } else if (activeStoreyId === null) {
    leftOverlay = (
      <EmptyPane
        title="Nothing selected"
        hint="Open Mapped PDFs or Model Floor Plans from the tools toolbar (top-left of the 3D viewer)."
        testId="linkview-left-empty"
      />
    );
  }

  // Perf: while an opaque layer (the PDF overlay or the empty-state
  // pane) fully covers the left level-plan viewer, pause its WebGL
  // rendering — it would otherwise redraw every model each frame
  // underneath. The viewer stays MOUNTED (not unmounted): its loaded
  // models, LevelPlanController state and the parked openLevel retry
  // in LinkviewApp all live on it, and remounting would re-stream
  // every model when the user switches back to a model floor plan.
  // The nav seed / calibration math reads the SHARED surface handle
  // (getModelCentroid / getLevelPlanDistance / getPose), never this
  // viewer, so pausing it cannot affect the nav view.
  const leftRenderPaused = leftOverlay !== null;

  const leftPane = (
    <div
      data-testid="linkview-level-plan-pane"
      style={{
        width: isMobile ? "100%" : `calc(${leftFraction * 100}% - ${DIVIDER_WIDTH / 2}px)`,
        height: isMobile ? "50%" : "100%",
        position: "relative",
        overflow: "hidden",
        background: "var(--ff-bg-canvas)",
        flexShrink: 0,
      }}
    >
      {buildingId !== null && projectId ? (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              touchAction: isMobile ? "none" : undefined,
            }}
            data-testid="linkview-level-plan-viewer"
          >
            <IfcViewer
              ref={leftViewerRef}
              projectId={projectId}
              activeBuildingId={buildingId}
              files={files}
              getFragBlob={getFragBlob}
              registerFragments={registerFragments}
              getStoreysForBuilding={getStoreysForBuilding}
              viewerSlice={leftViewerSlice}
              disableSelection
              // Wave 52 — suppress the full-screen loading overlay when
              // the shared surface already loaded the building (warm
              // Dexie; the load is sub-second). The RIGHT pane never
              // shows a loader (it's the persistent surface).
              loadingOverlay={!surfaceLoaded}
              renderPaused={leftRenderPaused}
            />
          </div>
          {leftOverlay}
          {/* Wave 55 — PDF-style navigation over the model level plan
              (same icons/logic as the pv-toolbar: zoom out · zoom in ·
              fit). Only while the level plan is the visible left
              content (no PDF overlay). */}
          {activeStoreyId !== null && activePdfVersionId === null && (
            <PlanNavToolbar getHandle={() => leftViewerRef.current} />
          )}
        </>
      ) : (
        <EmptyPane
          title="No building selected"
          hint="Create a building in Settings to see its IFC here."
          testId="linkview-left-empty-building"
        />
      )}
    </div>
  );

  // ── RIGHT pane: the shared persistent surface ──────────────────────
  const rightPane = (
    <div
      data-testid="linkview-right-pane"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        background: "var(--ff-bg-canvas)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }} data-testid="linkview-shared-surface">
        {/* The shared surface portals into this slot. */}
        <ViewerSurfaceHostSlot registerHost={registerHost} testId="linkview-context-viewer" />
        {/* Wave 52/55 — floating viewer tools toolbar (bottom-center):
            Measure + Save view ONLY; the mode toggle moved to the
            tools toolbar. */}
        {projectId && (
          <LinkviewToolbar
            getHandle={() => surfaceViewerRef.current}
            projectId={projectId}
            showOverlayOpacity={mode === "overlap"}
          />
        )}
        {/* Wave 55 — the tools toolbar + panel slot (top-left of this
            pane), passed down from LinkviewApp. */}
        {chrome}
      </div>
      {/* Selection properties: the Models-style floating panel, anchored
          to the right edge of this pane (never over the PDF). Always
          mounted so the setOnElementPick subscription is stable. */}
      <LinkviewPropertiesPanel viewerRef={surfaceViewerRef} />
    </div>
  );

  // Wave 55 — the Split/Overlap switch (now in the tools toolbar)
  // only changes whether the LEFT pane + divider render.
  return (
    <div
      ref={containerRef}
      style={shellStyle}
      className="ff-linkview-split-canvas"
      data-testid="linkview-split-canvas"
      data-mode={mode}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {mode === "split" && (
        <>
          {leftPane}
          {!isMobile && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize left and right panels"
              aria-valuenow={Math.round(leftFraction * 100)}
              aria-valuemin={Math.round(MIN_LEFT_FRACTION * 100)}
              aria-valuemax={Math.round(MAX_LEFT_FRACTION * 100)}
              tabIndex={0}
              title="Drag to resize"
              onPointerDown={onPointerDown}
              style={{
                width: DIVIDER_WIDTH,
                height: "100%",
                background: "var(--ff-divider)",
                cursor: "col-resize",
                flexShrink: 0,
                touchAction: "none",
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 150ms",
              }}
              data-testid="linkview-split-divider"
            >
              <div
                aria-hidden="true"
                style={{
                  display: "flex",
                  gap: 2,
                  opacity: 0.3,
                  pointerEvents: "none",
                  transition: "opacity 150ms",
                }}
                className="ff-linkview-split-grip"
              >
                <span style={{ width: 2, height: 18, borderRadius: 1, background: "var(--ff-text-primary)" }} />
                <span style={{ width: 2, height: 18, borderRadius: 1, background: "var(--ff-text-primary)" }} />
              </div>
            </div>
          )}
        </>
      )}
      {rightPane}
    </div>
  );
}

// Memoized: LinkviewApp re-renders on every live nav-marker update
// (camera follow); with stable props (memoized `chrome`, stable
// callbacks/refs) this canvas — and the left IfcViewer + PdfOverlay
// in it — skips those renders.
export default memo(LinkviewSplitCanvas);

function EmptyPane({
  title,
  hint,
  testId,
}: {
  title: string;
  hint: string;
  testId: string;
}): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 24,
        color: "var(--ff-text-muted)",
        textAlign: "center",
        background: "var(--ff-bg-canvas)",
        zIndex: 3,
      }}
      data-testid={testId}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ff-text-primary)" }}>
        {title}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>{hint}</div>
    </div>
  );
}

// ── Wave 55: model-level-plan navigation cluster ────────────────────
// The PDF pane ships the pv-toolbar (zoom out · zoom % · zoom in ·
// fit); model level plans now get the SAME icons and logic, per the
// Maintainer directive 2026-11-08 17:41 ("same navigation icon and logic
// for model levels"). Zoom replays a synthetic wheel through the
// handle's ortho-aware zoom() (camera-controls ACTION.ZOOM path);
// Fit replays the LevelPlanController open() framing via the new
// fitLevelPlan() handle method (ff-viewer-react, wave 55).

const PLAN_NAV_ICONS = {
  // pv-zoom-out (magnifier −), path verbatim from pdfViewer.ts.
  zoomOut:
    "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z",
  // pv-zoom-in (magnifier +).
  zoomIn:
    "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm-1-2h2v2h1v-2h2V9h-2V7h-1v2h-2v1z",
  // pv-fit-p (fit page).
  fit: "M3 5v14h18V5H3zm16 6h-3.5V7.5h-2V11H10V7.5h-2V11H4.5v2H8v3.5h2V13h3.5v3.5h2V13H19v-2z",
} as const;

/** Synthetic wheel delta per click (≈3 notches; matches the feel of
 *  the pv-toolbar's ±0.25 zoom step). Negative = scroll up = zoom in. */
const PLAN_ZOOM_DELTA = 300;

function PlanNavToolbar({
  getHandle,
}: {
  getHandle: () => IfcViewerHandle | null;
}): ReactNode {
  const zoomAtCenter = (deltaY: number): void => {
    const h = getHandle();
    if (!h) return;
    const rect = h.getContainer()?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    h.zoom(deltaY, cx, cy);
  };
  return (
    <div
      className="ff-frosted"
      data-testid="linkview-plan-nav"
      role="toolbar"
      aria-label="Floor plan navigation"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: 4,
        borderRadius: 12,
      }}
    >
      <PlanNavButton
        testId="linkview-plan-zoom-out"
        label="Zoom out"
        path={PLAN_NAV_ICONS.zoomOut}
        onClick={() => zoomAtCenter(PLAN_ZOOM_DELTA)}
      />
      <PlanNavButton
        testId="linkview-plan-zoom-in"
        label="Zoom in"
        path={PLAN_NAV_ICONS.zoomIn}
        onClick={() => zoomAtCenter(-PLAN_ZOOM_DELTA)}
      />
      <PlanNavButton
        testId="linkview-plan-fit"
        label="Fit plan"
        path={PLAN_NAV_ICONS.fit}
        onClick={() => {
          const h = getHandle();
          if (h) void h.fitLevelPlan();
        }}
      />
    </div>
  );
}

function PlanNavButton({
  testId,
  label,
  path,
  onClick,
}: {
  testId: string;
  label: string;
  path: string;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "none",
        borderRadius: 8,
        background: "transparent",
        color: "#5b626b",
        cursor: "pointer",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    </button>
  );
}