// apps/documents/src/hooks/useDocumentsGroups.ts
//
// Joins the project-scoped folder + assignment tables (v8 in
// settings) with the per-building PDF data the documents sidebar
// already had. The result is a folder-first grouping: each
// folder carries its PDFs, and each PDF knows its building (so
// the sidebar can render building sub-groups inside a folder).
//
// Why a new hook (not reuse `usePdfFolderAssignmentsForProject`):
//   - That hook returns raw `PdfFolderAssignmentRecord` rows.
//     The sidebar needs the joined view (folder → list of PDFs
//     with their building info).
//   - Co-locating the join here keeps `useAllPdfFilesWithFolder`
//     focused on the ungrouped "everything in the project" query
//     that other consumers may want.
//
// Files come from the same Dexie singleton the settings module
// writes to (single Vite origin → single IndexedDB). The folder
// and assignment tables were added in the settings module under
// `@ff/data/db/tables/pdfFolders` and
// `@ff/data/db/tables/pdfFolderAssignments` — the documents module
// imports them via the `@core/*` and `@hooks/*` aliases declared
// in tsconfig.json.

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type {
  PdfFolderRecord,
  BuildingRecord,
  PdfVersionRecord,
} from "@ff/types";
import {
  usePdfFolders,
  usePdfFolderTree,
  usePdfFolderAssignmentsForProject,
  type PdfFolderNode,
} from "@ff/data/hooks";
import { useProjectId } from "@ff/auth";

import type { PdfEntryWithBuilding } from "./useAllPdfFiles";

/** A PDF row joined with its folder (if any). Mirrors
 *  PdfEntryWithBuilding with an extra `folderId` so the sidebar
 *  can group rows by folder in a single pass. */
export interface PdfEntryWithFolder extends PdfEntryWithBuilding {
  folderId: string | null;
}

/** A sub-group of PDFs within a folder, scoped to a single
 *  building. Empty when a folder has no PDFs in that building
 *  (and the sidebar omits empty groups entirely). */
export interface BuildingGroup {
  building: BuildingRecord | null;
  label: string;
  rows: PdfEntryWithFolder[];
}

/** All the data the sidebar needs for a single folder: the
 *  folder row (null for the synthetic Unfiled pseudo-folder)
 *  and the flat list of rows assigned to it (already filtered
 *  to the active building by `useDocumentsGroups`). */
export interface FolderGroup {
  folder: PdfFolderRecord | null;
  rows: PdfEntryWithFolder[];
}

/** A node in the sidebar's tree of folders. `children` carries
 *  the nested sub-folders. `folder` is null only for the
 *  synthetic "Unfiled" pseudo-folder (always at the root). */
export interface FolderTreeNode {
  folder: PdfFolderRecord | null;
  children: FolderTreeNode[];
  depth: number;
  /** Set only when `folder` is non-null. */
  group: FolderGroup | null;
}

export interface DocumentsGroups {
  /** Folder tree in pre-order, depth-first. The root of the
   *  tree is the project's folder hierarchy + the synthetic
   *  "Unfiled" pseudo-folder (if any unfiled PDFs exist). */
  tree: FolderTreeNode[];
  /** Map: folderId → folderGroup (or "__unfiled__" → the
   *  Unfiled pseudo-folder). Useful for tests + consumers that
   *  want O(1) lookup of a specific folder's contents. */
  folderGroups: Map<string, FolderGroup>;
  /** Flat list of every PDF row, augmented with `folderId`. */
  rows: PdfEntryWithFolder[];
}

