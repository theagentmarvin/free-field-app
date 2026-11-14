// src/core/db/tables/buildingLevelSelection.ts
//
// CRUD for the BuildingLevelSelectionRecord table added in Dexie v2.
// See docs/TASK-3-UI.md "Data model additions" and
// src/hooks/useLevelSelection.ts for the live-query consumer.
//
// The key invariant from the spec:
//   "buildingLevelSelection defaults to all-checked for any (building,
//    level) pair the user hasn't explicitly unchecked. If no record
//    exists for a (building, level), treat as selected = true."
//
// These helpers don't enforce or interpret that invariant — they just
// store / load the explicit rows. The consumer (`getEffectiveSelection`)
// layers the default-checked semantic on top.

import { db } from "../database";
import type { BuildingLevelSelectionRecord } from "@ff/types";

export type CreateBuildingLevelSelectionInput = Omit<
  BuildingLevelSelectionRecord,
  "updatedAt"
> &
  Partial<Pick<BuildingLevelSelectionRecord, "updatedAt">>;

/**
 * Upsert a single (building, level) selection row. The Dexie table
 * declares `[buildingId+levelId]` as its primary key, so a `put` is
 * idempotent: calling it twice with the same key updates the row in
 * place rather than creating a duplicate.
 */
export async function putBuildingLevelSelection(
  input: CreateBuildingLevelSelectionInput,
): Promise<BuildingLevelSelectionRecord> {
  const record: BuildingLevelSelectionRecord = {
    buildingId: input.buildingId,
    levelId: input.levelId,
    selected: input.selected,
    updatedAt: input.updatedAt ?? Date.now(),
  };
  await db.buildingLevelSelection.put(record);
  return record;
}

/** Bulk upsert of many (building, level, selected) tuples. */
export async function putBuildingLevelSelections(
  rows: CreateBuildingLevelSelectionInput[],
): Promise<BuildingLevelSelectionRecord[]> {
  const now = Date.now();
  const records: BuildingLevelSelectionRecord[] = rows.map((r) => ({
    buildingId: r.buildingId,
    levelId: r.levelId,
    selected: r.selected,
    updatedAt: r.updatedAt ?? now,
  }));
  await db.buildingLevelSelection.bulkPut(records);
  return records;
}

/** Read every explicit row for a building. */
export async function listBuildingLevelSelections(
  buildingId: string,
): Promise<BuildingLevelSelectionRecord[]> {
  return db.buildingLevelSelection
    .where("buildingId")
    .equals(buildingId)
    .toArray();
}

/** Read a single explicit (building, level) row, if any. */
export async function getBuildingLevelSelection(
  buildingId: string,
  levelId: string,
): Promise<BuildingLevelSelectionRecord | undefined> {
  return db.buildingLevelSelection.get([buildingId, levelId]);
}

/** Delete every selection row for a building. Used by the building-delete cascade. */
export async function deleteBuildingLevelSelections(
  buildingId: string,
): Promise<number> {
  return db.buildingLevelSelection.where("buildingId").equals(buildingId).delete();
}
