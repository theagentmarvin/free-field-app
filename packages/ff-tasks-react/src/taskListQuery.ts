import type { TaskView } from "@ff/tasks";

import { applyColumnFilters, type ActiveFilters } from "./columnFilters";
import {
  applyQuickFilters,
  chipCounts,
  deadlineSignal,
  filterMergedTasks,
  matchesChip,
  scopeRowsToBuilding,
  type Chip,
  type QuickFilters,
  type SavedView,
  type ScopeMode,
  type SortKey,
} from "./logic";
import { sortRowsByColumn, type ColumnId, type SortDir, type TaskTableRow } from "./tableColumns";
import { withEffectiveBuilding, type TaskBuildingIndex } from "./taskBuilding";

/**
 * The one task-list pipeline, shared by the web Tasks module and the
 * tablet app. Pure: zero React, zero I/O, `now` is injected.
 *
 * Order (every step AND-composes with the previous one):
 *   saved-view predicates -> search -> sort -> effective building ->
 *   building scope -> quick filters -> chip counts -> status chip ->
 *   row enrichment -> per-column filters -> optional header sort.
 *
 * `merged` is the output of `mergeTaskViews` (cloud docs + queued outbox
 * actions); callers merge once per snapshot and re-run this on every
 * filter change.
 */
export interface TaskListQuery {
  chip: Chip;
  search: string;
  sort: SortKey;
  /** the active saved view (its `myTasks` / `overdueOnly` predicates apply), or null */
  view: SavedView | null;
  scope: ScopeMode;
  /** the building "This building" scopes to; null = no scoping */
  buildingId: string | null;
  quick: QuickFilters;
  columnFilters: ActiveFilters;
  /** optional header sort applied after the column filters (`dir: "none"` = keep order) */
  columnSort?: { colId: ColumnId; dir: SortDir };
  uid: string | null | undefined;
  now: number;
  buildingIndex: TaskBuildingIndex;
  /** building id -> display name (the table's building column shows and filters by it) */
  buildingNames: ReadonlyMap<string, string>;
}

export interface TaskListResult {
  /** per-chip counts (all / open / closed / each status) after scope + quick filters */
  counts: Record<string, number>;
  quickCounts: { mine: number; overdue: number };
  /** rows after the status chip, before the column filters: the option source for `distinctOptions` */
  tableRows: TaskTableRow[];
  /** the final list: column filters applied, then the optional header sort */
  rows: TaskTableRow[];
}

const FLOOR_MINUTE = 60_000;

/** Minute-granular clock, so memo keys do not churn every render. */
export function minuteOf(now: number): number {
  return Math.floor(now / FLOOR_MINUTE);
}

// Enrichment copies a row only when its display fields change, and caches the copy per source
// object, so re-filtering thousands of rows does not allocate thousands of objects.
const enrichCache = new WeakMap<object, { names: ReadonlyMap<string, string>; row: TaskTableRow }>();

export function enrichTaskRow(t: TaskView, names: ReadonlyMap<string, string>): TaskTableRow {
  const hit = enrichCache.get(t);
  if (hit && hit.names === names) return hit.row;
  const raw = t as TaskTableRow;
  const bid = t.buildingId ?? null;
  const buildingName = bid ? (names.get(bid) ?? null) : null;
  const storeyName = raw.location?.storeyName ?? null;
  const row: TaskTableRow =
    (raw.buildingName ?? null) === buildingName && (raw.storeyName ?? null) === storeyName ? raw : { ...raw, buildingName, storeyName };
  enrichCache.set(t, { names, row });
  return row;
}

export function selectTaskList(merged: readonly TaskView[], q: TaskListQuery): TaskListResult {
  const filtered = filterMergedTasks(merged, {
    chip: "all",
    search: q.search,
    sort: q.sort,
    assigneeUid: q.view?.apply.myTasks ? q.uid : undefined,
    overdueOnly: q.view?.apply.overdueOnly,
    overdueNow: q.now,
  });
  // Old tasks without a stamped building show (and scope by) the building they are pinned in.
  const effective = withEffectiveBuilding(filtered, q.buildingIndex);
  const preQuick = scopeRowsToBuilding(effective, q.buildingId, q.scope);
  const quickCounts = {
    mine: preQuick.filter((t) => !!q.uid && t.assigneeUid === q.uid && matchesChip(t.status, "open")).length,
    overdue: preQuick.filter((t) => deadlineSignal(t.deadline, t.status, q.now) === "overdue").length,
  };
  const quickFiltered = applyQuickFilters(preQuick, q.quick, q.uid, q.now);
  const counts = chipCounts(quickFiltered);
  const scoped = quickFiltered.filter((t) => matchesChip(t.status, q.chip));
  const tableRows = scoped.map((t) => enrichTaskRow(t, q.buildingNames));
  const columnFiltered = applyColumnFilters(tableRows, q.columnFilters, q.now);
  const rows = q.columnSort ? sortRowsByColumn(columnFiltered, q.columnSort.colId, q.columnSort.dir, q.now) : columnFiltered;
  return { counts, quickCounts, tableRows, rows };
}
