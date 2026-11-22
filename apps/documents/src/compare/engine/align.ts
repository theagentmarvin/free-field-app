// Translation-only auto-align on ink masks (pure, no DOM).
//
// Convention: the returned (dx, dy) is the offset to APPLY to the Revision
// so it lands on the Base: shiftRaster(rev, dx, dy) moves content by +dx/+dy.

import type { RasterPage } from "../types";
import { INK_LUMINANCE, toInkMap } from "./diff";

export interface AlignOptions {
  /** Search limit as a fraction of the page size (default 0.02). */
  maxShiftFraction?: number;
  /** Long side of the downsampled mask for the coarse search (default 600). */
  maxCoarseSide?: number;
  /** Ink points sampled for the full-resolution refine (default 60000). */
  maxRefinePoints?: number;
}

export interface AlignResult {
  dx: number;
  dy: number;
  /** Fraction (0..1) of sampled Revision ink that lands on Base ink at (dx, dy). */
  score: number;
}

const MIN_INK_PIXELS = 20;

function inkMask(map: Uint8Array): Uint8Array {
  const mask = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i++) mask[i] = map[i] < INK_LUMINANCE ? 1 : 0;
  return mask;
}

/** "Any ink in block" downsample (keeps thin lines alive). */
function downsampleMask(
  mask: Uint8Array,
  w: number,
  h: number,
  f: number,
): { data: Uint8Array; w: number; h: number } {
  if (f <= 1) return { data: mask, w, h };
  const dw = Math.ceil(w / f);
  const dh = Math.ceil(h / f);
  const data = new Uint8Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const drow = ((y / f) | 0) * dw;
    let dx = 0;
    let k = 0;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) data[drow + dx] = 1;
      if (++k === f) {
        k = 0;
        dx++;
      }
    }
  }
  return { data, w: dw, h: dh };
}

/** Score every shift in [sx0..sx1] x [sy0..sy1]; returns best (ties prefer small shift). */
function search(
  pts: Int32Array,
  baseMask: Uint8Array,
  w: number,
  h: number,
  sx0: number,
  sx1: number,
  sy0: number,
  sy1: number,
): { dx: number; dy: number; count: number } {
  let best = { dx: 0, dy: 0, count: -1 };
  const n = pts.length / 2;
  for (let dy = sy0; dy <= sy1; dy++) {
    for (let dx = sx0; dx <= sx1; dx++) {
      let count = 0;
      for (let i = 0; i < n; i++) {
        const x = pts[2 * i] + dx;
        const y = pts[2 * i + 1] + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && baseMask[y * w + x]) count++;
      }
      if (
        count > best.count ||
        (count === best.count && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)
      ) {
        best = { dx, dy, count };
      }
    }
  }
  return best;
}

function collect(mask: Uint8Array, w: number, h: number, maxPoints: number, knownTotal?: number): Int32Array {
  let total = knownTotal ?? 0;
  if (knownTotal === undefined) for (let i = 0; i < mask.length; i++) total += mask[i];
  const stride = Math.max(1, Math.ceil(total / maxPoints));
  const out = new Int32Array(2 * Math.ceil(total / stride) + 2);
  let n = 0;
  let k = 0;
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (mask[i] && k++ % stride === 0) {
        out[n++] = x;
        out[n++] = y;
      }
    }
  }
  return out.subarray(0, n);
}

export function estimateOffset(
  base: RasterPage,
  rev: RasterPage,
  opts: AlignOptions = {},
): AlignResult {
  if (base.width !== rev.width || base.height !== rev.height) return { dx: 0, dy: 0, score: 0 };
  return estimateOffsetFromMaps(toInkMap(base), toInkMap(rev), base.width, base.height, opts);
}

/** Same as estimateOffset, from precomputed ink maps (see toInkMap). */
export function estimateOffsetFromMaps(
  baseMap: Uint8Array,
  revMap: Uint8Array,
  w: number,
  h: number,
  opts: AlignOptions = {},
): AlignResult {
  const none: AlignResult = { dx: 0, dy: 0, score: 0 };
  const frac = opts.maxShiftFraction ?? 0.02;
  const maxSide = opts.maxCoarseSide ?? 600;
  const maxPts = opts.maxRefinePoints ?? 60000;

  const bm = inkMask(baseMap);
  const rm = inkMask(revMap);
  let bInk = 0;
  let rInk = 0;
  for (let i = 0; i < bm.length; i++) {
    bInk += bm[i];
    rInk += rm[i];
  }
  // (counts reused by collect() below)
  if (bInk < MIN_INK_PIXELS || rInk < MIN_INK_PIXELS) return none;

  const maxX = Math.max(1, Math.ceil(w * frac));
  const maxY = Math.max(1, Math.ceil(h * frac));

  // Coarse: exhaustive on the downsampled masks.
  const f = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const cb = downsampleMask(bm, w, h, f);
  const cr = downsampleMask(rm, w, h, f);
  const cpts = collect(cr.data, cr.w, cr.h, 30000);
  const cmx = Math.ceil(maxX / f);
  const cmy = Math.ceil(maxY / f);
  const coarse = search(cpts, cb.data, cb.w, cb.h, -cmx, cmx, -cmy, cmy);

  // Refine: full resolution, window of +-(f+1) around the coarse estimate.
  const pts = collect(rm, w, h, maxPts, rInk);
  const cx = coarse.dx * f;
  const cy = coarse.dy * f;
  const fine = search(
    pts,
    bm,
    w,
    h,
    Math.max(-maxX - f, cx - f - 1),
    Math.min(maxX + f, cx + f + 1),
    Math.max(-maxY - f, cy - f - 1),
    Math.min(maxY + f, cy + f + 1),
  );
  const n = pts.length / 2;
  const zero = search(pts, bm, w, h, 0, 0, 0, 0).count;
  // Not a clear improvement over "no shift": keep the pages as they are.
  if (fine.count - zero < Math.max(2, 0.005 * n)) {
    return { dx: 0, dy: 0, score: zero / n };
  }
  return { dx: fine.dx, dy: fine.dy, score: fine.count / n };
}

/** Move content by (+dx, +dy); uncovered area is white. */
export function shiftRaster(page: RasterPage, dx: number, dy: number): RasterPage {
  const { width: w, height: h } = page;
  const out = new Uint8ClampedArray(page.data.length).fill(255);
  const sx0 = Math.max(0, -dx);
  const sx1 = Math.min(w, w - dx);
  if (sx1 > sx0) {
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy;
      if (ty < 0 || ty >= h) continue;
      const src = (sy * w + sx0) * 4;
      const dst = (ty * w + sx0 + dx) * 4;
      out.set(page.data.subarray(src, src + (sx1 - sx0) * 4), dst);
    }
  }
  return { width: w, height: h, data: out };
}

/** Like shiftRaster for a single-channel map (uncovered area = 255, blank). */
export function shiftMap(map: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(map.length).fill(255);
  const sx0 = Math.max(0, -dx);
  const sx1 = Math.min(w, w - dx);
  if (sx1 > sx0) {
    for (let sy = 0; sy < h; sy++) {
      const ty = sy + dy;
      if (ty < 0 || ty >= h) continue;
      const src = sy * w + sx0;
      out.set(map.subarray(src, src + (sx1 - sx0)), ty * w + sx0 + dx);
    }
  }
  return out;
}
