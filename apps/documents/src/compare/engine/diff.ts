// Pure raster diff: per-pixel classification + change-region grouping.
// No DOM; operates on RasterPage / typed arrays only.

import type {
  ChangeKind,
  ChangeRegion,
  DiffThresholds,
  RasterPage,
} from "../types";

/** Ink strength below this counts as ink (drawn content). */
export const INK_LUMINANCE = 200;

/** Channel spread (max - min) at or above this counts as ink (coloured markup). */
export const INK_CHROMA = 60;

/** Fraction of agreeing pixels for a region to be "added" / "removed". */
export const KIND_AGREEMENT = 0.8;

/** Rec. 601 luminance, with the pixel composited over white. */
export function luminance(r: number, g: number, b: number, a = 255): number {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  if (a >= 255) return l;
  const k = a / 255;
  return l * k + 255 * (1 - k);
}

/** Luminance map (0..255) of an RGBA raster, transparent treated as white. */
export function toLuminanceMap(page: RasterPage): Uint8Array {
  const n = page.width * page.height;
  const out = new Uint8Array(n);
  const d = page.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = Math.round(luminance(d[p], d[p + 1], d[p + 2], d[p + 3]));
  }
  return out;
}

/**
 * "Ink strength" map (0..255, lower = stronger ink). Equals the luminance,
 * except that strongly coloured pixels (chroma >= INK_CHROMA) are pulled
 * towards dark so coloured markups and highlights count as ink. Transparent
 * pixels are composited over white first.
 */
export function toInkMap(page: RasterPage): Uint8Array {
  const n = page.width * page.height;
  const out = new Uint8Array(n);
  const d = page.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let r = d[p];
    let g = d[p + 1];
    let b = d[p + 2];
    const a = d[p + 3];
    if (a < 255) {
      const k = a / 255;
      r = r * k + 255 * (1 - k);
      g = g * k + 255 * (1 - k);
      b = b * k + 255 * (1 - k);
    }
    let v = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma >= INK_CHROMA) v = Math.min(v, 255 - chroma);
    out[i] = Math.round(v);
  }
  return out;
}

/**
 * Square-window minimum (radius r) via two separable passes, with a single
 * output buffer (the vertical pass runs in place through a column scratch).
 * r <= 0 returns `src` itself (not copied).
 */
export function windowMin(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  if (r <= 0) return src;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      let m = 255;
      for (let k = x0; k <= x1; k++) {
        const v = src[row + k];
        if (v < m) m = v;
      }
      out[row + x] = m;
    }
  }
  const col = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = out[y * width + x];
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      let m = 255;
      for (let k = y0; k <= y1; k++) {
        if (col[k] < m) m = col[k];
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

export interface ClassifyResult {
  /** 0 = same/blank, 1 = ink in both, 2 = removed (Base only), 3 = added (Revision only). */
  classes: Uint8Array;
  added: number;
  removed: number;
}

/** Classify from precomputed ink maps (see toInkMap). */
export function classifyMaps(
  lb: Uint8Array,
  lr: Uint8Array,
  width: number,
  height: number,
  thresholds: DiffThresholds,
): ClassifyResult {
  const r = Math.max(0, Math.round(thresholds.proximityPx));
  const ct = thresholds.colorThreshold;
  const classes = new Uint8Array(width * height);
  let added = 0;
  let removed = 0;
  // A one-sided ink pixel counts only when no pixel within `r` on the other side is
  // similarly strong, i.e. every neighbour is weaker than (own + ct). The window is
  // scanned lazily (only for the rare one-sided pixels, with an early exit) instead of
  // building two full-page window-minimum maps.
  const weakerAround = (other: Uint8Array, x: number, y: number, own: number): boolean => {
    const limit = own + ct; // a neighbour <= limit is "similarly strong"
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    const x0 = x - r < 0 ? 0 : x - r;
    const x1 = x + r >= width ? width - 1 : x + r;
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * width;
      for (let xx = x0; xx <= x1; xx++) if (other[row + xx] <= limit) return false;
    }
    return true;
  };
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = lb[i];
      const v = lr[i];
      const inkB = b < INK_LUMINANCE;
      const inkR = v < INK_LUMINANCE;
      if (inkB === inkR) {
        if (inkB) classes[i] = 1;
      } else if (inkB) {
        if (weakerAround(lr, x, y, b)) {
          classes[i] = 2;
          removed++;
        }
      } else if (weakerAround(lb, x, y, v)) {
        classes[i] = 3;
        added++;
      }
    }
  }
  return { classes, added, removed };
}

/**
 * Classify every pixel. A pixel is a difference when one side has ink, the
 * other does not, and the strength gap exceeds `colorThreshold`. With
 * `proximityPx > 0`, the inked pixel only counts when no pixel within that
 * radius on the other side is similarly strong (tolerates 1 px shifts and
 * anti-aliasing).
 */
