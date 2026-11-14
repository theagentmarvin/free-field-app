// Pure 2D geometry for PDF measuring. Coordinates are PDF page units
// (points, y-down). No React, no three.

export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Per-segment lengths of an open polyline (length n-1 for n points). */
export function segmentLengths(points: readonly Point[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) out.push(distance(points[i - 1], points[i]));
  return out;
}

export function polylineLength(points: readonly Point[]): number {
  return segmentLengths(points).reduce((s, v) => s + v, 0);
}

/** Perimeter of a closed polygon (last point joins back to the first). */
export function polygonPerimeter(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  return polylineLength(points) + distance(points[points.length - 1], points[0]);
}

/** Absolute polygon area (shoelace). Self-intersecting input gives the signed-sum magnitude. */
export function polygonArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Vertex average; good enough for placing an area label. */
export function centroid(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Snap `p` to the nearest candidate within `radius` (same units as the
 * points). Returns the candidate, or `p` itself when none is close enough.
 */
export function snapToPoints(
  p: Point,
  candidates: readonly Point[],
  radius: number,
): { point: Point; snapped: boolean } {
  let best: Point | null = null;
  let bestD = radius;
  for (const c of candidates) {
    const d = distance(p, c);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best ? { point: best, snapped: true } : { point: p, snapped: false };
}

/**
 * Convert a client (screen) position to page units given the on-screen
 * rect of the page and the page size in page units. Works for any zoom
 * or pan because the rect is the post-transform bounding box.
 */
export function clientToPage(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * pageWidth,
    y: ((clientY - rect.top) / rect.height) * pageHeight,
  };
}

/** Inverse of `clientToPage`. */
export function pageToClient(
  p: Point,
  rect: { left: number; top: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): Point {
  return {
    x: rect.left + (p.x / pageWidth) * rect.width,
    y: rect.top + (p.y / pageHeight) * rect.height,
  };
}

/**
 * Map a point through a page rotation (clockwise quarter turns, as in
 * the PDF /Rotate entry) given the UNROTATED page size. The FreeField
 * viewer renders PDF.js's already-rotated viewport, so measure points
 * are always in displayed-page units; this helper exists for callers
 * holding unrotated coordinates.
 */
export function rotatePagePoint(
  p: Point,
  quarterTurns: number,
  width: number,
  height: number,
): Point {
  const q = ((Math.round(quarterTurns) % 4) + 4) % 4;
  switch (q) {
    case 1:
      return { x: height - p.y, y: p.x };
    case 2:
      return { x: width - p.x, y: height - p.y };
    case 3:
      return { x: p.y, y: width - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}
