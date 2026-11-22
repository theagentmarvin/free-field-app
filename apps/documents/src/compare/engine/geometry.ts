// Pure geometry helpers for rasterising a Base/Revision pair.

import type { RasterPage } from "../types";

/** Pixel budget per raster (about 12 MP). */
export const MAX_RASTER_PIXELS = 12_000_000;
/** Target DPI of the "auto" resolution. */
export const AUTO_DPI = 144;
/** Width difference (fraction) above which the Revision is rescaled. */
export const SIZE_MISMATCH_TOLERANCE = 0.01;
/** Height-vs-width ratio difference above which `aspectMismatch` is flagged. */
export const ASPECT_TOLERANCE = 0.02;

export interface PairGeometry {
  /** pdf.js render scale for the Base (capped to the pixel budget). */
  renderScale: number;
  /** Base raster size in px (floored so the budget is never exceeded). */
  baseWidthPx: number;
  baseHeightPx: number;
  /** Actual raster px per Base page pt. */
  scale: number;
  downscaled: boolean;
  /** Revision width scale vs Base (1 when within tolerance). */
  revisionScale: number;
  aspectMismatch: boolean;
  /** pdf.js scale the Revision is rendered at (<= the target when capped). */
  revRenderScale: number;
  /** Factor to resample the Revision render by to reach the target geometry (1 = none). */
  resampleFactor: number;
}

export function computeGeometry(
  baseW: number,
  baseH: number,
  revW: number,
  revH: number,
  dpi: number | "auto",
): PairGeometry {
  const auto = dpi === "auto";
  const requested = (auto ? AUTO_DPI : dpi) / 72;
  const cap = Math.sqrt(MAX_RASTER_PIXELS / (baseW * baseH));
  const downscaledBase = requested > cap;
  const renderScale = downscaledBase ? cap : requested;
  const baseWidthPx = Math.max(1, Math.floor(baseW * renderScale));
  const baseHeightPx = Math.max(1, Math.floor(baseH * renderScale));
  const scale = baseWidthPx / baseW;

  const wr = revW / baseW;
  const revisionScale = Math.abs(wr - 1) > SIZE_MISMATCH_TOLERANCE ? 1 / wr : 1;
  const aspectMismatch = Math.abs(revH / baseH / wr - 1) > ASPECT_TOLERANCE;
  const target = renderScale * revisionScale;
  const revCap = Math.sqrt(MAX_RASTER_PIXELS / (revW * revH));
  const revRenderScale = Math.min(target, revCap);
  return {
    renderScale,
    baseWidthPx,
    baseHeightPx,
    scale,
    // Auto picking a lower DPI is by design; flag it only when it cannot even reach 72 DPI.
    downscaled: auto ? downscaledBase && cap < 1 : downscaledBase || revRenderScale < target,
    revisionScale,
    aspectMismatch,
    revRenderScale,
    resampleFactor: target / revRenderScale,
  };
}

/** Copy `src` into a white `width` x `height` frame, top-left aligned (clipped). Returns `src` when sizes match. */
export function placeInFrame(src: RasterPage, width: number, height: number): RasterPage {
  if (src.width === width && src.height === height) return src;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const cw = Math.min(width, src.width);
  const ch = Math.min(height, src.height);
  for (let y = 0; y < ch; y++) {
    const s = y * src.width * 4;
    data.set(src.data.subarray(s, s + cw * 4), y * width * 4);
  }
  return { width, height, data };
}
