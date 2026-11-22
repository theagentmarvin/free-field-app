// packages/ff-tasks-react/src/sheetRefs.ts
//
// Project sheets attached to a task BY REFERENCE (pdfFileId + version +
// optional page — never a copy of the PDF). Pure logic over a catalog of
// the project's sheets: building references, the version badge
// ("v1 (newer: v2)"), what clicking one opens, and the picker's
// folder / search grouping. The hooks that read the catalog live in
// sheetCatalog.ts.

import type { SheetRef } from "@ff/tasks";

import type { TaskOpenDocumentsIntent } from "./taskOpenStore";

export interface SheetCatalog {
  files: ReadonlyMap<string, { id: string; buildingId: string; name: string }>;
  versions: ReadonlyArray<{ id: string; pdfFileId: string; versionNumber: number; isLatest: boolean }>;
  folders: ReadonlyArray<{ id: string; parentId: string | null; name: string }>;
  /** pdfFileId -> folderId (a sheet without an entry is Unfiled) */
  assignments: ReadonlyMap<string, string>;
}

function versionsOf(catalog: SheetCatalog, fileId: string) {
  return catalog.versions.filter((v) => v.pdfFileId === fileId).sort((a, b) => a.versionNumber - b.versionNumber);
}

function latestOf(catalog: SheetCatalog, fileId: string) {
  const vs = versionsOf(catalog, fileId);
  return vs.find((v) => v.isLatest) ?? vs[vs.length - 1] ?? null;
}

/** A reference to `fileId` (latest version unless `versionId` is given). */
export function makeSheetRef(
  fileId: string,
  catalog: SheetCatalog,
  opts: { versionId?: string; page?: number } = {},
): SheetRef | null {
  const file = catalog.files.get(fileId);
  if (!file) return null;
  const version = opts.versionId
    ? versionsOf(catalog, fileId).find((v) => v.id === opts.versionId) ?? null
    : latestOf(catalog, fileId);
  if (!version) return null;
  const ref: SheetRef = {
    pdfFileId: fileId,
    pdfVersionId: version.id,
    versionNumber: version.versionNumber,
    name: file.name,
  };
  if (opts.page && opts.page > 0) ref.page = opts.page;
  return ref;
}

export type SheetRefStatus = "current" | "superseded" | "version-missing" | "missing";

export interface SheetRefView {
  status: SheetRefStatus;
  name: string;
  /** badge text: "v2", "v1 (newer: v2)", "removed" */
  label: string;
  latestVersionId: string | null;
}

export function describeSheetRef(ref: SheetRef, catalog: SheetCatalog): SheetRefView {
  const file = catalog.files.get(ref.pdfFileId);
  if (!file) return { status: "missing", name: ref.name || "Sheet", label: "removed", latestVersionId: null };
  const latest = latestOf(catalog, ref.pdfFileId);
  const chosen = versionsOf(catalog, ref.pdfFileId).find((v) => v.id === ref.pdfVersionId);
  if (!chosen) {
    return {
      status: "version-missing",
      name: file.name,
      label: latest ? `v${ref.versionNumber ?? "?"} (removed; latest: v${latest.versionNumber})` : "removed",
      latestVersionId: latest?.id ?? null,
    };
  }
  if (latest && latest.id !== chosen.id) {
    return {
      status: "superseded",
      name: file.name,
      label: `v${chosen.versionNumber} (newer: v${latest.versionNumber})`,
      latestVersionId: latest.id,
    };
  }
  return { status: "current", name: file.name, label: `v${chosen.versionNumber}`, latestVersionId: latest?.id ?? null };
}

export type SheetOpenResult =
  | { ok: true; intent: Omit<TaskOpenDocumentsIntent, "id">; notice?: string }
  | { ok: false; message: string };

/** What clicking an attached sheet opens: the CHOSEN version (not the latest). */
export function resolveSheetRefOpen(ref: SheetRef, catalog: SheetCatalog): SheetOpenResult {
  const file = catalog.files.get(ref.pdfFileId);
  if (!file) {
    return { ok: false, message: `The attached sheet ${ref.name || "(unnamed)"} no longer exists in this project.` };
  }
  const chosen = versionsOf(catalog, ref.pdfFileId).find((v) => v.id === ref.pdfVersionId);
  const latest = latestOf(catalog, ref.pdfFileId);
  const version = chosen ?? latest;
  if (!version) return { ok: false, message: `The attached sheet ${file.name} has no stored version.` };
  const intent: Omit<TaskOpenDocumentsIntent, "id"> = {
    kind: "documents",
    taskId: "",
    buildingId: file.buildingId,
    pdfFileId: file.id,
    versionId: version.id,
    page: ref.page && ref.page > 0 ? ref.page : 1,
    uv: null,
  };
  return chosen
    ? { ok: true, intent }
    : {
        ok: true,
        intent,
        notice: `The attached version of ${file.name} no longer exists. Showing the latest (v${version.versionNumber}).`,
      };
}

const refKey = (r: SheetRef): string => `${r.pdfFileId}\u0000${r.pdfVersionId}\u0000${r.page ?? ""}`;

/** Add `ref`, or remove it when that exact reference is already attached. */
export function toggleSheetRef(list: readonly SheetRef[], ref: SheetRef): SheetRef[] {
  const k = refKey(ref);
  return list.some((r) => refKey(r) === k) ? list.filter((r) => refKey(r) !== k) : [...list, ref];
}

export interface PickerEntry {
  fileId: string;
  name: string;
  buildingId: string;
  /** "v2/2": latest version number / version count (same as the Documents list) */
  badge: string;
  latestVersionId: string | null;
}

export interface PickerSection {
  title: string;
  entries: PickerEntry[];
}

/** Folder path "ARC / Plans" for a folder id. */
function folderPath(catalog: SheetCatalog, folderId: string): string {
  const byId = new Map(catalog.folders.map((f) => [f.id, f] as const));
  const parts: string[] = [];
  let cur = byId.get(folderId);
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}

/** The picker's list: sheets of `buildingId` (or the whole project), grouped by folder path, filtered by search. */
export function buildPickerSections(
  catalog: SheetCatalog,
  opts: { buildingId: string | null; query: string },
): PickerSection[] {
  const q = opts.query.trim().toLowerCase();
  const byTitle = new Map<string, PickerEntry[]>();
  for (const file of catalog.files.values()) {
    if (opts.buildingId && file.buildingId !== opts.buildingId) continue;
    const folderId = catalog.assignments.get(file.id);
    const title = (folderId && folderPath(catalog, folderId)) || "Unfiled";
    if (q && !file.name.toLowerCase().includes(q) && !title.toLowerCase().includes(q)) continue;
    const vs = versionsOf(catalog, file.id);
    const latest = latestOf(catalog, file.id);
    const entry: PickerEntry = {
      fileId: file.id,
      name: file.name,
      buildingId: file.buildingId,
      badge: `v${latest?.versionNumber ?? "?"}/${vs.length}`,
      latestVersionId: latest?.id ?? null,
    };
    const list = byTitle.get(title) ?? [];
    list.push(entry);
    byTitle.set(title, list);
  }
  const sections = [...byTitle.entries()].map(([title, entries]) => ({
    title,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  }));
  // folders alphabetically, Unfiled last
  return sections.sort((a, b) =>
    a.title === "Unfiled" ? 1 : b.title === "Unfiled" ? -1 : a.title.localeCompare(b.title),
  );
}
