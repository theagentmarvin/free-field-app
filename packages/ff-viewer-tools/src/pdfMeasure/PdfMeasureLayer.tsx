// PdfMeasureLayer — length / area measuring on a rendered PDF page.
//
// An SVG is portaled into the viewer's annotation layer (a sibling of the
// canvas inside `.pv-zoom-transform`), with `viewBox` = the page in page
// units. It therefore tracks zoom / pan / re-render for free; the only
// thing recomputed on zoom is the screen-constant sizes (stroke, label
// font, vertex radius = N px / totalScale), so labels stay readable.
//
// Input: pointer tap (down→up within ~6px / 500ms) on the SVG, so drags
// still pan the page (the viewer's pan listener sits on an ancestor).
// Points are mapped client→page via the SVG's own post-transform rect.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { PdfOverlayHandle } from "@ff/viewer-react";

import { formatArea, formatLength, scaleBadgeText } from "./format";
import {
  centroid,
  clientToPage,
  distance,
  midpoint,
  polygonArea,
  polygonPerimeter,
  polylineLength,
  segmentLengths,
  snapToPoints,
  type Point,
} from "./geometry";
import {
  resolvePageScale,
  scaleFromTwoPoints,
  toMetres,
  type LengthUnit,
  type PageScale,
} from "./scale";
import { measureKey, MIN_POINTS, usePdfMeasureStore, type Measurement } from "./store";

const TAP_MOVE_PX = 6;
const TAP_MAX_MS = 500;
const SNAP_PX = 10;
const DEDUPE_PX = 3;
const POLL_MS = 250;

export interface PdfMeasureLayerProps {
  overlayRef: RefObject<PdfOverlayHandle | null> | null | undefined;
  /** Session key for stored measurements; remount (or change) per PDF version. */
  pdfVersionId: string;
  /** Calibration scale (metres per PDF point); applies to page 1 only. */
  calibrationMetresPerUnit?: number | null;
  /** Page-1 size in points, used until the PDF.js document is readable. */
  fallbackPageSize?: { width: number; height: number } | null;
}

interface ViewState {
  layer: HTMLElement | null;
  page: number;
  totalScale: number;
  pageSize: { width: number; height: number } | null;
}

const EMPTY_VIEW: ViewState = { layer: null, page: 1, totalScale: 1, pageSize: null };

