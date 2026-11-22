// apps/documents/src/sheetData/hitTest.ts
//
// Pure hit-testing of a tap (PDF points, y down) against a sheet's
// element regions and link regions.

import type { Bbox, SheetElement, SheetLink, SheetPayload } from "./sheetPayload";

export function bboxContains(b: Bbox, x: number, y: number): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

export function bboxArea(b: Bbox): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/** Even-odd ray casting. */
export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j]![0] * poly[i]![1] - poly[i]![0] * poly[j]![1];
  }
  return Math.abs(a) / 2;
}

/**
 * The element under the point: among elements whose bbox contains it
 * (and, when an element has an exact outline, whose outline contains it
 * too), the SMALLEST wins (outline area when present, else bbox area).
 * Ties keep document order, so the later-drawn element does not steal
 * the pick.
 */
export function hitTestElements(
  elements: readonly SheetElement[],
  x: number,
  y: number,
): SheetElement | null {
  let best: SheetElement | null = null;
  let bestArea = Infinity;
  for (const e of elements) {
    if (!bboxContains(e.bbox, x, y)) continue;
    // A zero-area outline is degenerate: use the bbox instead of letting it always win.
    const outlineArea = e.outline ? polygonArea(e.outline) : 0;
    const outline = outlineArea > 0 ? e.outline : undefined;
    if (outline && !pointInPolygon(x, y, outline)) continue;
    const area = outline ? outlineArea : bboxArea(e.bbox);
    if (area < bestArea) {
      best = e;
      bestArea = area;
    }
  }
  return best;
}

/** The link under the point (smallest bbox wins). */
export function hitTestLinks(links: readonly SheetLink[], x: number, y: number): SheetLink | null {
  let best: SheetLink | null = null;
  let bestArea = Infinity;
  for (const l of links) {
    if (!bboxContains(l.bbox, x, y)) continue;
    const area = bboxArea(l.bbox);
    if (area < bestArea) {
      best = l;
      bestArea = area;
    }
  }
  return best;
}

export type TapHit =
  | { kind: "link"; link: SheetLink }
  | { kind: "element"; element: SheetElement }
  | null;

/** Links up to this share of the page are reference HEADS (section / elevation / callout symbols). */
export const HEAD_LINK_SHARE = 0.01;
/** Links covering more of the page than this are viewport boxes: never a tap target unless navigable. */
export const PAGE_LINK_SHARE = 0.25;

function pageArea(payload: SheetPayload): number {
  if (payload.page) return payload.page.widthPt * payload.page.heightPt;
  let w = 0;
  let h = 0;
  for (const e of payload.elements) {
    w = Math.max(w, e.bbox[2]);
    h = Math.max(h, e.bbox[3]);
  }
  return w * h;
}

/**
 * Tap priority:
 *  1. a reference HEAD (tiny link symbol, <= 1% of the page), whether or not its
 *     sheet is in the bundle (the latter reports a hint);
 *  2. an element;
 *  3. a larger link (a callout region or a section line) when nothing else is
 *     under the finger: navigates when its sheet is in the bundle, otherwise the
 *     caller shows the "not in the bundle" hint. Page-sized boxes to missing
 *     sheets are ignored: they used to swallow every tap.
 */
export function hitTestSheet(payload: SheetPayload, x: number, y: number): TapHit {
  const area = pageArea(payload);
  const isHead = (l: SheetLink): boolean => area <= 0 || bboxArea(l.bbox) <= HEAD_LINK_SHARE * area;
  const navigable = (l: SheetLink): boolean =>
    l.targetIncluded !== false && !!(l.targetSheetNumber && l.targetSheetNumber.trim());
  const head = hitTestLinks(payload.links.filter(isHead), x, y);
  if (head) return { kind: "link", link: head };
  const element = hitTestElements(payload.elements, x, y);
  if (element) return { kind: "element", element };
  const isPage = (l: SheetLink): boolean => area > 0 && bboxArea(l.bbox) > PAGE_LINK_SHARE * area;
  // Regions (callouts, section lines) and, for hints, regions to missing sheets; page-sized
  // boxes to missing sheets are ignored.
  const region = hitTestLinks(
    payload.links.filter((l) => !isHead(l) && (navigable(l) || !isPage(l))),
    x,
    y,
  );
  return region ? { kind: "link", link: region } : null;
}
