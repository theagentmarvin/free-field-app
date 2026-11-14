// apps/linkview/src/hooks/useExtractedStoreysForBuilding.ts
//
// Reactive Dexie live-query for the Linkview "Model Floor Plans"
// list. Returns the `storey` rows in the active building that have
// been marked extracted via `extractedStoreys`.
//
// Why a new hook (not reuse listExtracted + listStoreys separately):
//   - The list needs the joined view, not the raw rows.
//   - Co-locating the join keeps the sort logic (by elevation
//     ascending, so the lowest floor shows first) in one place.
//   - Other consumers (Settings's LevelChecklistPopover) only need
//     the extracted rows; they don't need this join.
//
// Filtering rule (matches the maintainer's 2026-06-23 brief):
//   "also model floor plans extracted"
//
// Wave 55: the join lives in the exported PLAIN async function
// `queryExtractedStoreysForBuilding`; the hook is a thin live-query
// wrapper (same reason as useMappedPdfsForBuilding — the non-blank-
// open effect must not race live-query resolution).
//
// Implementation:
//  1. Pull every `extractedStoreys` row for the building.
//  2. Pull every `storeys` row for the building.
//  3. Inner-join: drop extracted rows whose storeyId doesn't resolve
//     (deleted storey).
//  4. Sort by elevation ascending. Tiebreak by id for stability.
//
// All three Dexie reads are batched in a single Promise.all.

import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type { ExtractedStoreyRecord, StoreyRecord } from "@ff/types";

export interface ExtractedStoreyEntry {
  storey: StoreyRecord;
  extracted: ExtractedStoreyRecord;
}

/** The plain (non-reactive) join — lowest floor first. */
export async function queryExtractedStoreysForBuilding(
  buildingId: string | null,
): Promise<ExtractedStoreyEntry[]> {
  if (!buildingId) return [];

  const [extracted, storeys] = await Promise.all([
    db.extractedStoreys.where("buildingId").equals(buildingId).toArray(),
    db.storeys.where("buildingId").equals(buildingId).toArray(),
  ]);

  const storeysById = new Map<string, StoreyRecord>();
  for (const s of storeys as StoreyRecord[]) {
    storeysById.set(s.id, s);
  }

  const entries: ExtractedStoreyEntry[] = [];
  for (const e of extracted as ExtractedStoreyRecord[]) {
    const s = storeysById.get(e.storeyId);
    if (!s) continue; // orphaned; skip silently
    entries.push({ storey: s, extracted: e });
  }

  // Lowest floor first. id tiebreak keeps the order stable when
  // two storeys share an elevation (rare but cheap to defend).
  entries.sort((a, b) => {
    if (a.storey.elevation !== b.storey.elevation) {
      return a.storey.elevation - b.storey.elevation;
    }
    return a.storey.id.localeCompare(b.storey.id);
  });

  return entries;
}

/** The reactive (Dexie live-query) wrapper over the plain join. */
export function useExtractedStoreysForBuilding(
  buildingId: string | null,
): ExtractedStoreyEntry[] {
  return (
    useLiveQuery<ExtractedStoreyEntry[]>(
      () => queryExtractedStoreysForBuilding(buildingId),
      [buildingId],
    ) ?? []
  );
}
