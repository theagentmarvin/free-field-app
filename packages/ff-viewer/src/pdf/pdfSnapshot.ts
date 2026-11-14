// src/pdf/pdfSnapshot.ts
//
// Pure math for the Day-3 PDF location snapshot: given a normalized
// uv (0..1, top-left, y-down — the PDF.js convention) over the rendered
// page and a target width, compute the source-crop rect (clamped to the
// page edges) plus the destination dimensions that scale it to target
// width. The PdfViewer owns the 2D-canvas drawing; this module stays
// DOM-free so the edge-clamping math unit-tests without a canvas.

/**
 * How much of the page the crop window covers per axis. 1/3 = a 3×
 * zoom on the tapped point, so the thumb shows surrounding context,
 * not just a single pixel.
 */
export const SNAPSHOT_CROP_FRACTION = 1 / 3;

export interface SnapshotCrop {
  /** source rect, in the same units as `srcW`/`srcH` (canvas px). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** destination size: `dw == maxWidthPx`, `dh` preserves aspect. */
  dw: number;
  dh: number;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Convert a normalized uv point + source dimensions into a clamped
 * crop window. The window is centred on the uv; when the point is
 * near an edge the window is shifted to stay inside [0, srcW/H] and
 * clamped to the source size when the page is smaller than the
 * window (tiny-page / degenerate-input safety).
 */
export function computeSnapshotCrop(
  uv: readonly [number, number],
  srcW: number,
  srcH: number,
  maxWidthPx: number,
): SnapshotCrop | null {
  const width = typeof maxWidthPx === "number" && maxWidthPx > 0 ? maxWidthPx : 400;
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return null;
  }

  const fx = clamp01(uv[0]);
  const fy = clamp01(uv[1]);
  const cx = fx * srcW;
  const cy = fy * srcH;

  const winW = Math.max(1, srcW * SNAPSHOT_CROP_FRACTION);
  const winH = Math.max(1, srcH * SNAPSHOT_CROP_FRACTION);

  // Window size can never exceed the source.
  const sw = Math.min(winW, srcW);
  const sh = Math.min(winH, srcH);

  // Centre the window on the point, then clamp into the source bounds.
  let sx = cx - sw / 2;
  let sy = cy - sh / 2;
  sx = Math.max(0, Math.min(sx, srcW - sw));
  sy = Math.max(0, Math.min(sy, srcH - sh));

  const scale = width / sw;
  const dh = Math.max(1, Math.round(sh * scale));

  return { sx, sy, sw, sh, dw: Math.round(width), dh };
}