import { isOverdue } from "./logic";
import {
  COLUMN_IDS,
  getColumn,
  type ColumnFilterKind,
  type ColumnId,
  type TaskTableRow,
} from "./tableColumns";

/**
 * Wave 10 — pure per-column filter logic. Zero React, zero side effects.
 *
 * The registry (`tableColumns.ts`) carries each column's `filterKind` +
 * `filterValue` (the value-extraction descriptor); this module carries
 * the filter shapes, the OR-within / AND-across composition, and the
 * distinct-value extraction + date-preset windows. Composition order is
 * owned by the caller (<TaskTablePanel>): status chips + global search
 * are already applied to `rows`, column filters run here, and header
 * sort runs after — see `applyColumnFilters(rows, filters, now)`.
 *
 * UI-refresh v1 §4 — the `building` column filter is pure registry: the
 * column declares `filterKind: "distinct"` + `filterValue` (enriched
 * building name; legacy rows group under `(none)`) in `tableColumns.ts`,
 * so it flows through every path here with ZERO new filter machinery.
 */

// ── Filter shapes ────────────────────────────────────────────────────

export interface DistinctFilter {
  kind: "distinct";
  /** selected distinct keys (the `filterValue` string of a row). Empty = off. */
  keys: readonly string[];
}
export interface ContainsFilter {
  kind: "contains";
  query: string;
}
export interface DeadlineFilter {
  kind: "deadline";
  presets: readonly DeadlinePresetKey[];
}
export interface DateFilter {
  kind: "date";
  presets: readonly DatePresetKey[];
}
export interface NumberFilter {
  kind: "number";
  min: number | null;
  max: number | null;
}

export type ColumnFilter =
  | DistinctFilter
  | ContainsFilter
  | DeadlineFilter
  | DateFilter
  | NumberFilter;

/** One filter per column (key = ColumnId). Undefined value = no filter. */
export type ActiveFilters = Partial<Record<ColumnId, ColumnFilter>>;

// ── Date presets ─────────────────────────────────────────────────────

export const DEADLINE_PRESETS = ["overdue", "today", "thisWeek", "next7", "none"] as const;
export type DeadlinePresetKey = (typeof DEADLINE_PRESETS)[number];
export const DEADLINE_PRESET_LABELS: Record<DeadlinePresetKey, string> = {
  overdue: "Overdue",
  today: "Today",
  thisWeek: "This week",
  next7: "Next 7 days",
  none: "No deadline",
};

export const DATE_PRESETS = ["today", "thisWeek", "past7"] as const;
export type DatePresetKey = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_LABELS: Record<DatePresetKey, string> = {
  today: "Today",
  thisWeek: "This week",
  past7: "Past 7 days",
};

export const DAY_MS = 86_400_000;

/** Local-calendar start of the day containing `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** Local-calendar end of the day containing `now` (inclusive). */
export function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
/** Local-calendar start of the week (Monday 00:00) containing `now`. */
export function startOfWeek(now: number): number {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}
/** Local-calendar end of the week (Sunday 23:59:59.999) containing `now`. */
export function endOfWeek(now: number): number {
  return startOfWeek(now) + 7 * DAY_MS - 1;
}

// ── Value extraction (via registry `filterValue`) ───────────────────

/** The column's normalized filter value for a row. */
export function filterValueOf(
  row: TaskTableRow,
  colId: ColumnId,
): string | number | null | undefined {
  return getColumn(colId)?.filterValue?.(row);
}

/** Normalize a distinct filter value to a stable non-empty key. */
function toDistinctKey(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "(none)";
  if (typeof v === "number") return String(v);
  const s = v.trim();
  return s || "(none)";
}

/** Stable distinct key for a row under a column (same normalization as the
 *  popover's option list, so selection always matches extraction). */
export function distinctKey(row: TaskTableRow, colId: ColumnId): string {
  return toDistinctKey(filterValueOf(row, colId));
}

export interface DistinctOption {
  key: string;
  label: string;
  count: number;
}

/** Distinct values present in `rows`, each with its row count, sorted by
 *  label. Null/undefined group into `(none)`. */