/**
 * Build the folder-first grouping consumed by <DocumentsSidebar>.
 * Returns `undefined` while the assignment live-query is still
 * hydrating (the caller can fall back to a loading state). The
 * other inputs always return arrays (even when empty) so we only
 * block on `assignments`.
 *
 * Per plan v3 §8 (Dexie v8 → v9 migration): `projectId` defaults to
 * the user's current project from custom claims (via `useProjectId`).
 * When the user is not yet a member of any project, `projectId` is
 * `undefined` and the underlying Dexie queries return empty.
 *
 * If `buildingId` is non-null, only PDFs whose `buildingId`
 * matches are included in the returned groups (per Maintainer directive
 * 2026-06-22 17:13 CLT — docs are per-building). The folder tree
 * itself is still project-wide (folders are a project-level
 * concept); the filter only narrows the PDF rows nested under
 * each folder + the Unfiled pseudo-folder.
 */
export function useDocumentsGroups(
  buildingId?: string | null,
): DocumentsGroups | undefined {
  const projectId = useProjectId() ?? null;
  const folders = usePdfFolders(projectId);
  const folderTree = usePdfFolderTree(projectId);
  const assignments = usePdfFolderAssignmentsForProject(projectId);
  const rows = useAllPdfFilesWithFolder(projectId);

  return useMemo<DocumentsGroups | undefined>(() => {
    // No current project: nothing to read yet (loading/empty state).
    if (projectId === null) return undefined;
    if (assignments === undefined) return undefined;

    // Map every pdfFileId to its folderId (one-folder-per-PDF).
    const folderIdByPdfId = new Map<string, string | null>();
    for (const a of assignments) {
      folderIdByPdfId.set(a.pdfFileId, a.folderId);
    }

    // Augment rows with folderId, then apply the optional
    // buildingId filter (null/empty string = no filter, show
    // every building's PDFs).
    const buildingFilter = buildingId ?? null;
    const augmented: PdfEntryWithFolder[] = rows
      .filter((row) =>
        buildingFilter === null ? true : row.file.buildingId === buildingFilter,
      )
      .map((row) => ({
        ...row,
        folderId: folderIdByPdfId.get(row.file.id) ?? null,
      }));

    // Group rows by folderId. PDFs with no assignment go into
    // the null pseudo-folder.
    const rowsByFolderId = new Map<string | null, PdfEntryWithFolder[]>();
    for (const row of augmented) {
      const list = rowsByFolderId.get(row.folderId) ?? [];
      list.push(row);
      rowsByFolderId.set(row.folderId, list);
    }

    // FolderGroup per real folder. Per Maintainer directive
    // 2026-06-22 17:45 CLT — the building dimension is now
    // owned by the <BuildingPicker> at the top of the sidebar,
    // so PDFs inside a folder render as a flat list (no per-
    // building sub-grouping). The building filter is already
    // applied upstream in `augmented`.
    const folderGroups = new Map<string, FolderGroup>();
    for (const folder of folders) {
      const folderRows = rowsByFolderId.get(folder.id) ?? [];
      folderGroups.set(folder.id, {
        folder,
        rows: folderRows,
      });
    }

    // Unfiled pseudo-group: only when at least one PDF has no
    // assignment. Hidden when empty so the sidebar doesn't show
    // a noisy "Unfiled (0)" section.
    const unfiledRows = rowsByFolderId.get(null) ?? [];
    let unfiledGroup: FolderGroup | null = null;
    if (unfiledRows.length > 0) {
      unfiledGroup = {
        folder: null,
        rows: unfiledRows,
      };
      folderGroups.set("__unfiled__", unfiledGroup);
    }

    // Build the tree in pre-order. We walk the source tree
    // depth-first and produce a parallel FolderTreeNode list
    // with materialized `group` lookups + nested `children`.
    const tree: FolderTreeNode[] = [];
    const visit = (
      nodes: PdfFolderNode[],
      depth: number,
    ): FolderTreeNode[] => {
      const out: FolderTreeNode[] = [];
      for (const node of nodes) {
        const group = folderGroups.get(node.folder.id) ?? null;
        const children = visit(node.children, depth + 1);
        out.push({
          folder: node.folder,
          children,
          depth,
          group,
        });
      }
      return out;
    };
    tree.push(...visit(folderTree, 0));
    if (unfiledGroup) {
      tree.push({
        folder: null,
        children: [],
        depth: 0,
        group: unfiledGroup,
      });
    }

    return { tree, folderGroups, rows: augmented };
  }, [folders, folderTree, assignments, rows, buildingId]);
}

