import {
  STATUS_COLORS,
  isLegal,
  mergeTaskViews,
  type TaskStatus,
  type TaskVerb,
  type TaskView,
} from "@ff/tasks";
import type { OutboxRecord } from "@ff/types";

/**
 * Pure list logic for <TasksListPanel>/<TasksApp> (plan §7 screen 1).
 * Zero React, zero firebase — the whole surface is unit-testable and
 * the compose/detail screens reuse it unchanged.
 */

export const STATUS_LABELS: Record<number, string> = {
  10: "Inbox",
  20: "Ongoing",
  30: "Rejected",
  40: "Awaiting approval",
  60: "Follow-up",
  65: "Approved",
  80: "Discontinued",
};

export const OPEN_STATUSES: readonly number[] = [10, 20, 40, 60];
export const CLOSED_STATUSES: readonly number[] = [65, 80];

export type Chip = "all" | "open" | "closed" | number; // number = exact status equality (§0 idea 2)
export type SortKey = "updated" | "deadline" | "created"; // created ≈ num desc (per-project sequence)

/**
 * Fixed Type vocabulary (boss decision v2): single-select chips. Stored
 * as a plain string on the doc (no schema change). Any legacy free-text
 * value from an old draft renders as an extra *custom* selected chip.
 */
export const TYPE_OPTIONS: readonly string[] = [
  "Defect",
  "RFI",
  "Snag",
  "Safety",
  "Info",
  "Other",
];

export function isCustomType(type: string | null | undefined): boolean {
  const v = (type ?? "").trim();
  return v.length > 0 && !TYPE_OPTIONS.includes(v);
}

/** Display number: T + 3-digit zero pad, no dash; digits grow past
 *  999 naturally (T1000, T1001…). Uniqueness is guaranteed by the
 *  atomic server counter (first allocation = 1) — this is purely the
 *  presentation format (boss VDC 2026-11-02 directive). */
export function formatTaskNum(num: number): string {
  return `T${String(num).padStart(3, "0")}`;
}

export function statusColor(status: number): string {
  return STATUS_COLORS[status as keyof typeof STATUS_COLORS] ?? "gray";
}

export function isOverdue(t: TaskView, now: number): boolean {
  return isOverdueDeadline(t.deadline ?? null, t.status, now);
}

/** Deadline treatment for the detail sheet: red + `Overdue` chip when
 *  past-due and the status is not terminal (65/80). */
export function isOverdueDeadline(
  deadline: number | null,
  status: number | null,
  now: number
): boolean {
  return (
    typeof deadline === "number" &&
    deadline > 0 &&
    deadline < now &&
    status !== null &&
    !CLOSED_STATUSES.includes(status)
  );
}

export interface VisibleOptions {
  chip?: Chip;
  search?: string;
  sort?: SortKey;
  limit?: number;
  /** demo: overlay `sending` rows (no Firestore optimistic cache) */
  overlaySending?: boolean;
  /** saved view "My tasks": keep only rows assigned to this uid */
  assigneeUid?: string | null;
  /** saved view "Overdue": keep only past-due non-terminal rows */
  overdueOnly?: boolean;
  /** injected clock for `overdueOnly` (keeps the merge testable) */
  overdueNow?: number;
}

export function visibleTasks(
  cloud: TaskView[],
  outboxRows: OutboxRecord[],
  opts: VisibleOptions = {}
): TaskView[] {
  const { limit = 50, overlaySending = false } = opts;
  // NOTE: no clock here on purpose — recency/overdue rendering takes
  // `now` at the panel (isOverdue), keeping this function pure.
  const merged = mergeTaskViews(cloud, outboxRows, { overlaySending }); // D5 suppression lives inside
  return filterMergedTasks(merged, opts).slice(0, limit);
}

/**
 * The filter + sort half of {@link visibleTasks}, for callers that already
 * hold merged rows (the tablet merges once per snapshot and re-filters on
 * every keystroke). Saved-view predicates, status chip, search, sort — in
 * that order. Pure; never mutates `merged`.
 */
