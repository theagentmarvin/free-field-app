// apps/linkview/src/hooks/useMappedPdfsForBuilding.ts
//
// Reactive Dexie live-query for the Linkview "Mapped PDFs" list.
// Returns the PDFs in the active building that have at least one
// calibration whose `storeyName` matches a storey that also lives in
// the active building.
//
// Why a new hook (not reuse useDocumentsGroups / useAllPdfFiles):
//   - The documents module's hook joins PDFs with folders
//     (v8 schema), not calibrations (v4).
//   - The settings module's `useCalibrationsForProject` returns raw
//     calibrations — the linkview list needs the joined view
//     (pdfFile + latestVersion + the storeyNames it's calibrated
//     to) so the row can render "PDF ↔ Ground Floor / Level 1" in
//     a single click.
//
// Filtering rule (matches the maintainer's 2026-06-23 brief):
//   "only showing pdf that are mapped to a level floor plan"
//
// Wave 55: the join lives in the exported PLAIN async function
// `queryMappedPdfsForBuilding`; the hook is a thin live-query
// wrapper. LinkviewApp's non-blank-open effect calls the plain
// function directly so the PDF-vs-level priority never depends on
// live-query resolution timing.
//
// Implementation:
//  1. Pull `pdfFiles` scoped to the building.
//  2. Pull every `calibration` for the project.
//  3. Pull every `storey` in the building (their `name` is the join
//     key against `calibration.storeyName`).
//  4. Keep calibrations whose `storeyName` is in the building's
//     storey-name set.
//  5. Group kept calibrations by `pdfFileId`. PDFs that show up in
//     the map are "mapped"; skip the rest.
//  6. Join each mapped PDF with its latest version (mirrors the
//     logic in apps/documents/src/hooks/useAllPdfFiles.ts).
//  7. Sort by PDF name alpha so the list has a stable order.
//
// All four Dexie reads are batched in a single Promise.all so the
// live-query subscription is one round-trip to IndexedDB.

import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type {
  CalibrationRecord,
  PdfFileRecord,
  PdfVersionRecord,
  StoreyRecord,
} from "@ff/types";

export interface MappedPdfEntry {
  /** The PDF file row (one per logical file). */
  file: PdfFileRecord;
  /** The latest PdfVersionRecord for this file. Null is unreachable
   *  in practice (we filter out files with no versions below) but
   *  is typed for symmetry with useAllPdfFiles. */
  latestVersion: PdfVersionRecord;
  /** Distinct storey names this PDF is calibrated to within the
   *  active building. Sorted alpha. Multiple rows against the same
   *  storey collapse to one entry. */
  storeyNames: string[];
}

/** The plain (non-reactive) join — see the file header for rules. */
export async function queryMappedPdfsForBuilding(
  projectId: string | null,
  buildingId: string | null,
): Promise<MappedPdfEntry[]> {
  if (!projectId || !buildingId) return [];

  const [files, versions, calibrations, storeys] = await Promise.all([
    db.pdfFiles.where("buildingId").equals(buildingId).toArray(),
    db.pdfVersions.toArray(),
    db.calibrations.where("projectId").equals(projectId).toArray(),
    db.storeys.where("buildingId").equals(buildingId).toArray(),
  ]);

  // The storey-name set is the join key. If a calibration points
  // to a storey name that doesn't exist in this building, the
  // mapping is orphaned and we hide it from the list.
  const storeyNamesInBuilding = new Set<string>();
  for (const s of storeys as StoreyRecord[]) {
    if (s.name) storeyNamesInBuilding.add(s.name);
  }

  // Group calibrations by pdfFileId (filtered to this building).
  const calByPdf = new Map<string, CalibrationRecord[]>();
  for (const c of calibrations as CalibrationRecord[]) {
    if (!storeyNamesInBuilding.has(c.storeyName)) continue;
    const list = calByPdf.get(c.pdfFileId) ?? [];
    list.push(c);
    calByPdf.set(c.pdfFileId, list);
  }

  // Group versions by file for the latest-version lookup.
  const versionsByFile = new Map<string, PdfVersionRecord[]>();
  for (const v of versions as PdfVersionRecord[]) {
    const list = versionsByFile.get(v.pdfFileId) ?? [];
    list.push(v);
    versionsByFile.set(v.pdfFileId, list);
  }

  const entries: MappedPdfEntry[] = [];
  for (const file of files as PdfFileRecord[]) {
    const cals = calByPdf.get(file.id);
    if (!cals || cals.length === 0) continue;

    const vs = (versionsByFile.get(file.id) ?? []).sort(
      (a, b) => a.versionNumber - b.versionNumber,
    );
    const latest: PdfVersionRecord | undefined =
      vs.find((v) => v.isLatest) ?? vs[vs.length - 1];
    if (!latest) continue;

    const names = Array.from(new Set(cals.map((c) => c.storeyName)));
    names.sort((a, b) => a.localeCompare(b));

    entries.push({ file, latestVersion: latest, storeyNames: names });
  }

  entries.sort((a, b) => a.file.name.localeCompare(b.file.name));
  return entries;
}

/** The reactive (Dexie live-query) wrapper over the plain join. */
export function useMappedPdfsForBuilding(
  projectId: string | null,
  buildingId: string | null,
): MappedPdfEntry[] {
  return (
    useLiveQuery<MappedPdfEntry[]>(
      () => queryMappedPdfsForBuilding(projectId, buildingId),
      [projectId, buildingId],
    ) ?? []
  );
}
