import { createElement, Fragment } from "react";
import type { ReactNode } from "react";

import { isLinkviewLocation, normalizeChecklist, normalizeLocationThumb2dPath, PRIORITY_LABELS, PRIORITY_RANK, priorityOf, checklistProgress, type TaskView } from "@ff/tasks";

import { fmtDdMmm, formatTaskNum, initialsOf, STATUS_LABELS } from "./logic";
import {
  avatarAccent,
  avatarMiniStyle,
  softStatusDotStyle,
  softStatusStyle,
  statusAccent,
} from "./formStyles";
import type { PhotoUrlResolver } from "./usePhotoUrl";
import { ChecklistProgress, DeadlineChip, PriorityChip } from "./TaskChips";
import { TaskTableThumb } from "./TaskTableThumb";
import { OpenableLocationThumb } from "./LocationThumb";

/**
 * Wave 5A — tasks table column registry + pure picker/sort logic.
 *
 * One entry per field on the task (derived from `TaskView` plus the
 * cloud doc fields that ride along via `{ ...t }` in mergeTaskViews:
 * `type`, `createdBy`, `location`). Every render/sort descriptor is
 * STRUCTURAL — no Firebase, no hooks, no side effects. The only
 * runtime dep is React descriptor creation; `ctx` carries `now` and a
 * `resolvePhotoUrl` so a cell can show a thumb without the registry
 * knowing where the bytes live.
 */

/** Cloud-doc passthrough fields not (yet) declared on TaskView. */
export interface TaskLocationLike {
  storeyName?: string | null;
  text?: string;
  bim?: { elements?: unknown[] } | null;
  pdf?: unknown | null;
}

/** TaskView + the cloud fields the table can surface. Optional
 *  extras make a plain `TaskView[]` assignable into every table
 *  mutation — no casts at the call site. */
export interface TaskTableRow extends TaskView {
  type?: string | null;
  createdBy?: string | null;
  location?: TaskLocationLike | null;
  /** Day-3 location snapshot thumb path (resolved via ctx.resolvePhotoUrl). */
  locationThumbPath?: string | null;
  /** UI-refresh v1: building scope id (null/absent = cross-building). */
  buildingId?: string | null;
  /** Host-enriched display name (attached by <TasksApp> from the rail's
   *  building list — the package never imports the building store). */
  buildingName?: string | null;
  /** Host-enriched storey display (mobile meta line: Building · Storey). */
  storeyName?: string | null;
}

