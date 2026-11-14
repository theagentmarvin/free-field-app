// src/core/db/tables/ifcFiles.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { IfcFileRecord } from "@ff/types";

export type CreateIfcFileInput = Omit<
  IfcFileRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<IfcFileRecord, "id" | "createdAt" | "updatedAt">>;

/**
 * Insert a new IFC file row. If a row with the same `[buildingId+name]`
 * already exists this will throw (the compound index is unique). Use
 * `findIfcFileByName` first if you want upsert behavior — that's how
 * the pipeline detects "same filename → new version" vs "new file".
 */
export async function createIfcFile(
  input: CreateIfcFileInput,
): Promise<IfcFileRecord> {
  const now = Date.now();
  const record: IfcFileRecord = {
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    name: input.name,
    currentVersionId: input.currentVersionId,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.ifcFiles.add(record);
  return record;
}

export async function getIfcFile(
  id: string,
): Promise<IfcFileRecord | undefined> {
  return db.ifcFiles.get(id);
}

export async function listIfcFiles(buildingId: string): Promise<IfcFileRecord[]> {
  return db.ifcFiles.where("buildingId").equals(buildingId).toArray();
}

/**
 * Find the IfcFileRecord that represents the version chain for a given
 * filename under a building. Returns undefined if no chain exists yet.
 */
export async function findIfcFileByName(
  buildingId: string,
  name: string,
): Promise<IfcFileRecord | undefined> {
  return db.ifcFiles
    .where("[buildingId+name]")
    .equals([buildingId, name])
    .first();
}

export type UpdateIfcFilePatch = Partial<
  Omit<IfcFileRecord, "id" | "buildingId" | "name" | "createdAt">
>;

export async function updateIfcFile(
  id: string,
  patch: UpdateIfcFilePatch,
): Promise<void> {
  await db.ifcFiles.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Delete an IFC file. ONE rw transaction (all-or-nothing) cascading to:
 *  - all IfcVersionRecord rows for this file
 *  - the fragBlobs referenced by those versions
 *  - all StoreyRecord rows that came from those versions
 *  - all ExtractedStoreyRecord rows that reference those storeys
 *  - the file's property catalog rows
 * A missing id is a no-op.
 */
export async function deleteIfcFile(id: string): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.ifcFiles,
      db.ifcVersions,
      db.storeys,
      db.extractedStoreys,
      db.fragBlobs,
      db.propertyCatalog,
    ],
    async () => {
      const versions = await db.ifcVersions.where("ifcFileId").equals(id).toArray();
      const versionIds = versions.map((v) => v.id);
      if (versionIds.length > 0) {
        const storeyIds = await db.storeys
          .where("ifcVersionId")
          .anyOf(versionIds)
          .primaryKeys();
        if (storeyIds.length > 0) {
          await db.extractedStoreys.where("storeyId").anyOf(storeyIds).delete();
          await db.storeys.bulkDelete(storeyIds);
        }
        await db.fragBlobs.bulkDelete(versions.map((v) => v.fragBlobKey));
        await db.ifcVersions.bulkDelete(versionIds);
      }
      await db.propertyCatalog.where({ fileId: id }).delete();
      await db.ifcFiles.delete(id);
    },
  );
}
