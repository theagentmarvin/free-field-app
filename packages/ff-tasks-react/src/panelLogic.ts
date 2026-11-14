import type { OutboxRecord } from "@ff/types";
import type { TaskView } from "@ff/tasks";
import { sendingActionLanded } from "@ff/tasks";

import { CLOSED_STATUSES, isOverdue } from "./logic";

/** Non-terminal = not approved/discontinued (the same closed set the
 *  list's `isOverdueDeadline` excludes). Uses a `number[]` so it types
 *  cleanly against `TaskView.status: number`. */
function isNonTerminal(status: number): boolean {
  return !CLOSED_STATUSES.includes(status);
}

/**
 * Pure logic for <TaskMiniPanel> (Wave 9, spec §A). Zero React, zero
 * firebase — the whole panel surface is derivable from these functions,
 * so the component is a thin shell and every scope/filter/badge/reset
 * rule is unit-testable in isolation.
 *
 * Row type: the panel needs `location` (to scope "In view") on top of
 * the `TaskView` projection the list/table already consume. Cloud
 * `Task` docs satisfy it structurally — `location.storeyName` drives
 * the 3D scope, `location.pdf.page` the 2D scope.
 */

export type PanelScope = "inview" | "all";
export type PanelChip = "all" | "open" | "overdue" | "mine";

/** Location slice the panel scopes on. Structural — a full `TaskLocation`
 *  (`@ff/firestore`) satisfies it, so the panel never imports firestore. */
export interface PanelLocation {
  storeyName?: string | null;
  bim?: {
    elements?: { modelId: string; expressId: number }[];
    worldPoint?: [number, number, number] | null;
    cameraPose?: {
      pos: [number, number, number];
      target: [number, number, number];
      fov: number;
      isOrtho: boolean;
    } | null;
  } | null;
  pdf?: {
    pdfFileId?: string;
    page?: number;
    uv?: [number, number] | null;
    calibId?: string;
  } | null;
}

/** A task row as the panel sees it: the list's `TaskView` fields plus
 *  the `location` anchor the scope filter reads. */
export interface PanelTask extends TaskView {
  location?: PanelLocation | null;
}

/** The four single-dimension filter chips (spec §A). */
export const PANEL_CHIPS: readonly PanelChip[] = ["all", "open", "overdue", "mine"];

/** Maintainer decision 1/5 — the panel opens on `In view`, no filter, no
 *  selection. `resetPanel()` returns an identical fresh state so the
 *  host can drop it when a project switch happens (rule 5). */
export interface PanelState {
  scope: PanelScope;
  chip: PanelChip;
  selectedId: string | null;
}

export function initialPanelState(): PanelState {
  return { scope: "inview", chip: "all", selectedId: null };
}

/** Idempotent, identity-fresh reset — reuse after a project switch to
 *  clear scope + selection + filter in one place (rule 5). */
export function resetPanel(): PanelState {
  return initialPanelState();
}

/** Overdue DURING this panel: past-due + non-terminal. `isOverdue`
 *  already excludes terminal statuses internally; the second clause is
 *  kept explicit for the spec's "Overdue = isOverdue && non-terminal". */
export function isPanelOverdue(t: PanelTask, now: number): boolean {
  return isOverdue(t, now) && isNonTerminal(t.status);
}

export interface PanelScopeOptions {
  scope: PanelScope;
  /** 3D active storey name. When provided, "In view" matches on it. */
  storeyName?: string | null;
  /** 2D active/current page. When provided, "In view" matches on it. */
  pdfPage?: number | null;
}

/** "In view" = the task's location matches the active storey (3D) or
 *  the current PDF page (2D). Tasks WITHOUT a location appear ONLY in
 *  `All`. The 2D host always passes a page; the 3D host passes the
 *  active storey — which is NULL in the default whole-model view. With
 *  no anchor (3D default view) the in-view set is every task that has
 *  a BIM location: exactly the pins the callout layer renders, so the
 *  panel never contradicts what the user can see. */
export function scopeTasks(
  rows: readonly PanelTask[],
  opts: PanelScopeOptions,
): PanelTask[] {
  const { scope, storeyName, pdfPage } = opts;
  if (scope === "all") return [...rows];

  const hasStorey = typeof storeyName === "string" && storeyName.length > 0;
  const hasPage = typeof pdfPage === "number" && Number.isInteger(pdfPage) && pdfPage >= 1;

  return rows.filter((t) => {
    const loc = t.location;
    if (!loc) return false; // no location → All only
    if (hasStorey) return loc.storeyName === storeyName;
    if (hasPage) return loc.pdf?.page === pdfPage;
    // 3D default view (no storey selected): every pinned-to-the-model
    // task is on screen — the callout layer shows all of them.
    return Boolean(loc.bim);
  });
}