export const COLUMN_IDS = [
  "num",
  "title",
  "type",
  "status",
  "priority",
  "assigneeName",
  "building",
  "deadline",
  "checklist",
  "createdBy",
  "createdAt",
  "updatedAt",
  "photos",
  "entryCount",
  "location",
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

const COLUMN_ID_SET: ReadonlySet<string> = new Set<string>(COLUMN_IDS);

function isColumnId(v: unknown): v is ColumnId {
  return typeof v === "string" && COLUMN_ID_SET.has(v);
}

/** `num` is always visible — its picker checkbox is disabled so at
 *  least one column stays on (standard table-col UX). */
export const PINNED_COLUMN: ColumnId = "num";

/** Approved default visible set (boss VDC 2026-11-02): the core
 *  six — num, title, type, status, assignee, deadline — plus the
 *  UI-refresh v1 `building` column (default-visible, spec §4). */
export const DEFAULT_VISIBLE_COLUMNS: readonly ColumnId[] = [
  "num",
  "title",
  "type",
  "status",
  "priority",
  "assigneeName",
  "building",
  "deadline",
];

export const COLUMN_STORAGE_KEY = "ff-task-columns";

export type SortDir = "asc" | "desc" | "none";

/** Wave 10 — per-column filter popover kind. `photos` omits it (no
 *  funnel). Distinct columns surface display strings; number columns
 *  surface raw numbers; deadline/date columns surface timestamps. */
export type ColumnFilterKind =
  | "distinct"
  | "contains"
  | "deadline"
  | "date"
  | "number";

export interface ColumnRenderCtx {
  now: number;
  resolvePhotoUrl?: PhotoUrlResolver;
}

export interface TableColumn {
  id: ColumnId;
  label: string;
  width?: number;
  /** numeric columns sort numerically, string columns lexicographically;
   *  `null`/`undefined`/empty = "missing" — always last regardless of dir. */
  sortValue?: (row: TaskTableRow, now: number) => string | number | null | undefined;
  /** structural descriptor (string or React element). No hooks here. */
  render?: (row: TaskTableRow, ctx: ColumnRenderCtx) => ReactNode;
  /** Wave 10 — filter popover kind; absent → no funnel (e.g. `photos`). */
  filterKind?: ColumnFilterKind;
  /** Wave 10 — pure value-extraction descriptor for filtering. Distinct
   *  columns return the display string; number columns the raw number;
   *  deadline/date columns a timestamp. Structural — no side effects. */
  filterValue?: (row: TaskTableRow) => string | number | null | undefined;
}

export { fmtDdMmm };

/** 3D = BIM pin(s), 2D = plan/PDF pin, otherwise none. */
export function locationKind(loc: TaskLocationLike | null | undefined): "3D" | "2D" | null {
  if (!loc) return null;
  if (loc.bim && (loc.bim.elements?.length ?? 0) > 0) return "3D";
  if (loc.pdf) return "2D";
  return null;
}

function locationSortValue(row: TaskTableRow): number {
  const kind = locationKind(row.location);
  return kind === "3D" ? 2 : kind === "2D" ? 1 : 0;
}

const titleRender = (row: TaskTableRow, ctx: ColumnRenderCtx): ReactNode => {
  const first = row.photos?.[0]?.storagePath;
  return createElement(
    Fragment,
    null,
    first
      ? createElement(TaskTableThumb, {
          path: first,
          resolve: ctx.resolvePhotoUrl,
          label: `Photo for ${formatTaskNum(row.num)}`,
        })
      : null,
    row.title
  );
};

/** V3 — soft status: quiet 8px dot (accent palette hex) + muted label;
 *  the filled block survives only on the selected chip elsewhere. */
const statusRender = (row: TaskTableRow): ReactNode =>
  createElement(
    "span",
    { className: "ff-task-table-status", style: softStatusStyle },
    createElement("span", {
      className: "ff-task-table-status-dot",
      style: { ...softStatusDotStyle, background: statusAccent(row.status).bg },
      title: STATUS_LABELS[row.status] ?? String(row.status),
    }),
    STATUS_LABELS[row.status] ?? String(row.status)
  );

/** V5 — avatar initials circle (deterministic accent) + name. */
const assigneeRender = (row: TaskTableRow): ReactNode => {
  const name = (row.assigneeName ?? "").trim();
  if (!name) return "—";
  return createElement(
    "span",
    {
      className: "ff-task-assignee-cell",
      style: { display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", verticalAlign: "middle" },
    },
    createElement(
      "span",
      { "aria-hidden": "true", style: { ...avatarMiniStyle, flex: "0 0 auto", background: avatarAccent(name) } },
      initialsOf(name)
    ),
    createElement(
      "span",
      { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } },
      name
    )
  );
};

/** V6 — relative deadline (Today · Tomorrow · in 3d · 3d late) with
 *  `--danger` on overdue; far dates fall back to `dd MMM yyyy`. */
const deadlineRender = (row: TaskTableRow, ctx: ColumnRenderCtx): ReactNode =>
  createElement(DeadlineChip, { deadline: row.deadline ?? null, status: row.status, now: ctx.now });

const priorityRender = (row: TaskTableRow): ReactNode =>
  createElement(PriorityChip, { priority: row.priority });

const checklistRender = (row: TaskTableRow): ReactNode =>
  createElement(ChecklistProgress, { items: normalizeChecklist(row.checklist) }) ?? "—";

/** §2 — building name; legacy/cross-building renders "—". */
const buildingRender = (row: TaskTableRow): ReactNode => {
  if (row.buildingId == null) return "—";
  return (row.buildingName || row.buildingId) as ReactNode;
};

const locationRender = (row: TaskTableRow, ctx: ColumnRenderCtx): ReactNode => {
  const kind = locationKind(row.location);
  // LinkView dual location: plan | 3D thumbs side by side (compact, no text chip).
  const path2d = normalizeLocationThumb2dPath(row.location);
  if (kind && row.locationThumbPath && path2d && isLinkviewLocation(row.location)) {
    return createElement(
      "span",
      {
        className: "ff-task-table-location ff-task-table-location-dual",
        "data-testid": "ff-task-table-location-dual",
        style: { display: "inline-flex", alignItems: "center", padding: "1px 2px", whiteSpace: "nowrap" },
      },
      createElement(OpenableLocationThumb, {
        task: row,
        path: row.locationThumbPath,
        path2d,
        resolve: ctx.resolvePhotoUrl,
        label: `Location snapshot for ${formatTaskNum(row.num)}`,
        style: { width: 30, height: 22, borderRadius: 4, marginRight: 0 },
      }),
    );
  }
  if (!kind) {
    // A location thumb can exist even when the parsed kind is null
    // (e.g. a snapshot captured but the loc shape is post-v1) — show
    // just the thumb then.
    const thumb = row.locationThumbPath
      ? createElement(OpenableLocationThumb, {
          task: row,
          path: row.locationThumbPath,
          resolve: ctx.resolvePhotoUrl,
          label: "Location snapshot",
        })
      : null;
    return thumb ?? "—";
  }
  return createElement(
    "span",
    {
      className: "ff-task-table-location",
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "1px 8px",
        borderRadius: 10,
        fontSize: 12,
        background: kind === "3D" ? "#e8f0fe" : "#e6f4ea",
        color: kind === "3D" ? "#1a73e8" : "#188038",
        whiteSpace: "nowrap",
      },
    },
    row.locationThumbPath
      ? createElement(OpenableLocationThumb, {
          task: row,
          path: row.locationThumbPath,
          resolve: ctx.resolvePhotoUrl,
          label: `Location snapshot for ${formatTaskNum(row.num)}`,
          style: { width: 16, height: 16, borderRadius: 4, marginRight: 0 },
        })
      : null,
    kind === "3D" ? "3D" : "2D"
  );
};

