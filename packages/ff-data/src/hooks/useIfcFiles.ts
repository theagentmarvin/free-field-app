// src/hooks/useIfcFiles.ts
//
// Reactive Dexie live-query for IFC files in a building, joined with
// their IfcVersionRecord chain. The shape returned matches what the
// sidebar and viewer expect: each file row knows its latest version id
// and how many versions it has, and exposes the full version chain
// sorted by versionNumber ascending (latest last).
//
// See docs/SPEC-PHASE-1.md §6 (IfcListItem) and §7 (multi-versioning).

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db/database";
import type {
  IfcFileRecord,
  IfcVersionRecord,
} from "@ff/types";

/** A version of an IFC file, sorted oldest -> newest (latest is last). */
export type IfcFileVersion = IfcVersionRecord;

export interface IfcFileWithVersions {
  file: IfcFileRecord;
  /** All versions for this file, ordered by versionNumber ascending. */
  versions: IfcFileVersion[];
  /** Shortcut to the latest version record (== versions[versions.length-1]). */
  latestVersion: IfcFileVersion | null;
  /** id of the latest version (== latestVersion?.id ?? ""). */
  latestVersionId: string;
  /** Number of versions stored. */
  versionCount: number;
}

/**
 * Subscribe to all IfcFileRecord rows for a building, joined with their
 * IfcVersionRecord chains. Returns an empty array while the buildingId
 * is null (caller hasn't picked a building yet) or while Dexie is still
 * hydrating the live query.
 */
export function useIfcFiles(
  buildingId: string | null,
): IfcFileWithVersions[] {
  return (
    useLiveQuery(async () => {
      if (!buildingId) return [] as IfcFileWithVersions[];

      const files = await db.ifcFiles
        .where("buildingId")
        .equals(buildingId)
        .toArray();

      if (files.length === 0) return [] as IfcFileWithVersions[];

      // Pull every version for these files in one query and group by
      // ifcFileId. Cheaper than N round-trips when a building holds
      // many IFCs.
      const fileIds = files.map((f) => f.id);
      const allVersions = await db.ifcVersions
        .where("ifcFileId")
        .anyOf(fileIds)
        .toArray();

      const versionsByFile = new Map<string, IfcVersionRecord[]>();
      for (const v of allVersions) {
        const list = versionsByFile.get(v.ifcFileId) ?? [];
        list.push(v);
        versionsByFile.set(v.ifcFileId, list);
      }

      const result: IfcFileWithVersions[] = files.map((file) => {
        const versions = (versionsByFile.get(file.id) ?? []).sort(
          (a, b) => a.versionNumber - b.versionNumber,
        );
        // Prefer the explicit currentVersionId pointer from the file
        // record; fall back to isLatest; fall back to the highest
        // versionNumber. All three are kept consistent by the DB layer
        // (see deleteIfcVersion cascade), but defending against drift
        // is cheap.
        const latest: IfcVersionRecord | null =
          versions.find((v) => v.id === file.currentVersionId) ??
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