export function filterMergedTasks(merged: readonly TaskView[], opts: VisibleOptions = {}): TaskView[] {
  const { chip = "all", search = "", sort = "updated" } = opts;
  let rows: TaskView[] = [...merged];

  // saved-view predicates (UI-refresh v1 §3 V8) — additive; absent
  // options keep the exact wave-10/11 semantics.
  if (opts.overdueOnly) rows = rows.filter((t) => isOverdueDeadline(t.deadline ?? null, t.status, opts.overdueNow ?? Date.now()));
  if (opts.assigneeUid) rows = rows.filter((t) => t.assigneeUid === opts.assigneeUid);

  if (chip === "open") rows = rows.filter((t) => OPEN_STATUSES.includes(t.status));
  else if (chip === "closed") rows = rows.filter((t) => CLOSED_STATUSES.includes(t.status));
  else if (typeof chip === "number") rows = rows.filter((t) => t.status === chip);

  const q = search.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        formatTaskNum(t.num).toLowerCase().includes(q) ||
        (t.assigneeName ?? "").toLowerCase().includes(q)
    );
  }

  switch (sort) {
    case "deadline":
      // dated first, soonest first; no-deadline last; failed/pending keep place
      rows = rows.sort(
        (a, b) =>
          ((a.deadline ?? Infinity) - (b.deadline ?? Infinity)) || b.updatedAt - a.updatedAt
      );
      break;
    case "created":
      rows = rows.sort((a, b) => b.num - a.num);
      break;
    default:
      rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return rows;
}

// ── UI refresh v1 (§2 scope, §3 V4/V6/V8) ──────────────────────────────

/** Module-level building scope: the rail's active building, or all. */
export type ScopeMode = "building" | "all";

/**
 * Building scope filter (spec §6.1/§6.2): with a building picked, keep
 * that building's tasks PLUS the legacy/cross-building ones (`null`/
 * absent buildingId) — they render "—" and are never orphaned. Without
 * a picked building (or scope = all) every row passes.
 */
export function scopeRowsToBuilding<T extends { buildingId?: string | null }>(
  rows: readonly T[],
  buildingId: string | null | undefined,
  mode: ScopeMode = "building"
): T[] {
  if (mode === "all" || !buildingId) return [...rows];
  return rows.filter((t) => t.buildingId == null || t.buildingId === buildingId);
}

/** Group-by key for the table's group headers + the board's grouping. */
export type GroupKey = "none" | "status" | "building" | "assignee";

export const GROUP_OPTIONS: ReadonlyArray<{ id: GroupKey; label: string }> = [
  { id: "status", label: "Status" },
  { id: "building", label: "Building" },
  { id: "assignee", label: "Assignee" },
  { id: "none", label: "No grouping" },
];

/** Rows visible to the grouper: TaskView + the host-enriched display
 *  fields (buildingName is attached by <TasksApp> from the rail's
 *  building list — the package stays host-agnostic). */
export interface GroupableTask extends TaskView {
  buildingId?: string | null;
  buildingName?: string | null;
}

export interface TaskGroup<T = GroupableTask> {
  key: string;
  label: string;
  rows: T[];
}

/**
 * Stable group ordering: Status by workflow order (10→20→40→60→
 * terminals), Building by label (legacy "—" last), Assignee by name
 * (unassigned last). Incoming row order is preserved inside groups.
 */
const STATUS_GROUP_ORDER: readonly number[] = [10, 20, 40, 60, 30, 65, 80];

function statusOrder(s: number): number {
  const i = STATUS_GROUP_ORDER.indexOf(s);
  return i === -1 ? STATUS_GROUP_ORDER.length : i;
}