/** Internal: like `useAllPdfFiles` but guaranteed to return an
 *  array (not undefined). The underlying query always returns
 *  `[]` while hydrating so the sidebar can render a stable
 *  loading state without flicker.
 *
 * Scoped to `projectId`: only buildings of that project, and the
 * PDFs inside them. Returns `[]` while `projectId` is null. */
function useAllPdfFilesWithFolder(projectId: string | null): PdfEntryWithBuilding[] {
  return (
    useLiveQuery<PdfEntryWithBuilding[]>(async () => {
      if (!projectId) return [];
      const buildings = await db.buildings
        .where("projectId")
        .equals(projectId)
        .toArray();
      if (buildings.length === 0) return [];
      const files = await db.pdfFiles
        .where("buildingId")
        .anyOf(buildings.map((b) => b.id))
        .toArray();
      const fileIds = new Set(files.map((f) => f.id));
      const versions = (await db.pdfVersions.toArray()).filter((v) =>
        fileIds.has(v.pdfFileId),
      );
      const buildingsById = new Map(buildings.map((b) => [b.id, b]));
      const versionsByFile = new Map<string, PdfVersionRecord[]>();
      for (const v of versions) {
        const list = versionsByFile.get(v.pdfFileId) ?? [];
        list.push(v);
        versionsByFile.set(v.pdfFileId, list);
      }
      const rows: PdfEntryWithBuilding[] = files.map((file) => {
        const vs = (versionsByFile.get(file.id) ?? []).sort(
          (a, b) => a.versionNumber - b.versionNumber,
        );
        const latest: PdfVersionRecord | null =
          vs.find((v) => v.isLatest) ??
          vs[vs.length - 1] ??
          null;
        return {
          file,
          building: buildingsById.get(file.buildingId) ?? null,
          versions: vs,
          latestVersion: latest,
          latestVersionId: latest?.id ?? "",
          versionCount: vs.length,
        };
      });
      rows.sort((a, b) => {
        const an = a.building?.name ?? "~~~";
        const bn = b.building?.name ?? "~~~";
        if (an !== bn) return an.localeCompare(bn);
        return a.file.name.localeCompare(b.file.name);
      });
      return rows;
    }, [projectId]) ?? []
  );
}

/** Pure helper: split a flat PDF list into per-building groups.
 *  No longer called by the sidebar (the <BuildingPicker>
 *  handles the building dimension). Kept here in case a
 *  future feature needs per-building sub-grouping again
 *  (e.g. a "show all buildings" mode). */
function _groupRowsByBuilding(
  rows: PdfEntryWithFolder[],
): { building: BuildingRecord | null; label: string; rows: PdfEntryWithFolder[] }[] {
  const groups: { building: BuildingRecord | null; label: string; rows: PdfEntryWithFolder[] }[] = [];
  const byBuilding = new Map<string, PdfEntryWithFolder[]>();
  const orphans: PdfEntryWithFolder[] = [];
  for (const row of rows) {
    if (row.building === null) {
      orphans.push(row);
      continue;
    }
    const key = row.building.id;
    const list = byBuilding.get(key) ?? [];
    list.push(row);
    byBuilding.set(key, list);
  }
  for (const [, list] of byBuilding) {
    const building = list[0]!.building;
    if (building === null) {
      groups.push({
        building: null,
        label: "Unknown building",
        rows: list,
      });
    } else {
      groups.push({ building, label: building.name, rows: list });
    }
  }
  if (orphans.length > 0) {
    groups.push({
      building: null,
      label: "Orphaned",
      rows: orphans,
    });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}
// Reference the helper so the linter doesn't flag it as unused
// while it's kept for future re-use.
void _groupRowsByBuilding;