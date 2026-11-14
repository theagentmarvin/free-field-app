// src/core/db/tables/buildings.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { BuildingRecord } from "@ff/types";

export type CreateBuildingInput = Omit<
  BuildingRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<BuildingRecord, "id" | "createdAt" | "updatedAt">>;

export async function createBuilding(
  input: CreateBuildingInput,
): Promise<BuildingRecord> {
  const now = Date.now();
  const record: BuildingRecord = {
    id: input.id ?? uuid(),
    projectId: input.projectId,
    name: input.name,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.buildings.add(record);
  return record;
}

export async function getBuilding(
  id: string,
): Promise<BuildingRecord | undefined> {
  return db.buildings.get(id);
}

export async function listBuildings(
  projectId: string,
): Promise<BuildingRecord[]> {
  return db.buildings.where("projectId").equals(projectId).toArray();
}

export async function findBuildingByName(
  projectId: string,
  name: string,
): Promise<BuildingRecord | undefined> {
  return db.buildings.where("[projectId+name]").equals([projectId, name]).first();
}

export type UpdateBuildingPatch = Partial<
  Omit<BuildingRecord, "id" | "projectId" | "createdAt">
>;

export async function updateBuilding(
  id: string,
  patch: UpdateBuildingPatch,
): Promise<void> {
  await db.buildings.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Delete a building. Cascades to its IFC files (which themselves cascade
 * to versions, storeys, blobs, and extracted storeys) and to the per-
 * building level-selection rows (Dexie v2 table).
 */
export async function deleteBuilding(id: string): Promise<void> {
  const ifcFiles = await db.ifcFiles.where("buildingId").equals(id).toArray();
  const { deleteIfcFile } = await import("./ifcFiles");
  for (const f of ifcFiles) {
    await deleteIfcFile(f.id);
  }
  await db.extractedStoreys.where("buildingId").equals(id).delete();
  // v2 cascade: drop any per-(building, level) selection rows.
  // Using a direct write here (rather than importing the v2 helper)
  // keeps the table file's dependency graph one-way: ifcFiles ->
  // ifcVersions -> ... -> buildings. The v2 table never needs to know
  // about buildings, and vice versa.
  await db.buildingLevelSelection.where("buildingId").equals(id).delete();
  await db.buildings.delete(id);
}