export function groupTasks(
  rows: readonly GroupableTask[],
  group: GroupKey
): TaskGroup[] {
  if (group === "none") return [];
  const byKey = new Map<string, TaskGroup>();
  for (const r of rows) {
    let key: string;
    let label: string;
    if (group === "status") {
      key = String(r.status);
      label = STATUS_LABELS[r.status] ?? `status ${r.status}`;
    } else if (group === "building") {
      key = r.buildingId == null ? "(none)" : String(r.buildingId);
      label = r.buildingId == null ? "—" : (r.buildingName || r.buildingId);
    } else {
      key = (r.assigneeName ?? "").trim() || "(none)";
      label = key === "(none)" ? "Unassigned" : key;
    }
    const g = byKey.get(key) ?? { key, label, rows: [] };
    g.rows.push(r);
    byKey.set(key, g);
  }
  const out = [...byKey.values()];
  if (group === "status") out.sort((a, b) => statusOrder(Number(a.key)) - statusOrder(Number(b.key)));
  else if (group === "building")
    out.sort((a, b) => (a.key === "(none)" ? 1 : b.key === "(none)" ? -1 : a.label.localeCompare(b.label)));
  else out.sort((a, b) => (a.key === "(none)" ? 1 : b.key === "(none)" ? -1 : a.label.localeCompare(b.label)));
  return out;
}

/**
 * Relative-deadline text (spec §3 V6): Today · Tomorrow · `in 3d` for
 * the near future, `3d late` for the past; far dates return null so the
 * caller falls back to the absolute `dd MMM yyyy` rendering. `overdue`
 * is the SAME rule as isOverdue (past-due + non-terminal) — callers
 * paint it `--danger`.
 */
const DAY_MSLocal = 86_400_000;
function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function relativeDeadlineLabel(
  deadline: number | null,
  now: number
): { label: string; overdue: boolean } | null {
  if (typeof deadline !== "number" || deadline <= 0) return null;
  const days = Math.round((dayStart(deadline) - dayStart(now)) / DAY_MSLocal);
  // `overdue` here means "the date has passed"; callers AND it with the
  // row's non-terminal status check (deadlineIsOverdue) before painting
  // it `--danger` — terminals keep the quiet label.
  if (days === 0) return { label: "Today", overdue: false };
  if (days === 1) return { label: "Tomorrow", overdue: false };
  if (days === -1) return { label: "1d late", overdue: true };
  if (days < 0) return { label: `${-days}d late`, overdue: true };
  if (days <= 7) return { label: `in ${days}d`, overdue: false };
  return null; // far future — absolute date
}

/** `Overdue` verdict for a rendered deadline cell (V6 + the v2 sheet's
 *  chip rule): non-null only when the relative label says "late". */
export function deadlineIsOverdue(
  deadline: number | null,
  status: number | null,
  now: number
): boolean {
  return isOverdueDeadline(deadline, status, now);
}

/**
 * Quick hover action ✓ (spec §3 V7): the one-verb advance for a row.
 * 20/60 → complete (→ awaiting approval), 40 → approve (→ approved).
 * null = no quick verb from a terminal/inbox state — the button hides.
 */
export function quickAdvanceVerb(status: number): TaskVerb | null {
  if (isLegal("complete", status as TaskStatus)) return "complete";
  if (isLegal("approve", status as TaskStatus)) return "approve";
  return null;
}

/** Initials for the avatar circles (V5): first letters of up to two
 *  name words, uppercase. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return ((words[0] as string)[0] + (words[1] as string)[0]).toUpperCase();
}

/** View-tab state (Table · Board). */
export type ViewMode = "table" | "board";

/**
 * Saved views (spec §3 V8, §7 Q3: localStorage first). The four
 * boss-named presets; selecting one applies the pure state patch, the
 * choice persists per-user under `ff-task-views`.
 */
export interface SavedView {
  id: string;
  label: string;
  apply: {
    chip: Chip;
    sort: SortKey;
    scope: ScopeMode;
    group: GroupKey;
    myTasks?: boolean;
    overdueOnly?: boolean;
  };
}