export interface PanelFilterOptions {
  /** The current actor uid driving the `Mine` chip. */
  actorUid: string | null | undefined;
  /** Clock — passed in so the filter stays pure. */
  now: number;
}

/** Single-dimension filter (spec §A): Open = non-terminal, Overdue =
 *  `isPanelOverdue`, Mine = `assigneeUid === actorUid`, All = passthrough. */
export function filterTasks(
  rows: readonly PanelTask[],
  chip: PanelChip,
  opts: PanelFilterOptions,
): PanelTask[] {
  const { actorUid, now } = opts;
  switch (chip) {
    case "open":
      return rows.filter((t) => isNonTerminal(t.status));
    case "overdue":
      return rows.filter((t) => isPanelOverdue(t, now));
    case "mine":
      return rows.filter((t) => t.assigneeUid != null && t.assigneeUid === actorUid);
    default:
      return [...rows];
  }
}

export interface PanelBadge {
  /** In-scope task count — the pill's `≡ {count}`. */
  count: number;
  /** Maintainer decision 2 — a red dot when any in-scope task is overdue. */
  overdue: boolean;
}

/** The collapsed pill's badge (rule 2). Expect rows ALREADY scoped
 *  (scopeTasks output) — the pill reflects the active scope, not the
 *  filter chip (which only exists in the expanded sheet). */
export function panelBadgeState(rows: readonly PanelTask[], now: number): PanelBadge {
  return {
    count: rows.length,
    overdue: rows.some((t) => isPanelOverdue(t, now)),
  };
}

// ── pending-row merge (the SAME overlay discipline as the list) ─────

/**
 * Fold queued outbox actions into the panel rows, preserving `location`
 * so a freshly-created (pending) task still scopes "In view" correctly.
 * Mirrors `mergeTaskViews` semantics for `added`/`failed`, plus the
 * `sending` overlay only when `overlaySending` (demo has no optimistic
 * cache). A pending CREATE synthesizes a row from `createDoc`; other
 * verbs overlay status/title on the existing row.
 */
export function mergePanelTasks(
  cloud: readonly PanelTask[],
  outbox: readonly OutboxRecord[],
  overlaySending = false,
): PanelTask[] {
  const byId = new Map<string, PanelTask>(cloud.map((t) => [t.id, { ...t }]));
  const cloudUpdatedAt = new Map(cloud.map((t) => [t.id, t.updatedAt]));

  const pending = outbox
    .filter((r) => {
      const s = r.state;
      return s === "added" || s === "failed" || (overlaySending && s === "sending");
    })
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const row of pending) {
    const payload = row.payload as {
      verb?: string;
      taskId?: string;
      title?: string;
      statusTo?: number;
      at?: number;
      createDoc?: Record<string, unknown>;
    };
    const taskId = payload.taskId;
    if (!taskId) continue;
    if (payload.verb === "create") {
      const existing = byId.get(taskId);
      if (existing) continue; // already committed locally for this project
      const doc = payload.createDoc ?? {};
      byId.set(taskId, {
        id: taskId,
        num: (doc.num as number) ?? 0,
        title: payload.title ?? "(untitled)",
        status: payload.statusTo ?? 10,
        updatedAt: payload.at ?? row.createdAt,
        assigneeName: (doc.assigneeName as string) ?? null,
        assigneeUid: (doc.assigneeUid as string) ?? null,
        deadline: (doc.deadline as number) ?? null,
        createdAt: payload.at ?? row.createdAt,
        lastAction: payload.verb ?? "create",
        entryCount: 1,
        pending: true,
        failed: row.state === "failed",
        location: (doc.location as PanelLocation) ?? null,
      });
      continue;
    }
    const target = byId.get(row.resultTaskId ?? taskId);
    if (!target) continue;
    if (sendingActionLanded(row, cloudUpdatedAt.get(target.id), payload.at)) continue;
    target.status = payload.statusTo ?? target.status;
    target.lastAction = payload.verb ?? target.lastAction;
    target.updatedAt = Math.max(target.updatedAt, payload.at ?? 0);
    target.entryCount = target.entryCount + 1;
    target.pending = true;
    target.failed = row.state === "failed";
    if (payload.title) target.title = payload.title;
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}