export default function PdfMeasureLayer({
  overlayRef,
  pdfVersionId,
  calibrationMetresPerUnit = null,
  fallbackPageSize = null,
}: PdfMeasureLayerProps): ReactNode {
  const [view, setView] = useState<ViewState>(EMPTY_VIEW);
  const pageSizes = useRef(new Map<number, { width: number; height: number }>());
  const docRef = useRef<unknown>(null);

  // ── follow the viewer: layer, page, zoom, page size ─────────────────
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | null = null;
    let subLayer: HTMLElement | null = null;

    const refresh = (): void => {
      const h = overlayRef?.current;
      if (!h || !alive) return;
      const layer = h.getAnnotationLayer();
      const page = h.getCurrentPage?.() ?? 1;
      const totalScale = h.getTotalScale();
      const doc = h.getDocument?.() ?? null;
      if (doc !== docRef.current) {
        docRef.current = doc;
        pageSizes.current.clear();
      }
      let pageSize = pageSizes.current.get(page) ?? null;
      if (!pageSize && doc) {
        void (async () => {
          try {
            const p = await doc.getPage(page);
            const vp = p.getViewport({ scale: 1 });
            pageSizes.current.set(page, { width: vp.width, height: vp.height });
            refresh();
          } catch {
            /* fall back below */
          }
        })();
      }
      if (!pageSize && page === 1 && fallbackPageSize) pageSize = fallbackPageSize;
      setView((v) =>
        v.layer === layer &&
        v.page === page &&
        v.totalScale === totalScale &&
        v.pageSize?.width === pageSize?.width &&
        v.pageSize?.height === pageSize?.height
          ? v
          : { layer, page, totalScale, pageSize },
      );
      if (layer && layer !== subLayer) {
        unsub?.();
        subLayer = layer;
        unsub = h.setOnScaleChange(refresh);
      }
    };

    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
      unsub?.();
    };
  }, [overlayRef, fallbackPageSize]);

  const { page, totalScale, layer, pageSize } = view;
  const key = measureKey(pdfVersionId, page);

  const tool = usePdfMeasureStore((s) => s.tool);
  const draft = usePdfMeasureStore((s) => s.draft);
  const list = usePdfMeasureStore((s) => s.measurements[key]);
  const manual = usePdfMeasureStore((s) => s.manualScales[key] ?? null);
  const store = usePdfMeasureStore;

  const measurements = list ?? [];
  const scale: PageScale = useMemo(
    () =>
      resolvePageScale({
        page,
        manualMetresPerUnit: manual,
        calibrationMetresPerUnit,
      }),
    [page, manual, calibrationMetresPerUnit],
  );

  // A draft belongs to one page: drop it when the page / PDF changes.
  useEffect(() => {
    store.setState({ draft: [] });
  }, [key, store]);

  const [hover, setHover] = useState<Point | null>(null);
  const [scaleInput, setScaleInput] = useState("");
  const [scaleUnit, setScaleUnit] = useState<LengthUnit>("m");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const snapCandidates = useMemo(() => {
    const pts: Point[] = [];
    for (const m of measurements) pts.push(...m.points);
    pts.push(...draft);
    return pts;
  }, [measurements, draft]);

  const toPage = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const svg = svgRef.current;
      if (!svg || !pageSize) return null;
      const raw = clientToPage(
        clientX,
        clientY,
        svg.getBoundingClientRect(),
        pageSize.width,
        pageSize.height,
      );
      if (!raw) return null;
      // Snap radius is constant on screen: SNAP_PX / totalScale page units.
      return snapToPoints(raw, snapCandidates, SNAP_PX / Math.max(totalScale, 1e-6)).point;
    },
    [pageSize, snapCandidates, totalScale],
  );

  const finish = useCallback((): void => {
    store.getState().finish(key);
    setHover(null);
  }, [key, store]);

  // ── keyboard: Escape cancels, Enter finishes, Backspace undoes a point ──
  useEffect(() => {
    if (tool === "none") return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === "Escape") {
        store.getState().cancel();
        setHover(null);
      } else if (e.key === "Enter") {
        finish();
      } else if (e.key === "Backspace") {
        store.getState().removeLastDraftPoint();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, finish, store]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (tool === "none" || draft.length === 0) return;
    setHover(toPage(e.clientX, e.clientY));
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const down = downRef.current;
    downRef.current = null;
    if (!down || tool === "none") return;
    if (Date.now() - down.t > TAP_MAX_MS) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_MOVE_PX) return;
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    // A tap on the first vertex of an area closes it.
    if (tool === "area" && draft.length >= MIN_POINTS.area) {
      if (distance(p, draft[0]) <= 1e-9) {
        finish();
        return;
      }
    }
    store.getState().addDraftPoint(p, DEDUPE_PX / Math.max(totalScale, 1e-6));
  };

  const onDoubleClick = (): void => {
    if (tool === "length" || tool === "area") finish();
  };

  // ── screen-constant sizes ──────────────────────────────────────────
  const k = 1 / Math.max(totalScale, 1e-6);
  const fontSize = 12 * k;
  const vertexR = 3.5 * k;

  const labelEl = (p: Point, text: string, id: string, strong = false): ReactNode => (
    <text
      key={id}
      x={p.x}
      y={p.y}
      fontSize={fontSize * (strong ? 1.1 : 1)}
      fontWeight={strong ? 700 : 500}
      textAnchor="middle"
      dominantBaseline="central"
      fill="#0b3d91"
      stroke="#fff"
      strokeWidth={3 * k}
      paintOrder="stroke"
      strokeLinejoin="round"
      style={{ pointerEvents: "none", userSelect: "none" }}
      data-testid="pdf-measure-label"
    >
      {text}
    </text>
  );

  const renderShape = (
    points: Point[],
    kind: "length" | "area",
    id: string,
    rubber: Point | null,
    inProgress: boolean,
  ): ReactNode => {
    const pts = rubber ? [...points, rubber] : points;
    if (pts.length === 0) return null;
    const closed = kind === "area" && pts.length >= 3;
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + (closed ? " Z" : "");
    const color = inProgress ? "#e8590c" : "#1971c2";
    const segs = segmentLengths(closed ? [...pts, pts[0]] : pts);
    const segPts = closed ? [...pts, pts[0]] : pts;
    const out: ReactNode[] = [];
    out.push(
      <path
        key={`${id}-p`}
        d={d}
        fill={closed ? color : "none"}
        fillOpacity={0.15}
        stroke={color}
        strokeWidth={2 * k}
        strokeDasharray={inProgress ? `${6 * k} ${4 * k}` : undefined}
       
        strokeLinejoin="round"
        strokeLinecap="round"
      />,
    );
    points.forEach((p, i) =>
      out.push(<circle key={`${id}-v${i}`} cx={p.x} cy={p.y} r={vertexR} fill="#fff" stroke={color} strokeWidth={2 * k} />),
    );
    // per-segment labels (skip when only one segment: the total says it)
    if (segs.length > 1 || kind === "area") {
      segs.forEach((len, i) => {
        if (len * (totalScale || 1) < 36) return; // too short to label legibly
        out.push(labelEl(midpoint(segPts[i], segPts[i + 1]), formatLength(len, scale), `${id}-s${i}`));
      });
    }
    if (kind === "length") {
      if (pts.length >= 2) {
        const last = pts[pts.length - 1];
        out.push(
          labelEl(
            { x: last.x, y: last.y - 16 * k },
            (pts.length > 2 ? "Total " : "") + formatLength(polylineLength(pts), scale),
            `${id}-t`,
            true,
          ),
        );
      }
    } else if (closed) {
      out.push(
        labelEl(
          centroid(pts),
          `${formatArea(polygonArea(pts), scale)} · P ${formatLength(polygonPerimeter(pts), scale)}`,
          `${id}-a`,
          true,
        ),
      );
    }
    return <g key={id} data-testid={inProgress ? "pdf-measure-draft" : "pdf-measure-shape"} data-measure-id={id}>{out}</g>;
  };

  const scaleDraftReady = tool === "scale" && draft.length === 2;
  const rubber = hover && tool !== "none" && draft.length > 0 && !(tool === "scale" && draft.length >= 2) ? hover : null;

  const svg =
    layer && pageSize
      ? createPortal(
          <svg
            ref={svgRef}
            data-testid="pdf-measure-svg"
            data-tool={tool}
            viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              overflow: "visible",
              pointerEvents: tool === "none" ? "none" : "all",
              cursor: tool === "none" ? undefined : "crosshair",
              touchAction: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
            {measurements.map((m) => renderShape(m.points, m.kind, m.id, null, false))}
            {tool === "length" || tool === "area"
              ? renderShape(draft, tool, "draft", rubber, true)
              : null}
            {tool === "scale" && draft.length > 0 ? (
              <g data-testid="pdf-measure-scale-draft">
                {draft.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={vertexR} fill="#fff" stroke="#e8590c" strokeWidth={2 * k} />
                ))}
                {(draft.length === 2 || rubber) && (
                  <line
                    x1={draft[0].x}
                    y1={draft[0].y}
                    x2={(draft[1] ?? rubber!).x}
                    y2={(draft[1] ?? rubber!).y}
                    stroke="#e8590c"
                    strokeWidth={2 * k}
                    strokeDasharray={`${6 * k} ${4 * k}`}
                   
                  />
                )}
              </g>
            ) : null}
          </svg>,
          layer,
        )
      : null;

  const applyScale = (): void => {
    const v = Number(scaleInput);
    if (draft.length !== 2 || !(v > 0)) return;
    const s = scaleFromTwoPoints(draft[0], draft[1], toMetres(v, scaleUnit));
    if (!s || s.metresPerUnit === null) return;
    store.getState().setManualScale(key, s.metresPerUnit);
    setScaleInput("");
  };

  const toolBtn = (t: "length" | "area" | "scale", label: string): ReactNode => (
    <button
      type="button"
      data-testid={`pdf-measure-tool-${t}`}
      aria-pressed={tool === t}
      onClick={() => store.getState().setTool(tool === t ? "none" : t)}
      style={{ ...btnStyle, ...(tool === t ? btnActiveStyle : null) }}
    >
      {label}
    </button>
  );

  const hint =
    tool === "length"
      ? "Click points. Double-click or Enter to finish, Esc to cancel."
      : tool === "area"
        ? "Click polygon corners. Double-click or Enter to close, Esc to cancel."
        : tool === "scale"
          ? draft.length < 2
            ? "Click two points a known distance apart."
            : "Enter the real distance between the two points."
          : null;

  return (
    <>
      {svg}
      <div style={barStyle} data-testid="pdf-measure-bar" onPointerDown={(e) => e.stopPropagation()}>
        <div style={rowStyle}>
          {toolBtn("length", "Length")}
          {toolBtn("area", "Area")}
          {toolBtn("scale", "Set scale")}
          {measurements.length > 0 ? (
            <button
              type="button"
              data-testid="pdf-measure-clear"
              style={btnStyle}
              onClick={() => store.getState().clearPage(key)}
            >
              Clear all
            </button>
          ) : null}
          <span
            data-testid="pdf-measure-scale-badge"
            data-scale-source={scale.source}
            style={{ ...badgeStyle, ...(scale.source === "none" ? badgeWarnStyle : null) }}
            title={
              scale.metresPerUnit === null
                ? "No calibration for this page: values are in PDF points. Use Set scale."
                : `${(scale.metresPerUnit * 1000).toFixed(3)} mm per PDF point`
            }
          >
            {scaleBadgeText(scale)}
          </span>
          {scale.source === "manual" ? (
            <button
              type="button"
              data-testid="pdf-measure-scale-reset"
              style={btnStyle}
              onClick={() => store.getState().setManualScale(key, null)}
            >
              Reset scale
            </button>
          ) : null}
        </div>
        {hint ? <div style={hintStyle}>{hint}</div> : null}
        {scaleDraftReady ? (
          <div style={rowStyle} data-testid="pdf-measure-scale-form">
            <input
              data-testid="pdf-measure-scale-input"
              type="number"
              min="0"
              step="any"
              autoFocus
              value={scaleInput}
              onChange={(e) => setScaleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyScale();
              }}
              style={{ ...btnStyle, width: 90 }}
              placeholder="distance"
            />
            <select
              value={scaleUnit}
              onChange={(e) => setScaleUnit(e.target.value as LengthUnit)}
              style={btnStyle}
              aria-label="Unit"
            >
              {(["m", "cm", "mm", "ft", "in"] as LengthUnit[]).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <button type="button" data-testid="pdf-measure-scale-apply" style={btnStyle} onClick={applyScale}>
              Apply
            </button>
          </div>
        ) : null}
        {measurements.length > 0 ? (
          <ul style={listStyle} data-testid="pdf-measure-list">
            {measurements.map((m) => (
              <li key={m.id} style={liStyle} data-testid="pdf-measure-item">
                <span>{summarize(m, scale)}</span>
                <button
                  type="button"
                  aria-label="Delete measurement"
                  data-testid="pdf-measure-delete"
                  style={{ ...btnStyle, padding: "0 6px" }}
                  onClick={() => store.getState().remove(key, m.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

function summarize(m: Measurement, scale: PageScale): string {
  if (m.kind === "length") return `Length ${formatLength(polylineLength(m.points), scale)}`;
  return `Area ${formatArea(polygonArea(m.points), scale)} · P ${formatLength(polygonPerimeter(m.points), scale)}`;
}

const barStyle: CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxWidth: "calc(100% - 24px)",
  padding: 8,
  borderRadius: 8,
  background: "rgba(255,255,255,0.94)",
  boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
  fontSize: 12,
  color: "#1f2933",
  pointerEvents: "auto",
};
const rowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };
const btnStyle: CSSProperties = {
  font: "inherit",
  padding: "3px 8px",
  border: "1px solid #c5ccd3",
  borderRadius: 5,
  background: "#fff",
  color: "inherit",
  cursor: "pointer",
};
const btnActiveStyle: CSSProperties = { background: "#1971c2", borderColor: "#1971c2", color: "#fff" };
const badgeStyle: CSSProperties = { padding: "2px 8px", borderRadius: 10, background: "#e7f5e9", color: "#1b6b2f" };
const badgeWarnStyle: CSSProperties = { background: "#fff3cd", color: "#8a5a00" };
const hintStyle: CSSProperties = { color: "#52606d" };
const listStyle: CSSProperties = { listStyle: "none", margin: 0, padding: 0, maxHeight: 120, overflowY: "auto" };
const liStyle: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "2px 0" };
