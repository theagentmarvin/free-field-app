import { useLiveQuery } from "dexie-react-hooks";
import type { OutboxRecord } from "@ff/types";
import { db as localDb } from "@ff/data/db/database";
import { ACTIVE_OUTBOX_STATES } from "@ff/tasks";

/**
 * The outbox rows a task view overlays: active states only (queued,
 * in flight, failed) for one project. Wave 63 — the five views used to
 * live-query the WHOLE table (every sent and killed row ever), so it
 * grew without bound and each one re-read all of it on every write.
 * Uses the `state` index; the project filter runs on the small result.
 */
export function queryActiveOutboxRows(projectId: string | undefined): Promise<OutboxRecord[]> {
  if (!projectId) return Promise.resolve([]); // no project: no read
  return localDb.outbox
    .where("state")
    .anyOf(ACTIVE_OUTBOX_STATES as string[])
    .toArray()
    .then((rows) => rows.filter((r) => r.projectId === projectId));
}

const EMPTY: OutboxRecord[] = [];

export function useOutboxRows(projectId: string | undefined): OutboxRecord[] {
  return useLiveQuery(() => queryActiveOutboxRows(projectId), [projectId]) ?? EMPTY;
}
