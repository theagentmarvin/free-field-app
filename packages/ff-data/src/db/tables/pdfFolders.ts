// src/core/db/tables/pdfFolders.ts
//
// CRUD for the v8 `pdfFolders` table. One row per user-defined
// folder, scoped to a project, nestable via `parentId`. Mirrors
// the patterns from `filterPresets.ts` (pure functions, no React,
// no live-query logic — the live-query hooks live in
// `src/hooks/usePdfFolders.ts`).
//
// Cascade policy:
//   - deleteFolder(id) → cascade-deletes all PdfFolderAssignment
//     rows pointing at the folder (PDFs become "Unfiled")
//   - Renaming a folder does NOT touch any other table — the
//     join table stores folderId, not folderName.
//
// See docs/task-20f-pdf-folders.md §"Data layer" for the schema
// rationale and index choices.

import { db } from "../database";
import { uuid } from "../uuid";
import type { PdfFolderRecord } from "@ff/types";

export type CreatePdfFolderInput = Omit<
  PdfFolderRecord,
  "id" | "createdAt" | "updatedAt" | "color" | "parentId"
> &
  Partial<
    Pick<
      PdfFolderRecord,
      "id" | "createdAt" | "updatedAt" | "color" | "parentId"
    >
  >;

/** The set of color tokens a folder chip may wear. v1 is a fixed
 *  palette so the CSS side stays trivial. Add more here if/when
 *  the user-picker lands. */
export const PDF_FOLDER_COLORS = [
  "blue",
  "green",
  "amber",
  "rose",
  "violet",
  "slate",
] as const;
export type PdfFolderColor = (typeof PDF_FOLDER_COLORS)[number];

const DEFAULT_COLOR: PdfFolderColor = "blue";

/**
 * Insert a new PdfFolderRecord row. If a row with the same
 * `[projectId+name]` already exists in the same parent (or
 * root), this will throw — use `findFolderByName` first if you
 * want upsert behavior. The `[projectId+name]` uniqueness
 * constraint catches accidental duplicate creations.
 */
export async function createPdfFolder(
  input: CreatePdfFolderInput,
): Promise<PdfFolderRecord> {
  const now = Date.now();
  const record: PdfFolderRecord = {
    id: input.id ?? uuid(),
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    name: input.name,
    color: input.color ?? DEFAULT_COLOR,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.pdfFolders.add(record);
  return record;
}

export async function getPdfFolder(
  id: string,
): Promise<PdfFolderRecord | undefined> {
  return db.pdfFolders.get(id);
}

/**
 * List folders for a project, ordered by name ascending. The
 * tree is built by the live-query hook from this flat list —
 * the table does not store tree structure, only `parentId`.
 */
export async function listPdfFolders(
  projectId: string,
): Promise<PdfFolderRecord[]> {
  const rows = await db.pdfFolders.where("projectId").equals(projectId).toArray();
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/**
 * Find a folder by (projectId, parentId, name). Used by the
 * create flow to surface a friendly error before letting the
 * insert happen — the schema does not enforce uniqueness for
 * compound keys whose parts can be null (see database.ts v8
 * notes). Caller passes `parentId === null` to match a root
 * folder.
 */
export async function findPdfFolderByName(
  projectId: string,
  name: string,
  parentId: string | null,
): Promise<PdfFolderRecord | undefined> {
  const candidates = await db.pdfFolders
    .where("projectId")
    .equals(projectId)
    .toArray();
  return candidates.find(
    (f) => f.name === name && f.parentId === parentId,
  );
}

export type UpdatePdfFolderPatch = Partial<
  Omit<
    PdfFolderRecord,
    "id" | "projectId" | "createdAt"
  >
>;

/**
 * Update a folder by id. Stamps `updatedAt` automatically.
 * Renaming is safe: the join table holds `folderId`, not name.
 */
export async function updatePdfFolder(
  id: string,
  patch: UpdatePdfFolderPatch,
): Promise<void> {
  await db.pdfFolders.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Delete a folder. Cascades to:
 *   - every PdfFolderAssignment row pointing at this folder
 *     (PDFs become "Unfiled")
 *   - every child folder whose `parentId === id` is recursively
 *     deleted (so deleting a folder also takes its subtree).
 *     Children also have their assignments cascaded.
 */
export async function deletePdfFolder(id: string): Promise<void> {
  await db.transaction("rw", db.pdfFolders, db.pdfFolderAssignments, async () => {
    // 1) remove all assignments pointing at this folder.
    await db.pdfFolderAssignments.where("folderId").equals(id).delete();

    // 2) find every descendant folder (BFS over parentId).
    const allInProject = await db.pdfFolders.toArray();
    const childrenOf = (parentId: string): PdfFolderRecord[] =>
      allInProject.filter((f) => f.parentId === parentId);

    const toDelete = new Set<string>([id]);
    const queue: string[] = [id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf(current)) {
        if (!toDelete.has(child.id)) {
          toDelete.add(child.id);
          queue.push(child.id);
        }
      }
    }

    // 3) cascade-delete assignments for every descendant folder.
    if (toDelete.size > 1) {
      await db.pdfFolderAssignments
        .where("folderId")
        .anyOf(Array.from(toDelete))
        .delete();
    }

    // 4) remove the folder rows themselves.
    await db.pdfFolders.where("id").anyOf(Array.from(toDelete)).delete();
  });
}

/**
 * Cascade helper — delete every folder for a project. Called
 * when the project itself is deleted. Not yet wired to a
 * project-deletion action; exists for future use.
 */
export async function deletePdfFoldersForProject(
  projectId: string,
): Promise<void> {
  await db.transaction("rw", db.pdfFolders, db.pdfFolderAssignments, async () => {
    const folders = await db.pdfFolders
      .where("projectId")
      .equals(projectId)
      .toArray();
    const folderIds = folders.map((f) => f.id);
    if (folderIds.length === 0) return;
    await db.pdfFolderAssignments
      .where("folderId")
      .anyOf(folderIds)
      .delete();
    await db.pdfFolders.where("id").anyOf(folderIds).delete();
  });
}