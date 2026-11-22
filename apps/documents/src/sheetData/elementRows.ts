// apps/documents/src/sheetData/elementRows.ts
//
// "Elements on this drawing": rows, category counts, filtering, CSV.

import type { SheetPayload } from "./sheetPayload";

export const UNCATEGORISED = "Other";

export interface ElementRow {
  gid: string;
  category: string;
  family: string;
  type: string;
  level: string;
  uid: string;
  eid: string;
  /** The element's mark (or its localised equivalent), "" when none. */
  mark: string;
  /** Flat display values of the element's parameters, by name. */
  params: Record<string, string>;
}

const MARK_NAME = /^(mark|marca|código de montaje|codigo de montaje)$/i;

export function isMarkParam(name: string, key?: string | null): boolean {
  return key === "ALL_MODEL_MARK" || MARK_NAME.test(name.trim());
}

export function paramDisplay(p: { v?: unknown; d?: string | null; u?: string | null }): string {
  if (p.d !== undefined && p.d !== null && p.d !== "") return p.d;
  if (p.v === undefined || p.v === null) return "";
  return `${String(p.v)}${p.u ? ` ${p.u}` : ""}`;
}

/** One row per distinct element (an element may be drawn in several views). */
export function buildElementRows(payload: SheetPayload): ElementRow[] {
  const seen = new Set<string>();
  const rows: ElementRow[] = [];
  for (const e of payload.elements) {
    if (seen.has(e.gid)) continue;
    seen.add(e.gid);
    const rec = payload.elementRecords[e.gid];
    const params: Record<string, string> = {};
    let mark = "";
    for (const [k, p] of Object.entries(rec?.params ?? {})) {
      const s = paramDisplay(p);
      if (!s) continue;
      params[k] = s;
      if (!mark && isMarkParam(k, p.k)) mark = s;
    }
    rows.push({
      gid: e.gid,
      category: rec?.category?.trim() || UNCATEGORISED,
      family: rec?.family ?? "",
      type: rec?.type ?? "",
      level: rec?.level ?? "",
      uid: rec?.uid ?? "",
      eid: rec?.eid !== undefined ? String(rec.eid) : "",
      mark,
      params,
    });
  }
  return rows;
}

export function categoryCounts(rows: readonly ElementRow[]): Array<{ category: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
  return [...m.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function filterRows(
  rows: readonly ElementRow[],
  categories: ReadonlySet<string>,
  search = "",
): ElementRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (categories.size > 0 && !categories.has(r.category)) return false;
    if (!q) return true;
    const hay = [r.category, r.family, r.type, r.level, r.uid, r.eid, r.gid, ...Object.values(r.params)]
      .join("\n")
      .toLowerCase();
    return hay.includes(q);
  });
}

export { toCsv } from "./tableExport";
