// Dexie-backed catalog of the project's sheets (files, versions, folders,
// folder assignments) for the attach picker, the sheet chips and the
// click-to-open action. Pure grouping lives in sheetRefs.ts.

import { useLiveQuery } from "dexie-react-hooks";

import { db as localDb } from "@ff/data/db/database";
import type { SheetRef } from "@ff/tasks";

import { resolveSheetRefOpen, type SheetCatalog } from "./sheetRefs";
import { requestTaskOpen, setTaskOpenNotice } from "./taskOpenStore";

export const EMPTY_SHEET_CATALOG: SheetCatalog = {
  files: new Map(),
  versions: [],
  folders: [],
  assignments: new Map(),
};

/** Read the catalog once (imperative; used by the click-to-open action). */
export async function loadSheetCatalog(projectId: string | null): Promise<SheetCatalog> {
  const buildings = projectId
    ? await localDb.buildings.where("projectId").equals(projectId).toArray()
    : await localDb.buildings.toArray();
  const buildingIds = buildings.map((b) => b.id);
  const files = buildingIds.length ? await localDb.pdfFiles.where("buildingId").anyOf(buildingIds).toArray() : [];
  const fileIds = new Set(files.map((f) => f.id));
  const versions = (await localDb.pdfVersions.toArray()).filter((v) => fileIds.has(v.pdfFileId));
  const folders = projectId ? await localDb.pdfFolders.where("projectId").equals(projectId).toArray() : [];
  const assignments = fileIds.size
    ? await localDb.pdfFolderAssignments.where("pdfFileId").anyOf([...fileIds]).toArray()
    : [];
  return {
    files: new Map(files.map((f) => [f.id, f] as const)),
    versions,
    folders,
    assignments: new Map(assignments.map((a) => [a.pdfFileId, a.folderId] as const)),
  };
}

/** Live catalog of the current project's sheets. */
export function useSheetCatalog(projectId: string | null): SheetCatalog {
  return useLiveQuery(() => loadSheetCatalog(projectId), [projectId]) ?? EMPTY_SHEET_CATALOG;
}

/**
 * Open an attached sheet in Documents: the CHOSEN version (superseded
 * versions open as chosen; a deleted version falls back to the latest
 * with a message; a deleted sheet is a clear message). Goes through the
 * same quick-access bridge as the location image.
 */
export async function openSheetRef(ref: SheetRef, projectId: string | null): Promise<boolean> {
  const result = resolveSheetRefOpen(ref, await loadSheetCatalog(projectId));
  if (!result.ok) {
    setTaskOpenNotice(result.message);
    return false;
  }
  requestTaskOpen(result.intent, result.notice ?? null);
  return true;
}
