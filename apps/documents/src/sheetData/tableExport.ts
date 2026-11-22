// apps/documents/src/sheetData/tableExport.ts
//
// Typed tables (headers + cells) for the elements list and for schedules,
// with CSV and XLSX output, per-category column sets and file names.

import { isMarkParam, type ElementRow } from "./elementRows";
import { buildXlsx, type Cell } from "./xlsx";

export interface Table {
  headers: string[];
  rows: Cell[][];
}

/** Text that is exactly a plain number becomes a real numeric cell. */
export function toCell(s: string | number | null | undefined): Cell {
  if (s === null || s === undefined) return "";
  if (typeof s === "number") return Number.isFinite(s) ? s : "";
  const t = s.trim();
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return s;
  const n = Number(t);
  // Keep identifiers such as "007" or very long ids as text.
  return String(n) === t && Math.abs(n) < 1e15 ? n : s;
}

const FIXED = ["Category", "Family", "Type", "Level", "Source element id", "Element id", "GlobalId"] as const;
const MAX_PARAM_COLUMNS = 60;

/** Whole-drawing table: identity columns + every parameter (capped). */
export function generalTable(rows: readonly ElementRow[]): Table {
  const names = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.params)) names.add(k);
  const paramCols = [...names].sort((a, b) => a.localeCompare(b)).slice(0, MAX_PARAM_COLUMNS);
  return {
    headers: [...FIXED, ...paramCols],
    rows: rows.map((r) => [
      r.category, r.family, r.type, r.level, r.uid, toCell(r.eid), r.gid,
      ...paramCols.map((k) => toCell(r.params[k] ?? "")),
    ]),
  };
}

export const DEFAULT_PARAM_COLUMNS = 5;
const CANDIDATE_LIMIT = 16;
const EXCLUDED = /^(category|categoría|categoria|family|familia|type|tipo|level|nivel)(\s*\(type\))?$/i;

/** Most common non-empty parameters of the rows (marks and identity excluded). */
export function paramCandidates(rows: readonly ElementRow[], limit = CANDIDATE_LIMIT): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const [name, v] of Object.entries(r.params)) {
      if (!v || isMarkParam(name) || EXCLUDED.test(name.trim())) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Per-category schedule: Mark, Family and type, Level + chosen parameters. */
export function categoryTable(rows: readonly ElementRow[], paramNames: readonly string[]): Table {
  return {
    headers: ["Mark", "Family and type", "Level", ...paramNames],
    rows: rows.map((r) => [
      toCell(r.mark),
      [r.family, r.type].filter(Boolean).join(" : "),
      r.level,
      ...paramNames.map((k) => toCell(r.params[k] ?? "")),
    ]),
  };
}

/** Text that spreadsheets would execute as a formula when a CSV is opened. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v: Cell): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Numbers (typed cells) are safe; only TEXT is neutralised.
  if (typeof v === "string" && FORMULA_START.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV (CRLF, UTF-8 BOM so spreadsheets read non-ASCII text). */
export function tableToCsv(t: Table): string {
  const lines = [t.headers.map(csvCell).join(",")];
  for (const r of t.rows) lines.push(r.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** CSV of the general elements table (kept for existing callers). */
export function toCsv(rows: readonly ElementRow[]): string {
  return tableToCsv(generalTable(rows));
}

export function tableToXlsx(t: Table, sheetName: string): Uint8Array {
  return buildXlsx({ sheetName, headers: t.headers, rows: t.rows });
}

const safe = (s: string): string => s.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "x";

/** One category: "<category>-schedule-<sheet>.xlsx"; otherwise "elements-<sheet>.xlsx". */
export function exportFileName(sheetNumber: string, category: string | null, ext: "xlsx" | "csv"): string {
  const sheet = safe(sheetNumber || "sheet");
  return category ? `${safe(category)}-schedule-${sheet}.${ext}` : `elements-${sheet}.${ext}`;
}