/** The 12-column registry, in spec order. */
export const TABLE_COLUMNS: readonly TableColumn[] = [
  { id: "num", label: "#", width: 72, sortValue: (r) => r.num, filterKind: "number", filterValue: (r) => r.num, render: (r) => formatTaskNum(r.num) },
  { id: "title", label: "Title", sortValue: (r) => r.title.toLowerCase(), filterKind: "contains", filterValue: (r) => r.title, render: titleRender },
  { id: "type", label: "Type", width: 96, sortValue: (r) => (r.type ?? "").toLowerCase(), filterKind: "distinct", filterValue: (r) => (r.type ?? "").trim() || null, render: (r) => (r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1) : "—") },
  { id: "status", label: "Status", width: 150, sortValue: (r) => r.status, filterKind: "distinct", filterValue: (r) => STATUS_LABELS[r.status] ?? String(r.status), render: statusRender },
  { id: "priority", label: "Priority", width: 100, sortValue: (r) => PRIORITY_RANK[priorityOf(r.priority)], filterKind: "distinct", filterValue: (r) => PRIORITY_LABELS[priorityOf(r.priority)], render: priorityRender },
  { id: "assigneeName", label: "Assignee", width: 140, sortValue: (r) => (r.assigneeName ?? "").toLowerCase(), filterKind: "distinct", filterValue: (r) => (r.assigneeName ?? "").trim() || null, render: assigneeRender },
  { id: "building", label: "Building", width: 130, sortValue: (r) => (r.buildingName ?? r.buildingId ?? "").toLowerCase(), filterKind: "distinct", filterValue: (r) => (r.buildingName ?? (r.buildingId == null ? null : String(r.buildingId))), render: buildingRender },
  { id: "deadline", label: "Deadline", width: 118, sortValue: (r) => r.deadline ?? null, filterKind: "deadline", filterValue: (r) => r.deadline ?? null, render: deadlineRender },
  { id: "checklist", label: "Checklist", width: 120, sortValue: (r) => { const p = checklistProgress(normalizeChecklist(r.checklist)); return p.total === 0 ? null : p.done / p.total; }, render: (r) => checklistProgress(normalizeChecklist(r.checklist)).total === 0 ? "—" : checklistRender(r) },
  { id: "createdBy", label: "Created by", width: 120, sortValue: (r) => (r.createdBy ?? "").toLowerCase(), filterKind: "contains", filterValue: (r) => (r.createdBy ?? "").trim() || null, render: (r) => r.createdBy || "—" },
  { id: "createdAt", label: "Created", width: 116, sortValue: (r) => r.createdAt ?? null, filterKind: "date", filterValue: (r) => r.createdAt ?? null, render: (r) => fmtDdMmm(r.createdAt ?? null) },
  { id: "updatedAt", label: "Updated", width: 116, sortValue: (r) => r.updatedAt, filterKind: "date", filterValue: (r) => r.updatedAt, render: (r) => fmtDdMmm(r.updatedAt) },
  { id: "photos", label: "Photos", width: 78, sortValue: (r) => r.photos?.length ?? 0, render: (r) => String(r.photos?.length ?? 0) },
  { id: "entryCount", label: "Entries", width: 72, sortValue: (r) => r.entryCount, filterKind: "number", filterValue: (r) => r.entryCount, render: (r) => String(r.entryCount) },
  { id: "location", label: "Location", width: 96, sortValue: locationSortValue, filterKind: "distinct", filterValue: (r) => { const k = locationKind(r.location); return k === "3D" ? "3D" : k === "2D" ? "2D" : null; }, render: locationRender },
];

