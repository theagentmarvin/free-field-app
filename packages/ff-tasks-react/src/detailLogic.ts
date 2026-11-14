import type { TaskVerb } from "@ff/tasks";

import { STATUS_LABELS } from "./logic";

/**
 * Pure UI pieces for the detail sheet (plan §7 screen 3). Kept
 * firebase-free and React-free so the action bar's state-machine
 * wiring is unit-testable like everything else in this package.
 */

export const VERB_ICONS: Record<TaskVerb, string> = {
  create: "📌",
  comment: "💬",
  edit: "✏️",
  assign: "👤",
  complete: "✅",
  reject: "↩️",
  approve: "✔️",
  followup: "🔁",
  discontinue: "⛔",
};

export const VERB_LABELS: Record<TaskVerb, string> = {
  create: "created",
  comment: "commented",
  edit: "edited",
  assign: "assigned",
  complete: "submitted for approval",
  reject: "returned to work",
  approve: "approved",
  followup: "approved · follow-up",
  discontinue: "discontinued",
};

/** Verb → button label for the action bar (transition verbs only). */
export const ACTION_LABELS: Record<string, string> = {
  complete: "✅ Complete",
  reject: "↩️ Reject",
  approve: "✔️ Approve",
  followup: "🔁 Follow-up",
  discontinue: "⛔ Discontinue",
};

export const ACTION_BAR_VERBS: readonly TaskVerb[] = [
  "complete",
  "reject",
  "approve",
  "followup",
  "discontinue",
];

/** "Ongoing → Awaiting approval" for a status-changing entry; null for
 *  self-pairs (comment/edit) and for `create` (null → 10). */
export function transitionBadge(
  from: number | null,
  to: number | null
): string | null {
  if (from === null || to === null || from === to) return null;
  const a = STATUS_LABELS[from];
  const b = STATUS_LABELS[to];
  if (!a || !b) return null;
  return `${a} → ${b}`;
}

/** The action-bar verbs legal for a status, in fixed display order. */
export function barVerbsFor(
  status: number,
  isLegal: (verb: TaskVerb, from: number) => boolean
): TaskVerb[] {
  return ACTION_BAR_VERBS.filter((v) => isLegal(v, status));
}

/** Latest timeline entry's actor — the detail sheet's "Updated by" cell
 *  (the Host already holds the merged entries; no DB round-trip).
 *  Returns null when there are no entries so the UI omits the line
 *  instead of faking a name. */
export function latestEntryActor(
  entries: readonly { by?: string | null }[]
): string | null {
  if (entries.length === 0) return null;
  const by = entries[entries.length - 1].by;
  return by && by.trim() ? by.trim() : null;
}

/** Activity clock-badge count: every rendered timeline entry.
 *  `mergeTaskEntries` already folds queued/failed rows into the same
 *  list, so this is the full conversation length the badge reports. */
export function activityCount(entries: readonly { clientGuid: string }[]): number {
  return entries.length;
}
