// apps/documents/src/hooks/useAllPdfFiles.ts
//
// Reactive Dexie live-query for ALL PDF files in the project,
// joined with their PdfVersionRecord chain and tagged with the
// building they belong to. Mirrors apps/settings/src/hooks/usePdfFiles.ts
// shape exactly so the sidebar can render rows with the same visual
// primitives (icon, filename, version pill).
//
// Why not reuse usePdfFiles from settings? It takes a single
// `buildingId` and returns PDFs scoped to that building. The
// documents sidebar wants to show every PDF in the project
// grouped by building — that's a different query shape. Adding
// a new `useAllPdfFiles()` keeps the building-scoped hook
// unchanged for Settings.
//
// See docs/plans/2026-06-22-docs-module-plan.md §6 ("Left-nav
// design") for the grouping rationale.

import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type {
  BuildingRecord,
  PdfFileRecord,
  PdfVersionRecord,
} from "@ff/types";

export interface PdfEntryWithBuilding {
  file: PdfFileRecord;
  /** The building this file was uploaded to. Looked up via
   *  `db.buildings`; null if the building was deleted (PDFs are
   *  kept — Settings treats orphaned PDFs as "Unfiled"). */
  building: BuildingRecord | null;
  /** All versions for this file, ordered by versionNumber ascending
   *  (oldest first; latest is last). Mirrors PdfFileWithVersions
   *  from usePdfFiles. */
  versions: PdfVersionRecord[];
  /** Shortcut to the latest version record. */
  latestVersion: PdfVersionRecord | null;
  /** id of the latest version (== latestVersion?.id ?? ""). */
  latestVersionId: string;
  /** Number of versions stored. */
  versionCount: number;
}

/**
 * Subscribe to all PdfFileRecord rows in the project (across all
 * buildings), joined with their PdfVersionRecord chains and the
 * owning BuildingRecord. Returns an empty array while Dexie is
 * hydrating the live query.
 *
 * The query is a single batched read: `pdfFiles.toArray()` +
 * `pdfVersions.toArray()` + `buildings.toArray()`, then grouped
 * in memory. This is cheaper than per-building N+1 queries and
 * keeps the React tree to one live-query subscription.
 *
 * Sort order: by building name (alpha), then by PDF name (alpha)
 * within each building. Stable across renders so the sidebar
 * doesn't reshuffle on every live-query tick.
 */
export function useAllPdfFiles(): PdfEntryWithBuilding[] {
  return (
    useLiveQuery<PdfEntryWithBuilding[]>(async () => {
      const [files, versions, buildings] = await Promise.all([
        db.pdfFiles.toArray(),
        db.pdfVersions.toArray(),
        db.buildings.toArray(),
      ]);

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
        // Prefer the explicit `isLatest` flag; fall back to the
        // highest versionNumber. The DB layer keeps the flag
        // consistent, but defending against drift is cheap.
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

      // Stable sort: building name (alpha), then file name (alpha).
      // Buildings missing/null sort last so "Unfiled" doesn't scatter.
      rows.sort((a, b) => {
        const an = a.building?.name ?? "~~~";
        const bn = b.building?.name ?? "~~~";
        if (an !== bn) return an.localeCompare(bn);
        return a.file.name.localeCompare(b.file.name);
      });

      return rows;
    }, []) ?? []
  );
}