export function getColumn(id: ColumnId): TableColumn | undefined {
  return TABLE_COLUMNS.find((c) => c.id === id);
}

// ── Picker pure logic ────────────────────────────────────────────────

/** Add/remove `id` from `set`. `num` is pinned — removing it is a no-op. */
export function toggleColumn(
  set: ReadonlySet<ColumnId>,
  id: ColumnId,
  on: boolean
): Set<ColumnId> {
  if (id === PINNED_COLUMN) return new Set(set);
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Filter the registry by (case-insensitive) label substring. */
export function filterColumns(query: string): TableColumn[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TABLE_COLUMNS];
  return TABLE_COLUMNS.filter((c) => c.label.toLowerCase().includes(q));
}

/** read the persisted set; missing/unset/corrupt → approved defaults
 *  (with `num` always pinned back in). */
export function loadVisibleColumns(): Set<ColumnId> {
  const fallback = () => {
    const next = new Set<ColumnId>(DEFAULT_VISIBLE_COLUMNS);
    next.add(PINNED_COLUMN);
    return next;
  };
  if (typeof localStorage === "undefined") return fallback();
  let raw: string | null;
  try {
    raw = localStorage.getItem(COLUMN_STORAGE_KEY);
  } catch {
    return fallback();
  }
  if (!raw) return fallback();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback();
    const ids = parsed.filter(isColumnId);
    if (ids.length === 0) return fallback();
    const next = new Set<ColumnId>(ids);
    next.add(PINNED_COLUMN);
    return next;
  } catch {
    return fallback();
  }
}

export function saveVisibleColumns(set: ReadonlySet<ColumnId>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private mode — persistence is best-effort only */
  }
}

// ── Sort pure logic ──────────────────────────────────────────────────

function isMissingSortValue(v: string | number | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (typeof v === "number" && (Number.isNaN(v) || !Number.isFinite(v))) return true;
  return false;
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Header-click sort. `none` is a no-op (incoming order preserved).
 *  Missing values (no deadline/creator/date) always sort LAST in both
 *  directions; ties fall back to `updatedAt` desc for stability. */
export function sortRowsByColumn(
  rows: readonly TaskTableRow[],
  colId: ColumnId,
  dir: SortDir,
  now: number
): TaskTableRow[] {
  if (dir === "none" || rows.length < 2) return [...rows];
  const col = getColumn(colId);
  const sv = col?.sortValue;
  if (!sv) return [...rows];
  const byKey = (r: TaskTableRow) => sv(r, now);

  const present: TaskTableRow[] = [];
  const missing: TaskTableRow[] = [];
  for (const r of rows) (isMissingSortValue(byKey(r)) ? missing : present).push(r);

  present.sort((a, b) => {
    const cmp = compareValues(byKey(a) as string | number, byKey(b) as string | number);
    if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    return b.updatedAt - a.updatedAt;
  });

  return [...present, ...missing];
}