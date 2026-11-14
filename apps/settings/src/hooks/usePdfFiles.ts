// src/hooks/usePdfFiles.ts
//
// Reactive Dexie live-query for PDF files in a building, joined
// with their PdfVersionRecord chain. Mirrors `useIfcFiles.ts`
// exactly: each file row knows its latest version id and how many
// versions it has, and exposes the full version chain sorted by
// versionNumber ascending (latest last).
//
// See docs/TASK-11-PDF-CANVAS.md §"Hooks" and §"CRUD tables" for
// the contract.

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@ff/data/db/database";
import type {
  PdfFileRecord,
  PdfVersionRecord,
} from "@ff/types";

/** A version of a PDF file, sorted oldest -> newest (latest is last). */
export type PdfFileVersion = PdfVersionRecord;

export interface PdfFileWithVersions {
  file: PdfFileRecord;
  /** All versions for this file, ordered by versionNumber ascending. */
  versions: PdfFileVersion[];
  /** Shortcut to the latest version record (== versions[versions.length-1]). */
  latestVersion: PdfFileVersion | null;
  /** id of the latest version (== latestVersion?.id ?? ""). */
  latestVersionId: string;
  /** Number of versions stored. */
  versionCount: number;
}

/**
 * Subscribe to all PdfFileRecord rows for a building, joined with
 * their PdfVersionRecord chains. Returns an empty array while the
 * buildingId is null (caller hasn't picked a building yet) or while
 * Dexie is still hydrating the live query.
 */
export function usePdfFiles(
  buildingId: string | null,
): PdfFileWithVersions[] {
  return (
    useLiveQuery(async () => {
      if (!buildingId) return [] as PdfFileWithVersions[];

      const files = await db.pdfFiles
        .where("buildingId")
        .equals(buildingId)
        .toArray();

      if (files.length === 0) return [] as PdfFileWithVersions[];

      // Pull every version for these files in one query and group
      // by pdfFileId. Cheaper than N round-trips when a building
      // holds many PDFs.
      const fileIds = files.map((f) => f.id);
      const allVersions = await db.pdfVersions
        .where("pdfFileId")
        .anyOf(fileIds)
        .toArray();

      const versionsByFile = new Map<string, PdfVersionRecord[]>();
      for (const v of allVersions) {
        const list = versionsByFile.get(v.pdfFileId) ?? [];
        list.push(v);
        versionsByFile.set(v.pdfFileId, list);
      }

      const result: PdfFileWithVersions[] = files.map((file) => {
        const versions = (versionsByFile.get(file.id) ?? []).sort(
          (a, b) => a.versionNumber - b.versionNumber,
        );
        // Prefer the explicit `isLatest` flag; fall back to the
        // highest versionNumber. The DB layer keeps the flag
        // consistent, but defending against drift is cheap.
        const latest: PdfVersionRecord | null =
          versions.find((v) => v.isLatest) ??
          versions[versions.length - 1] ??
          null;

        return {
          file,
          versions,
          latestVersion: latest,
          latestVersionId: latest?.id ?? "",
          versionCount: versions.length,
        };
      });

      // Stable order: by file name. Sidebar renders this directly.
      result.sort((a, b) => a.file.name.localeCompare(b.file.name));
      return result;
    }, [buildingId]) ?? []
  );
}
