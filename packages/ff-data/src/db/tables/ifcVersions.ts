// src/core/db/tables/ifcVersions.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { IfcVersionRecord } from "@ff/types";

export type CreateIfcVersionInput = Omit<IfcVersionRecord, "id" | "createdAt"> &
  Partial<Pick<IfcVersionRecord, "id" | "createdAt">>;

/**
 * Insert a new IfcVersionRecord. Caller is responsible for keeping the
 * "exactly one latest per ifcFileId" invariant; use `setAsLatest` for that.
 */
export async function createIfcVersion(
  input: CreateIfcVersionInput,
): Promise<IfcVersionRecord> {
  const record: IfcVersionRecord = {
    id: input.id ?? uuid(),
    ifcFileId: input.ifcFileId,
    versionNumber: input.versionNumber,
    ifcFileSize: input.ifcFileSize,
    contentHash: input.contentHash,
    fragBlobKey: input.fragBlobKey,
    storeyCount: input.storeyCount,
    isLatest: input.isLatest,
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.ifcVersions.add(record);
  return record;
}

export async function getIfcVersion(
  id: string,
): Promise<IfcVersionRecord | undefined> {
  return db.ifcVersions.get(id);
}

export async function listVersions(
  ifcFileId: string,
): Promise<IfcVersionRecord[]> {
  return db.ifcVersions
    .where("ifcFileId")
    .equals(ifcFileId)
    .sortBy("versionNumber");
}

export async function getLatestVersion(
  ifcFileId: string,
): Promise<IfcVersionRecord | undefined> {
  const all = await db.ifcVersions.where("ifcFileId").equals(ifcFileId).toArray();
  return all.find((v) => v.isLatest);
}

/**
 * Atomically (within one Dexie transaction) mark `versionId` as the
 * latest for its ifcFileId and clear the flag on the previous latest.
 * Also updates the parent IfcFileRecord.currentVersionId pointer.
 */
export async function setAsLatest(versionId: string): Promise<void> {
  await db.transaction("rw", db.ifcVersions, db.ifcFiles, async () => {
    const target = await db.ifcVersions.get(versionId);
    if (!target) throw new Error(`IfcVersionRecord not found: ${versionId}`);

    const siblings = await db.ifcVersions
      .where("ifcFileId")
      .equals(target.ifcFileId)
      .toArray();
    for (const s of siblings) {
      if (s.id === versionId) continue;
      if (s.isLatest) {
        await db.ifcVersions.update(s.id, { isLatest: false });
      }
    }
    if (!target.isLatest) {
      await db.ifcVersions.update(versionId, { isLatest: true });
    }
    await db.ifcFiles.update(target.ifcFileId, {
      currentVersionId: versionId,
      updatedAt: Date.now(),
    });
  });
}

/**
 * Delete a single version. Cascades to its StoreyRecords and its fragBlob.
 * If the deleted version was the latest, promotes the previous version
 * (by versionNumber desc) to latest and updates the parent pointer.
 */
export async function deleteIfcVersion(id: string): Promise<void> {
  const version = await db.ifcVersions.get(id);
  if (!version) return;

  await db.transaction(
    "rw",
    [db.ifcVersions, db.ifcFiles, db.storeys, db.fragBlobs, db.extractedStoreys],
    async () => {
      // Delete storeys that came from this version (and any extracted rows).
      const storeys = await db.storeys
        .where("ifcVersionId")
        .equals(id)
        .toArray();
      const storeyIds = new Set(storeys.map((s) => s.id));
      if (storeyIds.size > 0) {
        await db.extractedStoreys
          .where("storeyId")
          .anyOf([...storeyIds])
          .delete();
        await db.storeys.where("ifcVersionId").equals(id).delete();
      }
      // Delete the frag blob.
      await db.fragBlobs.delete(version.fragBlobKey);
      // Delete the version itself.
      await db.ifcVersions.delete(id);

      // Re-point the parent ifcFile if needed.
      if (version.isLatest) {
        const remaining = await db.ifcVersions
          .where("ifcFileId")
          .equals(version.ifcFileId)
          .toArray();
        const next = remaining.sort((a, b) => b.versionNumber - a.versionNumber)[0];
        if (next) {
          await db.ifcVersions.update(next.id, { isLatest: true });
          await db.ifcFiles.update(version.ifcFileId, {
            currentVersionId: next.id,
            updatedAt: Date.now(),
          });
        } else {
          // No versions left — clear the pointer.
          await db.ifcFiles.update(version.ifcFileId, {
            currentVersionId: "",
            updatedAt: Date.now(),
          });
        }
      }
    },
  );
}
