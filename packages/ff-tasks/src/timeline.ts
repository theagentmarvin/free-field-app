import type { TaskEntry } from '@ff/firestore';
import type { OutboxRecord } from '@ff/types';

import type { TaskActionPayload } from './action';

/**
 * Timeline assembly (plan §7 screen 3, §2.3). The cloud subcollection
 * is the truth feed; queued `added`/`failed` action rows for the same
 * task overlay as pending entries — D5 suppression again: `sending`
 * rows are ALREADY in Firestore's optimistic local cache the moment
 * the transaction hits the wire, so overlaying them would double-render.
 *
 * A pending row is also skipped when a committed cloud entry already
 * carries its clientGuid — the entry doc id IS the clientGuid, so
 * dedupe is exact, not fuzzy.
 */

export interface TaskEntryView extends TaskEntry {
  /** rendered half-alpha with a ⋯ marker (§4) */
  pending: boolean;
  /** rendered with the red ⚠ badge + retry affordance (§4) */
  failed: boolean;
}

export function mergeTaskEntries(
  cloud: readonly TaskEntry[],
  rows: readonly OutboxRecord[],
  taskId: string,
  overlaySending = false,
): TaskEntryView[] {
  const out: TaskEntryView[] = cloud.map((e) => ({ ...e, pending: false, failed: false }));
  const seen = new Set(cloud.map((e) => e.clientGuid));
  for (const row of rows) {
    const isPending =
      row.state === "added" || row.state === "failed" || (overlaySending && row.state === "sending");
    if (!isPending) continue;
    const p = row.payload as unknown as TaskActionPayload;
    if (!p || p.taskId !== taskId || seen.has(p.clientGuid)) continue;
    out.push({
      id: p.clientGuid,
      action: p.verb,
      text: p.text ?? "",
      by: p.actor?.name ?? "?",
      byUid: p.actor?.uid ?? "",
      at: p.at,
      statusFrom: p.statusFrom ?? null,
      statusTo: p.statusTo ?? null,
      photos: [],
      clientGuid: p.clientGuid,
      pending: true,
      failed: row.state === "failed",
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The outbox-management sheet's feed (§7 screen 4): live rows only. */
export function outboxSheetRows(rows: readonly OutboxRecord[]): OutboxRecord[] {
  return rows
    .filter((r) => r.state === "added" || r.state === "sending" || r.state === "failed")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Optimistic display status: the newest queued action wins over the
 *  committed doc until the engine lands (§4), same rule as mergeTaskViews. */
export function displayStatus(
  committedStatus: number | null,
  views: readonly TaskEntryView[]
): number | null {
  for (let i = views.length - 1; i >= 0; i--) {
    const v = views[i];
    if (v.pending && v.statusTo !== null) return v.statusTo;
  }
  return committedStatus;
}
