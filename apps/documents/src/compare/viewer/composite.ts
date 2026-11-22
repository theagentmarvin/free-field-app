// apps/documents/src/compare/viewer/composite.ts
//
// Pure raster helpers for the overlay mode. Single pass over `classes`.

import type { ChangeRegion, CompareResult, RasterPage } from "../types";
import type { OverlayColors } from "../compareStore";
import { cloudPath } from "../cloudPath";

export interface OverlayOptions {
  showBase: boolean;
  showRevision: boolean;
  baseOpacity: number;
  revisionOpacity: number;
  colors: OverlayColors;
}

export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Class 2 (Base only) -> base colour, 3 (Revision only) -> revision colour,
 * 1 (both) -> shared ink, 0 -> white. Layer toggles / opacity blend over white.
 */
export function compositeOverlay(
  classes: Uint8Array,
  width: number,
  height: number,
  o: OverlayOptions,
  reuse?: Uint8ClampedArray | null,
): Uint8ClampedArray {
  // `reuse` lets the viewer keep one buffer across slider changes (every pixel is rewritten).
  const out = reuse && reuse.length === width * height * 4 ? reuse : new Uint8ClampedArray(width * height * 4);
  const base = parseHex(o.colors.base);
  const rev = parseHex(o.colors.revision);
  const shared = parseHex(o.colors.shared);
  const sharedAlpha = Math.max(o.showBase ? o.baseOpacity : 0, o.showRevision ? o.revisionOpacity : 0);
  const baseAlpha = o.showBase ? o.baseOpacity : 0;
  const revAlpha = o.showRevision ? o.revisionOpacity : 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const c = classes[i];
    let rgb: [number, number, number] | null = null;
    let a = 0;
    if (c === 1) {
      rgb = shared;
      a = sharedAlpha;
    } else if (c === 2) {
      rgb = base;
      a = baseAlpha;
    } else if (c === 3) {
      rgb = rev;
      a = revAlpha;
    }
    const p = i * 4;
    if (rgb && a > 0) {
      out[p] = 255 + (rgb[0] - 255) * a;
      out[p + 1] = 255 + (rgb[1] - 255) * a;
      out[p + 2] = 255 + (rgb[2] - 255) * a;
    } else {
      out[p] = out[p + 1] = out[p + 2] = 255;
    }
    out[p + 3] = 255;
  }
  return out;
}

export const KIND_COLOR: Record<ChangeRegion["kind"], string> = {
  added: "#3b82f6",
  removed: "#e5484d",
  modified: "#f59e0b",
};

/** Region box in raster px. */
export function regionPx(r: ChangeRegion, scale: number) {
  return { x: r.bbox.x * scale, y: r.bbox.y * scale, w: r.bbox.w * scale, h: r.bbox.h * scale };
}

export function cloudArcFor(w: number, h: number): number {
  return Math.min(24, Math.max(6, Math.min(w, h) / 4));
}

export function paintRaster(canvas: HTMLCanvasElement, w: number, h: number, data: Uint8ClampedArray): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ImageData === "undefined") return;
  // Assigning width/height reallocates the backing store, so only do it on a size change.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.putImageData(new ImageData(data as unknown as ConstructorParameters<typeof ImageData>[0], w, h), 0, 0);
}

/** Free a canvas's backing store right away instead of waiting for GC. */
export function releaseCanvas(c: HTMLCanvasElement | null | undefined): void {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

function rasterCanvas(page: RasterPage | { width: number; height: number; data: Uint8ClampedArray }) {
  const c = document.createElement("canvas");
  paintRaster(c, page.width, page.height, page.data);
  return c;
}

function drawRegions(
  ctx: CanvasRenderingContext2D,
  result: CompareResult,
  style: "cloud" | "box",
  selectedId: number | null,
  dx: number,
): void {
  for (const r of result.regions) {
    const b = regionPx(r, result.scale);
    ctx.save();
    ctx.translate(dx, 0);
    ctx.strokeStyle = KIND_COLOR[r.kind];
    ctx.lineWidth = r.id === selectedId ? 4 : 2;
    if (r.id === selectedId) {
      ctx.fillStyle = KIND_COLOR[r.kind] + "33";
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (style === "cloud" && typeof Path2D !== "undefined") {
      ctx.stroke(new Path2D(cloudPath(b.x, b.y, b.w, b.h, cloudArcFor(b.w, b.h))));
    } else {
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }
}

export interface ExportOptions {
  mode: "side-by-side" | "overlay" | "changes";
  overlay: OverlayOptions;
  style: "cloud" | "box";
  selectedId: number | null;
}

/** Render the current comparison to an offscreen canvas (null without 2d support). */
export function renderExportCanvas(result: CompareResult, o: ExportOptions): HTMLCanvasElement | null {
  const { width, height } = result;
  const out = document.createElement("canvas");
  const gap = o.mode === "side-by-side" ? 16 : 0;
  out.width = o.mode === "side-by-side" ? width * 2 + gap : width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  if (o.mode === "overlay") {
    const tmp = rasterCanvas({ width, height, data: compositeOverlay(result.classes, width, height, o.overlay) });
    ctx.drawImage(tmp, 0, 0);
    releaseCanvas(tmp);
  } else if (o.mode === "changes") {
    ctx.globalAlpha = 0.35;
    const tmp = rasterCanvas(result.revision);
    ctx.drawImage(tmp, 0, 0);
    releaseCanvas(tmp);
    ctx.globalAlpha = 1;
    drawRegions(ctx, result, o.style, o.selectedId, 0);
  } else {
    const b = rasterCanvas(result.base);
    ctx.drawImage(b, 0, 0);
    releaseCanvas(b);
    const r = rasterCanvas(result.revision);
    ctx.drawImage(r, width + gap, 0);
    releaseCanvas(r);
    drawRegions(ctx, result, o.style, o.selectedId, 0);
    drawRegions(ctx, result, o.style, o.selectedId, width + gap);
  }
  return out;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
