/** Persistent sync bookkeeping (Dexie `syncState`, local only). */

import type { ProjectDatabase, SyncStateRecord } from "@ff/data/db/database";

import type { SyncCollectionName } from "./types";

export type PublishState = NonNullable<SyncStateRecord["publishState"]>;

export const cursorKey = (projectId: string, collection: SyncCollectionName): string =>
  `cursor:${projectId}:${collection}`;
export const publishKey = (projectId: string): string => `publish:${projectId}`;

export async function getCursor(
  db: ProjectDatabase,
  projectId: string,
  collection: SyncCollectionName,
): Promise<number | null> {
  const row = await db.syncState.get(cursorKey(projectId, collection));
  return row?.cursorMs ?? null;
}

export async function getPublishState(
  db: ProjectDatabase,
  projectId: string,
): Promise<{ state: PublishState; armedAt: number } | null> {
  const row = await db.syncState.get(publishKey(projectId));
  if (!row?.publishState) return null;
  return { state: row.publishState, armedAt: row.armedAt ?? 0 };
}

export async function setPublishState(
  db: ProjectDatabase,
  projectId: string,
  state: PublishState,
  armedAt: number,
): Promise<void> {
  await db.syncState.put({ key: publishKey(projectId), projectId, publishState: state, armedAt });
}

/** Forget cursors (forces a full re-read on the next start). */
export async function resetCursors(db: ProjectDatabase, projectId: string): Promise<void> {
  const rows = await db.syncState.where("projectId").equals(projectId).toArray();
  await db.syncState.bulkDelete(
    rows.filter((r) => r.key.startsWith("cursor:")).map((r) => r.key),
  );
}
