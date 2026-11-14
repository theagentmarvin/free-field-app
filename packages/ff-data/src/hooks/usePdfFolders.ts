// src/hooks/usePdfFolders.ts
//
// Reactive Dexie live-queries for the v8 folder tables.
//
// Exports:
//   - usePdfFolders(projectId)      → flat list of folders for a project
//   - usePdfFolderTree(projectId)   → tree (FolderNode[]) derived from the flat list
//   - usePdfFolderAssignment(pdfFileId)
//                                    → single assignment for a PDF, or undefined
//   - usePdfFolderAssignmentsForBuilding(buildingId)
//                                    → all assignments whose pdfFileId belongs
//                                      to a PDF in the given building (used
//                                      to group the PDF list by folder)
//
// The hooks are pure live-query wrappers around `db.pdfFolders` and
// `db.pdfFolderAssignments`. The tree shape is computed in JS from
// the flat folder list — there is no separate "tree" table, only
// `parentId` self-FK references. See docs/task-20f-pdf-folders.md
// §"Hooks" for the contract.

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/database";
import type {
  PdfFolderRecord,
  PdfFolderAssignmentRecord,
} from "@ff/types";

/**
 * A folder plus its materialized children. The tree is rendered
 * depth-first; nested folders recursively carry their own
 * children. Sibling order is by name (ascending).
 */
export interface PdfFolderNode {
  folder: PdfFolderRecord;
  children: PdfFolderNode[];
  /** Convenience: depth from the project root. Roots are 0. */
  depth: number;
}

/**
 * Subscribe to all PdfFolderRecord rows for a project, ordered by
 * name ascending. Returns an empty array while `projectId` is null
 * or while Dexie is hydrating the live query.
 */
export function usePdfFolders(
  projectId: string | null,
): PdfFolderRecord[] {
  return (
    useLiveQuery(async () => {
      if (!projectId) return [] as PdfFolderRecord[];
      const rows = await db.pdfFolders
        .where("projectId")
        .equals(projectId)
        .toArray();
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    }, [projectId]) ?? []
  );
}

/**
 * Subscribe to the project's flat folder list and return it
 * materialized as a tree (nested `children`). Roots are folders
 * with `parentId === null`. The hook does NOT dedupe or validate
 * the parent chain — orphan rows (parentId pointing at a
 * non-existent folder) are surfaced as roots to keep the UI from
 * hiding data.
 *
 * Implementation note: the tree is computed synchronously from
 * the live-query result via `useMemo`. No need for a second
 * `useLiveQuery` here — the flat list is the single source of
 * truth, and `buildFolderTree` is a pure O(N) walk.
 */
export function usePdfFolderTree(
  projectId: string | null,
): PdfFolderNode[] {
  const folders = usePdfFolders(projectId);
  return useMemo(() => buildFolderTree(folders), [folders]);
}

/** Pure helper: turn a flat folder list into a tree. Exported
 *  for unit tests so we can assert the shape without spinning
 *  up React. */
export function buildFolderTree(
  folders: PdfFolderRecord[],
): PdfFolderNode[] {
  const byId = new Map<string, PdfFolderNode>();
  for (const folder of folders) {
    byId.set(folder.id, { folder, children: [], depth: 0 });
  }
  const roots: PdfFolderNode[] = [];
  for (const folder of folders) {
    const node = byId.get(folder.id)!;
    if (folder.parentId !== null && byId.has(folder.parentId)) {
      const parent = byId.get(folder.parentId)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      // Roots + orphans both surface as roots. We don't want to
      // hide a folder whose parent was deleted under it.
      node.depth = 0;
      roots.push(node);
    }
  }
  // Sort siblings by name at every level. Stable, predictable.
  const sortRec = (nodes: PdfFolderNode[]): void => {
    nodes.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * Subscribe to the single assignment for a PDF (or undefined if
 * the PDF is Unfiled). Uses the unique `pdfFileId` index for a
 * single-row fetch.
 */
export function usePdfFolderAssignment(
  pdfFileId: string | null,
): PdfFolderAssignmentRecord | undefined {
  return useLiveQuery(async () => {
    if (!pdfFileId) return undefined;
    return db.pdfFolderAssignments
      .where("pdfFileId")
      .equals(pdfFileId)
      .first();
  }, [pdfFileId]);
}

/**
 * Subscribe to every assignment for the PDFs in a building. Used
 * by the PDF list to group rows by folder when the Folders
 * sub-tab is active. The hook joins against `pdfFiles` to filter
 * the assignments down to the active building.
 *
 * Returns `undefined` while the query is hydrating so the caller
 * can show a loading state if desired.
 */
export function usePdfFolderAssignmentsForBuilding(
  buildingId: string | null,
): PdfFolderAssignmentRecord[] | undefined {
  return useLiveQuery(async () => {
    if (!buildingId) return [] as PdfFolderAssignmentRecord[];
    const pdfsInBuilding = await db.pdfFiles
      .where("buildingId")
      .equals(buildingId)
      .toArray();
    if (pdfsInBuilding.length === 0) return [] as PdfFolderAssignmentRecord[];
    const pdfIds = pdfsInBuilding.map((p) => p.id);
    return db.pdfFolderAssignments
      .where("pdfFileId")
      .anyOf(pdfIds)
      .toArray();
  }, [buildingId]);
}

/**
 * Subscribe to every assignment in a project. Used by the Folders
 * sub-tab to render the per-folder PDF count next to each folder
 * name (one row per folder, with `(N)` where N = number of
 * assignments pointing at it).
 *
 * The query fans out to the project's PDFs first (which are
 * scoped to buildings in the project) and then joins
 * assignments. For projects with many buildings this is O(PDFs)
 * + O(assignments), both single-pass over the relevant indexes.
 */
export function usePdfFolderAssignmentsForProject(
  projectId: string | null,
): PdfFolderAssignmentRecord[] | undefined {
  return useLiveQuery(async () => {
    if (!projectId) return [] as PdfFolderAssignmentRecord[];
    // Pull every building in the project, then every PDF in those
    // buildings. Two indexed scans; cheap for Phase-1 project
    // sizes.
    const buildings = await db.buildings
      .where("projectId")
      .equals(projectId)
      .toArray();
    if (buildings.length === 0) return [] as PdfFolderAssignmentRecord[];
    const buildingIds = buildings.map((b) => b.id);
    const pdfs = await db.pdfFiles
      .where("buildingId")
      .anyOf(buildingIds)
      .toArray();
    if (pdfs.length === 0) return [] as PdfFolderAssignmentRecord[];
    const pdfIds = pdfs.map((p) => p.id);
    return db.pdfFolderAssignments
      .where("pdfFileId")
      .anyOf(pdfIds)
      .toArray();
  }, [projectId]);
}