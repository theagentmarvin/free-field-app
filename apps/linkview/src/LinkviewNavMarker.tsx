// apps/linkview/src/LinkviewNavMarker.tsx
//
// Wave 57/58 — the "you are here" nav marker, portaled into the PDF
// viewer's annotation layer (the exact wizard pattern from
// apps/settings/src/calibration/MappingView.tsx). Being a child of
// `.pv-zoom-transform`, the marker tracks pan/zoom for free; its
// canvas-local CSS-pixel position is `pdfPos × renderScale` (the
// RENDER scale, not total scale — see `markerCssPosition`).
//
// Wave 58 — the glyph is the pre-wave-52 Google-Maps-style "blue dot
// with bearing": a translucent halo ring behind a solid blue dot, and
// a ~30° directional cone that fans out in the camera bearing
// direction. Bearing (radians, PDF PAGE angle) is passed in by
// <LinkviewApp>: the live camera look azimuth converted with
// `pdfBearingFromWorld` (world bearing − calibration rotation).
//
// Draggable: pointer-down/move on the glyph converts the client point
// to PDF page coords via the annotation layer's visual rect + the
// viewer's `getTotalScale()` and forwards it to `onDragMove`. The
// marker keeps its own local "is dragging" state for pointer capture;
// the AUTHORITATIVE one-source-of-truth flag lives in the parent
// (`LinkviewApp`), which this component only mirrors via
// `onDragStart` / `onDragEnd`.

import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { PdfOverlayHandle } from "@ff/viewer-react";
// Subpath import: the @ff/tasks-react barrel pulls the Firebase chain.
import { useAnnotationLayer } from "@ff/tasks-react/useAnnotationLayer";

import {
  markerCssPosition,
  pageCoordsFromClientRect,
  type PdfPoint,
} from "./linkviewNav";

// Distinct from the wizard's red pick markers (#dc2626). The blue
// #2563eb family keeps the nav marker unmistakable as "you are here".
const NAV_MARKER_COLOR = "#2563eb";
const NAV_MARKER_HALO_FILL = "rgba(37, 99, 235, 0.18)";
const NAV_MARKER_HALO_STROKE = "rgba(37, 99, 235, 0.45)";
const NAV_MARKER_CONE_FILL = "rgba(37, 99, 235, 0.55)";

// Ported from the recovered LinkviewNavigationSymbol constants.
const SYMBOL_PX = 36;
const DOT_RADIUS = 5;
const HALO_RADIUS = 14;
const CONE_LENGTH = 14;
const CONE_HALF_WIDTH = 5;

export interface LinkviewNavMarkerProps {
  /** Imperative handle to the left-pane <PdfOverlay>. */
  pdfOverlayRef: RefObject<PdfOverlayHandle>;
  /** Current marker position in PDF page coords. */
  pdfPos: PdfPoint;
  /** Bearing (radians) the directional cone should point, as a PDF
   *  page angle (atan2(dy, dx) in y-down page coords) — NOT the world
   *  bearing; see `pdfBearingFromWorld`. */
  bearing: number;
  /** PDF page width in points (derives the render scale from the
   *  annotation layer's CSS width). Optional: falls back to the
   *  viewer's scale events. */
  pageWidth?: number;
  /** Fired on pointer-down (flips the parent's dragging flag). */
  onDragStart: () => void;
  /** Fired on drag movement with the new PDF page coords. */
  onDragMove: (pdfPos: PdfPoint) => void;
  /** Fired on pointer-up / cancel (clears the parent's dragging flag). */
  onDragEnd: () => void;
}

export default function LinkviewNavMarker({
  pdfOverlayRef,
  pdfPos,
  bearing,
  pageWidth,
  onDragStart,
  onDragMove,
  onDragEnd,
}: LinkviewNavMarkerProps): ReactNode {
  // Portal target + RENDER scale, from the overlay HANDLE (shared
  // resolver with the Documents task pins). The handle is re-read on
  // every tick, so a PDF switch moves the marker onto the new viewer's
  // live layer; a global `document.querySelector` could pick a stale
  // or foreign layer (two PDF viewers mounted at once).
  const { layer: annotationLayer, scale: renderScale } = useAnnotationLayer(
    () => pdfOverlayRef.current,
    pageWidth,
  );
  // Local drag state for pointer capture; mirrors the parent's flag.
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      onDragStart();
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [onDragStart],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!draggingRef.current) return;
      const handle = pdfOverlayRef.current;
      const layer = handle?.getAnnotationLayer() ?? null;
      if (!handle || !layer) return;
      const pdf = pageCoordsFromClientRect(
        layer.getBoundingClientRect(),
        handle.getTotalScale(),
        e.clientX,
        e.clientY,
      );
      if (pdf) onDragMove(pdf);
    },
    [pdfOverlayRef, onDragMove],
  );

  const finishDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      onDragEnd();
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    },
    [onDragEnd],
  );

  // Wave 58 — the marker is now the blue-dot-and-halo glyph, not a
  // plain dot. Stop the click from bubbling to the PdfOverlay's
  // click-to-place handler (otherwise a marker tap would re-place the
  // marker onto itself, and a drag-release would double-fire).
  const handleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
  }, []);

  if (!annotationLayer) return null;

  const pos = markerCssPosition(pdfPos, renderScale);
  const bearingDeg = (bearing * 180) / Math.PI;
  const cx = SYMBOL_PX / 2;
  const cy = SYMBOL_PX / 2;

  return createPortal(
    <div
      data-testid="linkview-nav-marker"
      data-pdf-x={pdfPos.x}
      data-pdf-y={pdfPos.y}
      data-bearing-deg={bearingDeg.toFixed(2)}
      role="button"
      aria-label="You are here — drag to move the navigation point"
      title="You are here"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={handleClick}
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        width: SYMBOL_PX,
        height: SYMBOL_PX,
        marginLeft: -SYMBOL_PX / 2,
        marginTop: -SYMBOL_PX / 2,
        cursor: "grab",
        pointerEvents: "auto",
        zIndex: 20,
        touchAction: "none",
      }}
    >
      <svg
        width={SYMBOL_PX}
        height={SYMBOL_PX}
        viewBox={`0 0 ${SYMBOL_PX} ${SYMBOL_PX}`}
        style={{ display: "block" }}
        aria-hidden="true"
      >
        {/* Translucent accuracy halo. Sits behind the dot and cone. */}
        <circle
          cx={cx}
          cy={cy}
          r={HALO_RADIUS}
          fill={NAV_MARKER_HALO_FILL}
          stroke={NAV_MARKER_HALO_STROKE}
          strokeWidth={1}
        />
        {/* Solid dot. White border lifts it off the halo for contrast
            against the PDF/plan background. */}
        <circle
          cx={cx}
          cy={cy}
          r={DOT_RADIUS}
          fill={NAV_MARKER_COLOR}
          stroke="#ffffff"
          strokeWidth={1.5}
        />
        {/* Directional cone. Tip points in +X (right), rotated by the
            page bearing. SVG rotate is clockwise on the y-down page,
            i.e. the same angle as atan2(dy, dx) in page coords. */}
        <g transform={`translate(${cx} ${cy}) rotate(${bearingDeg})`}>
          <polygon
            points={`${CONE_LENGTH},0 ${-CONE_HALF_WIDTH},${-CONE_HALF_WIDTH} ${-CONE_HALF_WIDTH},${CONE_HALF_WIDTH}`}
            fill={NAV_MARKER_CONE_FILL}
            stroke="#ffffff"
            strokeWidth={1}
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </div>,
    annotationLayer,
  );
}