export const SAVED_VIEWS: readonly SavedView[] = [
  { id: "my", label: "My tasks", apply: { chip: "open", sort: "updated", scope: "all", group: "status", myTasks: true } },
  { id: "overdue", label: "Overdue", apply: { chip: "all", sort: "deadline", scope: "all", group: "none", overdueOnly: true } },
  { id: "building", label: "This building", apply: { chip: "all", sort: "updated", scope: "building", group: "status" } },
  { id: "all", label: "All", apply: { chip: "all", sort: "updated", scope: "all", group: "none" } },
];

export const VIEWS_STORAGE_KEY = "ff-task-views";

export function loadSavedViewId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(VIEWS_STORAGE_KEY);
    return raw && SAVED_VIEWS.some((v) => v.id === raw) ? raw : null;
  } catch {
    return null;
  }
}

export function persistSavedViewId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (id) localStorage.setItem(VIEWS_STORAGE_KEY, id);
    else localStorage.removeItem(VIEWS_STORAGE_KEY);
  } catch {
    /* quota/private mode — best effort */
  }
}

// ── w69: due signalling, status counts, quick filters ───────────────────

/** Tasks due within this many days (inclusive, today = 0) read "due soon". */
export const DUE_SOON_DAYS = 3;

export type DeadlineSignal = "overdue" | "soon" | null;

/**
 * Deadline chip verdict: `overdue` (past-due, non-terminal), `soon`
 * (due today … within 3 days, non-terminal), else null. Date-based, so
 * a task due today is "soon" for the whole day and overdue from the
 * next calendar day (the same day boundary relativeDeadlineLabel uses
 * is NOT reused here — a deadline stamped earlier today is not yet late).
 */
export function deadlineSignal(
  deadline: number | null | undefined,
  status: number | null | undefined,
  now: number
): DeadlineSignal {
  if (typeof deadline !== "number" || deadline <= 0) return null;
  if (status === null || status === undefined || CLOSED_STATUSES.includes(status)) return null;
  if (isOverdueDeadline(deadline, status, now) && dayStart(deadline) < dayStart(now)) return "overdue";
  const days = Math.round((dayStart(deadline) - dayStart(now)) / DAY_MSLocal);
  if (days >= 0 && days <= DUE_SOON_DAYS) return "soon";
  return null;
}

/** Quick filters layered over the status chips (all optional/AND). */
export interface QuickFilters {
  mine?: boolean;
  overdue?: boolean;
}

export function applyQuickFilters<T extends { assigneeUid?: string | null; deadline?: number | null; status: number }>(
  rows: readonly T[],
  q: QuickFilters,
  uid: string | null | undefined,
  now: number
): T[] {
  let out = rows as readonly T[];
  if (q.mine) out = out.filter((t) => !!uid && t.assigneeUid === uid);
  if (q.overdue) out = out.filter((t) => deadlineSignal(t.deadline, t.status, now) === "overdue");
  return [...out];
}

export function matchesChip(status: number, chip: Chip): boolean {
  if (chip === "all") return true;
  if (chip === "open") return OPEN_STATUSES.includes(status);
  if (chip === "closed") return CLOSED_STATUSES.includes(status);
  return status === chip;
}

/** Per-chip counts (all / open / closed / each exact status). */
export function chipCounts(rows: readonly { status: number }[]): Record<string, number> {
  const out: Record<string, number> = { all: rows.length, open: 0, closed: 0 };
  for (const r of rows) {
    if (OPEN_STATUSES.includes(r.status)) out.open += 1;
    if (CLOSED_STATUSES.includes(r.status)) out.closed += 1;
    out[String(r.status)] = (out[String(r.status)] ?? 0) + 1;
  }
  return out;
}

export function chipCountKey(chip: Chip): string {
  return String(chip);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `dd MMM yyyy` — the boss-approved date rendering for the table. */
export function fmtDdMmm(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || ts <= 0) return "—";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
