import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  pinCanvasPx,
  type PdfPageSize,
  type PdfPinSurface,
} from "./pdfPins";

/**
 * 2D tap-to-create + marker (Wave 5B) — the documents-module twin of
 * <TapCreateMarker3D>. Portaled into the viewer's annotation layer
 * (same surface-resolution protocol as <TaskCalloutLayer2D>) so the +
 * button inherits the plan's display zoom for free. Pure of Firebase:
 * the dock owns the calibration lookup + compose sheet and hands this
 * component only the resolved marker uv + a create callback.
 */

export interface TapCreateMarker2DProps {
  getSurface: () => PdfPinSurface | null;
  pageSize: PdfPageSize;
  /** normalized 0..1 uv of the pending tap; null hides the marker */
  markerUv: [number, number] | null;
  /** the + button was tapped → the host opens compose with `{pdf:...}` */
  onMarkerTap: () => void;
}

interface View {
  layer: HTMLElement | null;
  scale: number;
}

export function TapCreateMarker2D({
  getSurface,
  pageSize,
  markerUv,
  onMarkerTap,
}: TapCreateMarker2DProps): JSX.Element | null {
  const [view, setView] = useState<View>({ layer: null, scale: 1 });

  // Surface-resolution loop — the MappingView lesson (Task 15b) the
  // same three guards TaskCalloutLayer2D uses: attach only once
  // getAnnotationLayer() returns a node, gate first paint on onReady,
  // and re-derive renderScale from the layer's own CSS width (page
  // points × scale set once per scale change — the portal inherits
  // the zoom, so no rAF, no rect math).
  const getSurfaceRef = useRef(getSurface);
  getSurfaceRef.current = getSurface;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  useEffect(() => {
    let cancelled = false;
    let attached: PdfPinSurface | null = null;
    let unsubScale: (() => void) | null = null;
    let sync: (() => void) | null = null;

    const attach = (surface: PdfPinSurface): void => {
      attached = surface;
      let ready = false;
      sync = (): void => {
        if (cancelled || !ready) return;
        const layer = surface.getAnnotationLayer();
        const cssW = layer ? parseFloat(layer.style.width) : NaN;
        const size = pageSizeRef.current;
        const derived =
          Number.isFinite(cssW) && cssW > 0 && size.width > 0
            ? cssW / size.width
            : undefined;
        setView((v) => {
          const scale = derived ?? v.scale;
          return v.layer === layer && v.scale === scale
            ? v
            : { layer, scale };
        });
      };
      surface.onReady(() => {
        ready = true;
        sync?.();
      });
      unsubScale?.();
      unsubScale = surface.setOnScaleChange((e) => {
        setView((v) => (v.scale === e.renderScale ? v : { ...v, scale: e.renderScale }));
        sync?.();
      });
    };

    const tick = (): void => {
      if (cancelled) return;
      const surface = getSurfaceRef.current();
      if (!surface) return;
      if (surface === attached) {
        sync?.();
        return;
      }
      if (!surface.getAnnotationLayer()) return; // viewer not built yet
      attach(surface);
      sync?.();
    };

    tick();
    const t = setInterval(tick, 250);
    return () => {
      cancelled = true;
      clearInterval(t);
      unsubScale?.();
    };
  }, []);

  if (!view.layer || !markerUv) return null;
  const { x, y } = pinCanvasPx({ uv: markerUv }, pageSize, view.scale);

  return createPortal(
    <button
      type="button"
      className="ff-task-create-marker"
      aria-label="Add task here"
      onClick={onMarkerTap}
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        pointerEvents: "auto",
        width: 32,
        height: 32,
        borderRadius: "50%",
        border: "none",
        background: "#1a73e8",
        color: "#fff",
        fontSize: 20,
        lineHeight: 1,
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
        zIndex: 5,
      }}
    >
      +
    </button>,
    view.layer,
  );
}