export function classifyPixels(
  base: RasterPage,
  rev: RasterPage,
  thresholds: DiffThresholds,
): ClassifyResult {
  if (base.width !== rev.width || base.height !== rev.height) {
    throw new Error("classifyPixels: raster sizes differ");
  }
  return classifyMaps(toInkMap(base), toInkMap(rev), base.width, base.height, thresholds);
}

interface RawRegion {
  /** Padded box in raster px, [x0, x1) x [y0, y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  added: number;
  removed: number;
}

/** Group diff pixels into padded, merged change regions (bbox in page pt). */
export function findRegions(
  classes: Uint8Array,
  width: number,
  height: number,
  thresholds: DiffThresholds,
  scale: number,
): ChangeRegion[] {
  const gs = Math.max(1, Math.round(thresholds.gridSize));
  const gw = Math.ceil(width / gs);
  const gh = Math.ceil(height / gs);
  const cells = gw * gh;
  const addedC = new Uint32Array(cells);
  const removedC = new Uint32Array(cells);
  const m = Math.max(0, Math.round(thresholds.marginPx));
  for (let y = m; y < height - m; y++) {
    const row = y * width;
    const crow = Math.floor(y / gs) * gw;
    for (let x = m; x < width - m; x++) {
      const c = classes[row + x];
      if (c < 2) continue;
      const ci = crow + Math.floor(x / gs);
      if (c === 2) removedC[ci]++;
      else addedC[ci]++;
    }
  }
  const flagged = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const t = addedC[i] + removedC[i];
    if (t > 0 && t >= thresholds.minPixelsPerCell) flagged[i] = 1;
  }

  // Pass 1: connected components (cells within `reach` of each other).
  const reach = Math.max(1, Math.round(thresholds.mergeDistance));
  const seen = new Uint8Array(cells);
  let raw: RawRegion[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cells; start++) {
    if (!flagged[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    let a = 0;
    let rm = 0;
    while (stack.length) {
      const ci = stack.pop() as number;
      const cx = ci % gw;
      const cy = (ci - cx) / gw;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      a += addedC[ci];
      rm += removedC[ci];
      const ya = Math.max(0, cy - reach);
      const yb = Math.min(gh - 1, cy + reach);
      const xa = Math.max(0, cx - reach);
      const xb = Math.min(gw - 1, cx + reach);
      for (let ny = ya; ny <= yb; ny++) {
        for (let nx = xa; nx <= xb; nx++) {
          const ni = ny * gw + nx;
          if (flagged[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    raw.push({
      x0: Math.max(0, (minX - 1) * gs),
      y0: Math.max(0, (minY - 1) * gs),
      x1: Math.min(width, (maxX + 2) * gs),
      y1: Math.min(height, (maxY + 2) * gs),
      added: a,
      removed: rm,
    });
  }

  // Pass 2: merge regions whose padded boxes overlap or lie within
  // `mergeDistance` cells (0 = overlap/touch only), until stable.
  const slack = Math.max(0, Math.round(thresholds.mergeDistance)) * gs;
  let changed = raw.length > 1;
  while (changed) {
    changed = false;
    const next: RawRegion[] = [];
    for (const r of raw) {
      let target: RawRegion | null = null;
      for (const q of next) {
        const gapX = Math.max(q.x0 - r.x1, r.x0 - q.x1);
        const gapY = Math.max(q.y0 - r.y1, r.y0 - q.y1);
        if (gapX <= slack && gapY <= slack) {
          target = q;
          break;
        }
      }
      if (target) {
        target.x0 = Math.min(target.x0, r.x0);
        target.y0 = Math.min(target.y0, r.y0);
        target.x1 = Math.max(target.x1, r.x1);
        target.y1 = Math.max(target.y1, r.y1);
        target.added += r.added;
        target.removed += r.removed;
        changed = true;
      } else {
        next.push({ ...r });
      }
    }
    raw = next;
  }

  const out = raw.map((r) => {
    const total = r.added + r.removed;
    let kind: ChangeKind = "modified";
    if (r.added >= KIND_AGREEMENT * total) kind = "added";
    else if (r.removed >= KIND_AGREEMENT * total) kind = "removed";
    return {
      kind,
      bbox: { x: r.x0 / scale, y: r.y0 / scale, w: (r.x1 - r.x0) / scale, h: (r.y1 - r.y0) / scale },
      diffPixels: total,
      addedPixels: r.added,
      removedPixels: r.removed,
    };
  });
  out.sort((p, q) => p.bbox.y - q.bbox.y || p.bbox.x - q.bbox.x);
  return out.map((r2, i) => ({ id: i + 1, ...r2 }));
}
