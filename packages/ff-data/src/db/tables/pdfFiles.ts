// src/core/db/tables/pdfFiles.ts
//
// CRUD for `pdfFiles` — the logical "one row per (buildingId, name)"
// row that owns a version chain. Mirrors `ifcFiles.ts` exactly:
// same function names, same return types, same cascade shape. The
// pipeline is the only consumer (see `src/hooks/usePdfPipeline.ts`).
//
// See docs/TASK-11-PDF-CANVAS.md "CRUD tables" for the contract.

import { db } from "../database";
import { uuid } from "../uuid";
import type { PdfFileRecord } from "@ff/types";

export type CreatePdfFileInput = Omit<
  PdfFileRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<PdfFileRecord, "id" | "createdAt" | "updatedAt">>;

/**
 * Insert a new PdfFileRecord row. If a row with the same
 * `[buildingId+name]` already exists this will throw (the compound
 * index is unique). Use `findPdfFileByName` first if you want
 * upsert behavior — that's how the pipeline detects "same filename
 * → new version" vs "new file".
 */
export async function createPdfFile(
  input: CreatePdfFileInput,
): Promise<PdfFileRecord> {
  const now = Date.now();
  const record: PdfFileRecord = {
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    name: input.name,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.pdfFiles.add(record);
  return record;
}

export async function getPdfFile(
  id: string,
): Promise<PdfFileRecord | undefined> {
  return db.pdfFiles.get(id);
}

export async function listPdfFiles(buildingId: string): Promise<PdfFileRecord[]> {
  return db.pdfFiles.where("buildingId").equals(buildingId).toArray();
}

/**
 * Find the PdfFileRecord that represents the version chain for a
 * given filename under a building. Returns undefined if no chain
 * exists yet.
 */
export async function findPdfFileByName(
  buildingId: string,
  name: string,
): Promise<PdfFileRecord | undefined> {
  return db.pdfFiles
    .where("[buildingId+name]")
    .equals([buildingId, name])
    .first();
}

export type UpdatePdfFilePatch = Partial<
  Omit<PdfFileRecord, "id" | "buildingId" | "name" | "createdAt">
>;

export async function updatePdfFile(
  id: string,
  patch: UpdatePdfFilePatch,
): Promise<void> {
  await db.pdfFiles.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Delete a PDF file. ONE rw transaction (all-or-nothing) cascading to:
 *  - all PdfVersionRecord rows for this file
 *  - the pdfBlobs referenced by those versions
 *  - its calibrations (one row per (pdfFileId, storeyName); Task 12a)
 *  - its folder assignment (unique per pdfFileId; Task 20F)
 *
 * Mirrors `deleteIfcFile` but PDF versions have no downstream rows
 * (no storeys, no extracted rows) so the cascade is one hop shorter.
 * A missing id is a no-op.
 */
export async function deletePdfFile(id: string): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.pdfFiles,
      db.pdfVersions,
      db.pdfBlobs,
      db.calibrations,
      db.pdfFolderAssignments,
    ],
    async () => {
      const versions = await db.pdfVersions.where("pdfFileId").equals(id).toArray();
      if (versions.length > 0) {
        await db.pdfBlobs.bulkDelete(versions.map((v) => v.blobKey));
        await db.pdfVersions.bulkDelete(versions.map((v) => v.id));
      }
      await db.calibrations.where("pdfFileId").equals(id).delete();
      await db.pdfFolderAssignments.where("pdfFileId").equals(id).delete();
      await db.pdfFiles.delete(id);
    },
  );
}
