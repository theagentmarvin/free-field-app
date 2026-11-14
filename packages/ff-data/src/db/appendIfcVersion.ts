// src/db/appendIfcVersion.ts
//
// THE write path of an IFC import (wave 63). Both pipeline entry
// points — loadIfc (new file, or same name re-uploaded) and
// replaceIfcVersion (explicit replace of a known file) — persist
// through this one routine, so they can't drift.
//
// Everything is written in ONE Dexie rw transaction:
//   1. resolve / create the IfcFileRecord
//   2. versionNumber = max(existing) + 1      (read INSIDE the tx, so
//      two imports of one file can't mint the same number)
//   3. the .frag blob
//   4. the IfcVersionRecord (isLatest = false for now)
//   5. drop the previous versions' storeys, insert the new ones
//   6. replace the file's property catalog
//   7. LAST: flip "latest" (old -> false, new -> true) and point
//      IfcFileRecord.currentVersionId at the new version.
// If any step throws (quota, constraint, ...) the transaction aborts
// and the database is exactly as before: no version marked latest
// without its blob / storeys / catalog.
//
// Callers build every record (the frag Blob included) BEFORE calling:
// nothing but Dexie work may run inside an IndexedDB transaction.

import type {
  IfcFileRecord,
  IfcVersionRecord,
  PropertyCatalogEntry,
  StoreyRecord,
} from "@ff/types";

import { db } from "./database";
import { toStorageError } from "./errors";
import { uuid } from "./uuid";
import { disambiguateStoreyNames } from "../ifc/storeyNames";

export interface AppendStoreyInput {
  name: string;
  elevation: number;
  expressId: number;
  height: number | null;
  containedElementIds?: number[];
}

export interface AppendIfcVersionInput {
  /** Building the file belongs to (ignored when `ifcFileId` resolves). */
  buildingId: string;
  /** File name = the version-chain key under the building. */
  fileName: string;
  /**
   * Replace path: append to this existing file (must exist). When
   * omitted the file is looked up by (buildingId, fileName) and
   * created if missing.
   */
  ifcFileId?: string;
  ifcFileSize: number;
  contentHash: string;
  fragBlob: Blob;
  storeys: AppendStoreyInput[];
  /** `fileId` on these is overwritten with the real file id. */
  propertyCatalog: Array<Omit<PropertyCatalogEntry, "fileId"> & { fileId?: string }>;
  /** Clock override (tests). */
  now?: number;
}

export interface AppendIfcVersionResult {
  file: IfcFileRecord;
  version: IfcVersionRecord;
  storeyCount: number;
  isNewFile: boolean;
}

export class IfcFileNotFoundError extends Error {
  constructor(ifcFileId: string) {
    super(`replaceIfcVersion: IfcFileRecord ${ifcFileId} not found`);
    this.name = "IfcFileNotFoundError";
  }
}

export async function appendIfcVersion(
  input: AppendIfcVersionInput,
): Promise<AppendIfcVersionResult> {
  const now = input.now ?? Date.now();
  // Unique per version (the [ifcVersionId+name] index) — the
  // extractor already does this; repeat it so no caller can trip it.
  const storeyInputs = disambiguateStoreyNames(input.storeys);
  const catalogSeen = new Set<string>();
  const catalogInputs = input.propertyCatalog.filter((e) => {
    const k = `${e.pset}\x00${e.name}`;
    if (catalogSeen.has(k)) return false;
    catalogSeen.add(k);
    return true;
  });

  try {
    return await db.transaction(
      "rw",
      [db.ifcFiles, db.ifcVersions, db.storeys, db.propertyCatalog, db.fragBlobs],
      async () => {
        // 1. File row.
        let file: IfcFileRecord | undefined;
        if (input.ifcFileId) {
          file = await db.ifcFiles.get(input.ifcFileId);
          if (!file) throw new IfcFileNotFoundError(input.ifcFileId);
        } else {
          file = await db.ifcFiles
            .where("[buildingId+name]")
            .equals([input.buildingId, input.fileName])
            .first();
        }
        const isNewFile = !file;
        if (!file) {
          file = {
            id: uuid(),
            buildingId: input.buildingId,
            name: input.fileName,
            currentVersionId: "",
            createdAt: now,
            updatedAt: now,
          };
          await db.ifcFiles.add(file);
        }
        const fileId = file.id;

        // 2. Version number, read inside the transaction.
        const previous = await db.ifcVersions
          .where("ifcFileId")
          .equals(fileId)
          .toArray();
        const versionNumber =
          previous.reduce((m, v) => Math.max(m, v.versionNumber), 0) + 1;
        const versionId = uuid();
        const fragBlobKey = `${fileId}__v${versionNumber}`;

        // 3. Blob.
        await db.fragBlobs.put({ key: fragBlobKey, blob: input.fragBlob });

        // 4. Version row, not latest yet.
        const version: IfcVersionRecord = {
          id: versionId,
          ifcFileId: fileId,
          versionNumber,
          ifcFileSize: input.ifcFileSize,
          contentHash: input.contentHash,
          fragBlobKey,
          storeyCount: storeyInputs.length,
          isLatest: false,
          createdAt: now,
        };
        await db.ifcVersions.add(version);

        // 5. Storeys: the previous versions' rows go (history is never
        // re-loaded; keeping them would duplicate levels in the
        // building-level aggregation), the new version's rows come in.
        const previousIds = previous.map((v) => v.id);
        if (previousIds.length > 0) {
          await db.storeys.where("ifcVersionId").anyOf(previousIds).delete();
        }
        if (storeyInputs.length > 0) {
          const rows: StoreyRecord[] = storeyInputs.map((s) => ({
            id: uuid(),
            buildingId: file!.buildingId,
            ifcVersionId: versionId,
            sourceIfcFileId: fileId,
            name: s.name,
            elevation: s.elevation,
            expressId: s.expressId,
            height: s.height,
            containedElementIds: s.containedElementIds ?? [],
          }));
          await db.storeys.bulkAdd(rows);
        }

        // 6. Property catalog: keyed by fileId, always the latest
        // version's (pset, name) pairs.
        await db.propertyCatalog.where({ fileId }).delete();
        if (catalogInputs.length > 0) {
          await db.propertyCatalog.bulkAdd(
            catalogInputs.map((e) => ({ fileId, pset: e.pset, name: e.name })),
          );
        }

        // 7. Latest flag LAST.
        for (const v of previous) {
          if (v.isLatest) await db.ifcVersions.update(v.id, { isLatest: false });
        }
        await db.ifcVersions.update(versionId, { isLatest: true });
        version.isLatest = true;
        const updatedFile: IfcFileRecord = {
          ...file,
          currentVersionId: versionId,
          updatedAt: now,
        };
        await db.ifcFiles.put(updatedFile);

        return {
          file: updatedFile,
          version,
          storeyCount: storeyInputs.length,
          isNewFile,
        };
      },
    );
  } catch (e) {
    throw toStorageError(e);
  }
}