export function distinctOptions(
  rows: readonly TaskTableRow[],
  colId: ColumnId,
): DistinctOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = distinctKey(r, colId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: DistinctOption[] = [];
  counts.forEach((count, key) => out.push({ key, label: key, count }));
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// ── Preset matching (fixed `now`, pure) ─────────────────────────────

/** Deadline preset windows. `overdue` = past-due + non-terminal (same
 *  rule as the rest of the app); `none` = missing/zero deadline; the rest
 *  are calendar/rolling windows relative to `now`. */
export function matchesDeadlinePreset(
  row: TaskTableRow,
  preset: DeadlinePresetKey,
  now: number,
): boolean {
  const ts = filterValueOf(row, "deadline");
  if (preset === "overdue") return isOverdue(row, now);
  if (preset === "none") return !(typeof ts === "number" && ts > 0);
  if (typeof ts !== "number" || ts <= 0) return false;
  switch (preset) {
    case "today":
      return ts >= startOfDay(now) && ts <= endOfDay(now);
    case "thisWeek":
      return ts >= startOfWeek(now) && ts <= endOfWeek(now);
    case "next7":
      return ts >= now && ts < now + 7 * DAY_MS;
    default:
      return false;
  }
}

/** created/updated preset windows. A missing timestamp matches nothing. */
export function matchesDatePreset(
  ts: string | number | null | undefined,
  preset: DatePresetKey,
  now: number,
): boolean {
  if (typeof ts !== "number" || ts <= 0) return false;
  switch (preset) {
    case "today":
      return ts >= startOfDay(now) && ts <= endOfDay(now);
    case "thisWeek":
      return ts >= startOfWeek(now) && ts <= endOfWeek(now);
    case "past7":
      return ts >= now - 7 * DAY_MS && ts <= now;
    default:
      return false;
  }
}

// ── Composition ─────────────────────────────────────────────────────

/** Does `row` satisfy one column's filter? OR semantics live inside each
 *  kind (multi-select keys / presets / empty query). */
export function matchesFilter(
  row: TaskTableRow,
  colId: ColumnId,
  filter: ColumnFilter,
  now: number,
): boolean {
  switch (filter.kind) {
    case "distinct":
      return filter.keys.includes(distinctKey(row, colId));
    case "contains": {
      const q = filter.query.trim().toLowerCase();
      if (!q) return true;
      const v = filterValueOf(row, colId);
      const s = v == null ? "" : String(v);
      return s.toLowerCase().includes(q);
    }
    case "deadline":
      return filter.presets.some((p) => matchesDeadlinePreset(row, p, now));
    case "date":
      return filter.presets.some((p) =>
        matchesDatePreset(filterValueOf(row, colId), p, now),
      );
    case "number": {
      const v = filterValueOf(row, colId);
      if (typeof v !== "number") return false;
      if (filter.min != null && v < filter.min) return false;
      if (filter.max != null && v > filter.max) return false;
      return true;
    }
  }
}

// ── Affordance helpers ──────────────────────────────────────────────

/** A filter is "empty" (inactive for counting/apply) when it selects
 *  nothing and constrains nothing. */
export function isFilterEmpty(filter: ColumnFilter | undefined): boolean {
  if (!filter) return true;
  switch (filter.kind) {
    case "distinct":
      return filter.keys.length === 0;
    case "contains":
      return filter.query.trim().length === 0;
    case "deadline":
    case "date":
      return filter.presets.length === 0;
    case "number":
      return filter.min == null && filter.max == null;
  }
}

/** Number of concrete selections a filter carries (funnel badge). */
export function filterSelectionCount(filter: ColumnFilter | undefined): number {
  if (!filter) return 0;
  switch (filter.kind) {
    case "distinct":
      return filter.keys.length;
    case "contains":
      return filter.query.trim() ? 1 : 0;
    case "deadline":
    case "date":
      return filter.presets.length;
    case "number": {
      let n = 0;
      if (filter.min != null) n++;
      if (filter.max != null) n++;
      return n;
    }
  }
}

/** How many columns currently have an active (non-empty) filter. */
export function countActiveFilters(filters: ActiveFilters): number {
  let n = 0;
  for (const id of COLUMN_IDS) {
    if (!isFilterEmpty(filters[id])) n++;
  }
  return n;
}

/** AND-across-columns composition. Applied AFTER status chips + search
 *  (which the caller already applied to `rows`), BEFORE sort. */
export function applyColumnFilters(
  rows: readonly TaskTableRow[],
  filters: ActiveFilters,
  now: number,
): TaskTableRow[] {
  const active: Array<{ colId: ColumnId; filter: ColumnFilter }> = [];
  for (const id of COLUMN_IDS) {
    const f = filters[id];
    if (f && !isFilterEmpty(f)) active.push({ colId: id, filter: f });
  }
  if (active.length === 0) return [...rows];
  return rows.filter((row) =>
    active.every(({ colId, filter }) => matchesFilter(row, colId, filter, now)),
  );
}

/** A fresh empty filter for a kind — the popover's starting draft. */
export function emptyFilter(kind: ColumnFilterKind): ColumnFilter {
  switch (kind) {
    case "distinct":
      return { kind: "distinct", keys: [] };
    case "contains":
      return { kind: "contains", query: "" };
    case "deadline":
      return { kind: "deadline", presets: [] };
    case "date":
      return { kind: "date", presets: [] };
    case "number":
      return { kind: "number", min: null, max: null };
  }
}