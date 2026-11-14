// packages/ff-viewer-react/src/measure/labelLayer.ts
//
// Wave 67: the CSS2D layer behind the 3D measurement tools.
//
// ROOT CAUSE this module exists for: the OBCF measurement components draw
// their value labels, line endpoints and the snap marker as CSS2DObjects
// (`Mark`), which only show up when the world's renderer owns a
// CSS2DRenderer (`OBCF.RendererWith2D.three2D`). The viewer used a plain
// `OBC.SimpleRenderer`, so every one of those objects sat in the scene
// graph but was never put on screen: only the bare 1 px line was visible.
//
// `RendererWith2D` renders the CSS2D layer after EVERY main render, and
// `CSS2DRenderer.render` walks the whole scene graph (tens of thousands of
// tile meshes on a federated model). Most of the time there is nothing to
// show, so `gateLabelLayer` wraps that call: it only runs while the layer
// is needed, plus ONE closing pass when it stops being needed (so stale
// label elements are removed / hidden).

/** Structural view of `RendererWith2D.three2D` (a `CSS2DRenderer`). */
export interface LabelLayerRenderer {
  render: (scene: unknown, camera: unknown) => void;
  domElement?: { classList?: { add: (c: string) => void } } | null;
}

/** CSS class put on the CSS2D layer root (styles in `measureStyles.ts`). */
export const MEASURE_LAYER_CLASS = "ff-measure-layer";

export interface LabelLayerGate {
  /** Number of render passes actually forwarded to the CSS2DRenderer. */
  readonly passes: () => number;
  /** Restore the renderer's original `render`. */
  dispose: () => void;
}

/**
 * Wrap `layer.render` so it only runs while `needed()` is true, plus one
 * closing pass after the last needed one.
 */
export function gateLabelLayer(
  layer: LabelLayerRenderer,
  needed: () => boolean,
): LabelLayerGate {
  const original = layer.render.bind(layer);
  const restore = layer.render;
  let wasActive = false;
  let passes = 0;
  layer.render = (scene, camera) => {
    let active = false;
    try {
      active = needed();
    } catch {
      active = true; // fail towards drawing
    }
    if (active || wasActive) {
      passes += 1;
      original(scene, camera);
    }
    wasActive = active;
  };
  try {
    layer.domElement?.classList?.add(MEASURE_LAYER_CLASS);
    ensureMeasureStyles();
  } catch {
    // no DOM (tests)
  }
  return {
    passes: () => passes,
    dispose: () => {
      layer.render = restore;
    },
  };
}

/** Minimal measurement-component view for the "is the layer needed" check. */
export interface LayerComponentLike {
  enabled?: boolean;
  list?: { size?: number } | undefined;
}

/**
 * The CSS2D layer is needed while any measurement component is armed
 * (snap marker + live preview) or still holds a measurement.
 */
export function isMeasureLayerNeeded(
  components: Iterable<LayerComponentLike>,
): boolean {
  for (const c of components) {
    if (c.enabled === true) return true;
    if ((c.list?.size ?? 0) > 0) return true;
  }
  return false;
}

/** Class marking the label of the measurement the list is pointing at. */
export const MEASURE_ACTIVE_CLASS = "ff-measure-active";

const STYLE_ID = "ff-measure-layer-styles";

/**
 * Scoped styling for the CSS2D measurement layer. The OBCF elements carry
 * only inline styles (no classes), so the rules key off the layer class
 * and their distinctive inline values. `!important` is needed to beat the
 * inline declarations.
 */
export const MEASURE_LAYER_CSS = `
.${MEASURE_LAYER_CLASS} { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.${MEASURE_LAYER_CLASS} > div[style*="padding: 6px"] {
  padding: 3px 9px !important; border-radius: 999px !important;
  font-size: 12px; font-weight: 700; line-height: 1.3; white-space: nowrap;
  font-variant-numeric: tabular-nums; border: 2px solid #fff;
  box-shadow: 0 1px 5px rgba(0,0,0,.45) !important; user-select: none;
}
.${MEASURE_LAYER_CLASS} > div[style*="border-radius: 50%"][style*="height: 4px"] {
  width: 7px !important; height: 7px !important; box-sizing: content-box;
  box-shadow: 0 0 0 1px rgba(255,255,255,.9), 0 1px 3px rgba(0,0,0,.5);
}
/* 2D level-plan measure tool (marks created by IfcViewer's plan label factory) */
.${MEASURE_LAYER_CLASS} > .ff-m2d-label {
  padding: 3px 9px; border-radius: 999px; background: #e8590c; color: #fff;
  font-size: 12px; font-weight: 700; line-height: 1.3; white-space: nowrap;
  font-variant-numeric: tabular-nums; border: 2px solid #fff;
  box-shadow: 0 1px 5px rgba(0,0,0,.45);
}
.${MEASURE_LAYER_CLASS} > .ff-m2d-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #fff; border: 2px solid #e8590c;
  box-sizing: content-box; box-shadow: 0 0 0 1px rgba(255,255,255,.9), 0 1px 3px rgba(0,0,0,.5);
}
.${MEASURE_LAYER_CLASS} > div.${MEASURE_ACTIVE_CLASS} {
  outline: 3px solid #fab005; outline-offset: 1px; background-color: #e67700 !important;
}
`;

/** Inject the layer stylesheet once per document (no-op without a DOM). */
export function ensureMeasureStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = MEASURE_LAYER_CSS;
  doc.head.appendChild(el);
}
