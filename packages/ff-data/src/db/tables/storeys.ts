// src/core/db/tables/storeys.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { StoreyRecord } from "@ff/types";

export type CreateStoreyInput = Omit<
  StoreyRecord,
  "id" | "containedElementIds"
> &
  Partial<Pick<StoreyRecord, "id" | "containedElementIds">>;

export async function createStorey(
  input: CreateStoreyInput,
): Promise<StoreyRecord> {
  const record: StoreyRecord = {
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    ifcVersionId: input.ifcVersionId,
    sourceIfcFileId: input.sourceIfcFileId,
    name: input.name,
    elevation: input.elevation,
    expressId: input.expressId,
    height: input.height,
    containedElementIds: input.containedElementIds ?? [],
  };
  await db.storeys.add(record);
  return record;
}

export async function createStoreys(
  inputs: CreateStoreyInput[],
): Promise<StoreyRecord[]> {
  const records: StoreyRecord[] = inputs.map((input) => ({
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    ifcVersionId: input.ifcVersionId,
    sourceIfcFileId: input.sourceIfcFileId,
    name: input.name,
    elevation: input.elevation,
    expressId: input.expressId,
    height: input.height,
    containedElementIds: input.containedElementIds ?? [],
  }));
  await db.storeys.bulkAdd(records);
  return records;
}

export async function getStorey(id: string): Promise<StoreyRecord | undefined> {
  return db.storeys.get(id);
}

export async function listStoreys(buildingId: string): Promise<StoreyRecord[]> {
  return db.storeys.where("buildingId").equals(buildingId).toArray();
}

export async function listStoreysByVersion(
  ifcVersionId: string,
): Promise<StoreyRecord[]> {
  return db.storeys.where("ifcVersionId").equals(ifcVersionId).toArray();
}

export async function deleteStoreysByVersion(
  ifcVersionId: string,
): Promise<number> {
  return db.storeys.where("ifcVersionId").equals(ifcVersionId).delete();
}
