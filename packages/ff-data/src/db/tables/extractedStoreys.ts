// src/core/db/tables/extractedStoreys.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { ExtractedStoreyRecord } from "@ff/types";

/**
 * Toggle the extracted state of a storey within a building. If the
 * `[buildingId+storeyId]` row exists it's updated (timestamp only when
 * matching the desired state); otherwise it's created. Uses Dexie's
 * primary-key conflict semantics so it's safe under concurrent calls.
 */
export async function setExtracted(
  buildingId: string,
  storeyId: string,
  isExtracted: boolean,
): Promise<ExtractedStoreyRecord | null> {
  if (!isExtracted) {
    await db.extractedStoreys
      .where("[buildingId+storeyId]")
      .equals([buildingId, storeyId])
      .delete();
    return null;
  }

  const existing = await db.extractedStoreys
    .where("[buildingId+storeyId]")
    .equals([buildingId, storeyId])
    .first();

  if (existing) {
    const updated: ExtractedStoreyRecord = {
      ...existing,
      updatedAt: Date.now(),
    };
    await db.extractedStoreys.put(updated);
    return updated;
  }

  const record: ExtractedStoreyRecord = {
    id: uuid(),
    buildingId,
    storeyId,
    updatedAt: Date.now(),
  };
  await db.extractedStoreys.add(record);
  return record;
}

export async function listExtracted(
  buildingId: string,
): Promise<ExtractedStoreyRecord[]> {
  return db.extractedStoreys.where("buildingId").equals(buildingId).toArray();
}

export async function deleteExtracted(
  id: string,
): Promise<void> {
  await db.extractedStoreys.delete(id);
}

export interface ExtractedStoreySyncUpdate {
  /** StoreyRecord.id. */
  levelId: string;
  isExtracted: boolean;
}

/**
 * Reconcile the building's extractedStoreys rows to match the
 * desired (levelId, isExtracted) tuples. Adds rows for tuples that
 * should be extracted and are not; deletes rows for tuples that
 * should NOT be extracted but are. Idempotent.
 *
 * Runs in a single rw transaction. Returns the counts of inserts
 * and deletes for callers that want to log/observe.
 *
 * Only acts on the tuples in `updates` — rows for levels not
 * mentioned in `updates` are left alone. Callers that want to
 * ensure a row is absent for a level must pass `isExtracted: false`
 * for it (the LevelChecklistPopover does this for every level in
 * the building, so the "additive" invariant holds end-to-end).
 */
export async function syncExtractedStoreys(
  buildingId: string,
  updates: readonly ExtractedStoreySyncUpdate[],
): Promise<{ inserted: number; deleted: number }> {
  return db.transaction("rw", db.extractedStoreys, async () => {
    // 1. Read every current row for the building. Dexie's live-query
    //    re-fires on transaction commit, so the sidebar's Mapped
    //    section will reflect the new state on the next tick.
    const current = await db.extractedStoreys
      .where("buildingId")
      .equals(buildingId)
      .toArray();

    // 2. Index current state by storeyId for O(1) lookup.
    const currentByLevel = new Map<string, ExtractedStoreyRecord>();
    for (const row of current) currentByLevel.set(row.storeyId, row);

    // 3. Compute the diff: inserts and deletes, only for the levels
    //    mentioned in `updates`.
    const toInsert: ExtractedStoreyRecord[] = [];
    const toDelete: string[] = [];
    const now = Date.now();

    for (const u of updates) {
      const existing = currentByLevel.get(u.levelId);
      if (u.isExtracted && !existing) {
        toInsert.push({
          id: uuid(),
          buildingId,
          storeyId: u.levelId,
          updatedAt: now,
        });
      } else if (!u.isExtracted && existing) {
        toDelete.push(existing.id);
      }
    }

    if (toInsert.length > 0) {
      await db.extractedStoreys.bulkAdd(toInsert);
    }
    if (toDelete.length > 0) {
      await db.extractedStoreys.bulkDelete(toDelete);
    }

    return { inserted: toInsert.length, deleted: toDelete.length };
  });
}
