import { useEffect, useRef, useState } from "react";

/**
 * Shared resolver for a PDF viewer's annotation layer (the portal node
 * inside `.pv-zoom-transform`). Used by the Documents task pins
 * (<TaskCalloutLayer2D>) and the LinkView nav marker.
 *
 * Structural on purpose: it only needs the four handle methods below,
 * so this file never imports the viewer package. It also imports
 * nothing else, so apps that must not pull this package's barrel (the
 * Firebase chain) can import it through the `./useAnnotationLayer`
 * subpath export.
 *
 * The viewer is built asynchronously, so a plain effect fires too
 * early. The loop has three guards (the Task 15b lessons):
 *   1. Attach only once `getAnnotationLayer()` returns a node. Before
 *      that, `onReady` drops the callback silently.
 *   2. Report a layer only after `onReady`, so a portal never flashes
 *      in before the first render settles.
 *   3. Derive renderScale from the layer's own CSS width when the page
 *      width is known (the layer is pagePoints × renderScale wide), so
 *      attaching after the first scale event still gets the scale.
 *
 * The same tick re-reads the layer from the handle every time, so a
 * viewer that rebuilds its DOM (a new PDF in the same overlay, or a
 * remounted overlay behind the same ref) moves the portal to the live
 * node instead of a detached one.
 */
export interface AnnotationLayerSurface {
  getAnnotationLayer(): HTMLElement | null;
  getCurrentPage?(): number;
  onReady(cb: () => void): void;
  setOnScaleChange(cb: (e: { renderScale: number }) => void): () => void;
}

export interface AnnotationLayerView {
  /** Live annotation layer, or null until the viewer is ready. */
  layer: HTMLElement | null;
  /** Current page (1-based); 1 when the surface has no page API. */
  page: number;
  /** Render scale (CSS px per PDF point inside the zoom transform). */
  scale: number;
}

/** Poll period (ms) for surface changes and page flips. */
export const ANNOTATION_LAYER_POLL_MS = 250;

export function useAnnotationLayer(
  getSurface: () => AnnotationLayerSurface | null,
  pageWidth?: number,
): AnnotationLayerView {
  const [view, setView] = useState<AnnotationLayerView>({
    layer: null,
    page: 1,
    scale: 1,
  });

  // Refs so an inline `() => ref.current` prop (new identity every
  // render) never tears the loop down.
  const getSurfaceRef = useRef(getSurface);
  getSurfaceRef.current = getSurface;
  const pageWidthRef = useRef(pageWidth);
  pageWidthRef.current = pageWidth;

  useEffect(() => {
    let cancelled = false;
    let attached: AnnotationLayerSurface | null = null;
    let unsubScale: (() => void) | null = null;
    let sync: (() => void) | null = null;

    const attach = (surface: AnnotationLayerSurface): void => {
      attached = surface;
      let ready = false;
      sync = () => {
        if (cancelled || !ready) return;
        const layer = surface.getAnnotationLayer();
        const page = surface.getCurrentPage?.() ?? 1;
        const cssW = layer ? parseFloat(layer.style.width) : NaN;
        const width = pageWidthRef.current ?? 0;
        const derived =
          Number.isFinite(cssW) && cssW > 0 && width > 0 ? cssW / width : undefined;
        setView((v) => {
          const scale = derived ?? v.scale;
          return v.layer === layer && v.page === page && v.scale === scale
            ? v
            : { layer, page, scale };
        });
      };
      surface.onReady(() => {
        ready = true;
        sync?.();
      });
      unsubScale?.();
      unsubScale = surface.setOnScaleChange((e) => {
        // The event value is the fallback for hosts without an inline
        // width; the re-sync below prefers the node-derived scale.
        setView((v) =>
          v.scale === e.renderScale ? v : { ...v, scale: e.renderScale },
        );
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
    const t = setInterval(tick, ANNOTATION_LAYER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
      unsubScale?.();
    };
  }, []);

  return view;
}
