// src/hooks/useStoreys.ts
//
// Reactive Dexie live-query for StoreyRecord rows tied to a building,
// optionally filtered to a set of "active" IfcVersionRecord ids. Used
// by the Get Levels tab in Task 3 to render the parsed storeys of the
// currently-loaded IFC version(s).
//
// See docs/SPEC-PHASE-1.md §4 (StoreyRecord) and §6 (LevelChecklist).

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@ff/data/db/database";
import type { StoreyRecord } from "@ff/types";

/**
 * Subscribe to storeys in a building.
 *
 * - If `activeIfcVersionIds` is undefined → return every storey for the
 *   building (useful for the building's full inventory view).
 * - If `activeIfcVersionIds` is `[]` → return an empty array (caller
 *   hasn't picked any IFCs to show levels for).
 * - Otherwise → return storeys whose `ifcVersionId` is in the list.
 *
 * Result is sorted by `elevation` ascending (lowest storey first), which
 * matches the natural BIM reading order (Piso -2, -1, 0, 1, 2...).
 */
export function useStoreys(
  buildingId: string | null,
  activeIfcVersionIds?: string[],
): StoreyRecord[] {
  return (
    useLiveQuery(async () => {
      if (!buildingId) return [] as StoreyRecord[];

      // No active versions selected → empty set. Don't bother hitting
      // the DB; the sidebar will show "no levels" and that's correct.
      if (activeIfcVersionIds && activeIfcVersionIds.length === 0) {
        return [] as StoreyRecord[];
      }

      const all = await db.storeys
        .where("buildingId")
        .equals(buildingId)
        .toArray();

      const filtered =
        activeIfcVersionIds === undefined
          ? all
          : all.filter((s) => activeIfcVersionIds.includes(s.ifcVersionId));

      // Stable sort: lowest first; tiebreak by name so two storeys at
      // the same elevation (rare but possible — slab on grade) still
      // order deterministically.
      filtered.sort((a, b) => {
        if (a.elevation !== b.elevation) return a.elevation - b.elevation;
        return a.name.localeCompare(b.name);
      });

      return filtered;
    }, [buildingId, activeIfcVersionIds?.join("|") ?? "*"]) ?? []
  );
}
