// src/core/db/tables/pdfFolderAssignments.ts
//
// CRUD for the v8 `pdfFolderAssignments` join table. One row
// per (pdfFileId → folderId) placement, with `pdfFileId` as a
// unique single-field index so the DB itself enforces
// one-folder-per-PDF semantics.
//
// Why a join table (not a `pdfFiles.folderId` column):
//   - A folder can carry metadata (color, future icon, future
//     permissions) without bloating every pdfFiles row.
//   - The cascade on delete-folder is "drop the assignments,
//     leave the PDFs" — cleaner than "set folderId=null on every
//     PDF".
//   - A future migration to many-to-many would just drop the
//     unique constraint on `pdfFileId`. With a column, you'd
//     need a schema change + data migration.
//
// See docs/task-20f-pdf-folders.md §"Data layer" for the schema
// rationale.

import { db } from "../database";
import { uuid } from "../uuid";
import type { PdfFolderAssignmentRecord } from "@ff/types";

export type CreatePdfFolderAssignmentInput = Omit<
  PdfFolderAssignmentRecord,
  "id" | "createdAt"
> &
  Partial<
    Pick<PdfFolderAssignmentRecord, "id" | "createdAt">
  >;

/**
 * Insert a new assignment. Throws if a row already exists for
 * the given `pdfFileId` (the unique index on `pdfFileId`
 * enforces one-folder-per-PDF). Use `setAssignmentForPdf` for
 * the create-or-replace pattern.
 */
export async function createPdfFolderAssignment(
  input: CreatePdfFolderAssignmentInput,
): Promise<PdfFolderAssignmentRecord> {
  const record: PdfFolderAssignmentRecord = {
    id: input.id ?? uuid(),
    pdfFileId: input.pdfFileId,
    folderId: input.folderId,
    createdAt: input.createdAt ?? Date.now(),
  };
  await db.pdfFolderAssignments.add(record);
  return record;
}

export async function getPdfFolderAssignment(
  id: string,
): Promise<PdfFolderAssignmentRecord | undefined> {
  return db.pdfFolderAssignments.get(id);
}

/**
 * Look up the single assignment for a PDF (or undefined if the
 * PDF is currently Unfiled). Uses the unique `pdfFileId` index
 * for a single-row fetch.
 */
export async function getAssignmentForPdf(
  pdfFileId: string,
): Promise<PdfFolderAssignmentRecord | undefined> {
  return db.pdfFolderAssignments.where("pdfFileId").equals(pdfFileId).first();
}

/**
 * All assignments whose folder matches one of the given folder
 * ids. Used by the Folders sidebar to list PDFs that live in
 * each folder.
 */
export async function listAssignmentsForFolders(
  folderIds: string[],
): Promise<PdfFolderAssignmentRecord[]> {
  if (folderIds.length === 0) return [];
  return db.pdfFolderAssignments
    .where("folderId")
    .anyOf(folderIds)
    .toArray();
}

/**
 * Create-or-replace: assign `pdfFileId` to `folderId`. If a
 * prior assignment exists for this PDF, it is removed first
 * (transactional). Returns the new assignment row.
 *
 * Pass `null` for `folderId` to un-file a PDF.
 */
export async function setAssignmentForPdf(
  pdfFileId: string,
  folderId: string | null,
): Promise<PdfFolderAssignmentRecord | null> {
  return db.transaction("rw", db.pdfFolderAssignments, async () => {
    const existing = await db.pdfFolderAssignments
      .where("pdfFileId")
      .equals(pdfFileId)
      .first();
    if (existing) {
      await db.pdfFolderAssignments.delete(existing.id);
    }
    if (folderId === null) {
      return null;
    }
    const record: PdfFolderAssignmentRecord = {
      id: uuid(),
      pdfFileId,
      folderId,
      createdAt: Date.now(),
    };
    await db.pdfFolderAssignments.add(record);
    return record;
  });
}

/**
 * Delete the assignment for a PDF (PDF becomes Unfiled). No-op
 * if no assignment exists.
 */
export async function clearAssignmentForPdf(pdfFileId: string): Promise<void> {
  await db.pdfFolderAssignments.where("pdfFileId").equals(pdfFileId).delete();
}

/**
 * Cascade helper — delete every assignment for a PDF. Wired
 * into `deletePdfFile` so removing a PDF also un-files it.
 */
export async function deleteAssignmentsForPdf(pdfFileId: string): Promise<void> {
  await db.pdfFolderAssignments.where("pdfFileId").equals(pdfFileId).delete();
}