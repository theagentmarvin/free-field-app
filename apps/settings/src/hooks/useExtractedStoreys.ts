// src/hooks/useExtractedStoreys.ts
//
// Reactive Dexie live-query for a building's "Mapped" set: the
// extractedStoreys rows for the building, joined with the underlying
// StoreyRecord for display. The sidebar's <MappedStoreysSection>
// consumes this hook as its single source of truth.
//
// See docs/TASK-4-MAPPED-SECTION.md for the additive invariant and
// the wiring to <LevelChecklistPopover>'s Apply handler.

import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type { StoreyRecord } from "@ff/types";

export interface MappedStorey {
  /** ExtractedStoreyRecord.id — kept around for future ortho-view fields. */
  extractedId: string;
  /** Full StoreyRecord so consumers can render name, elevation, etc. */
  storey: StoreyRecord;
}

/**
 * Subscribe to the building's Mapped set.
 *
 * - `buildingId === null` → `[]` (caller hasn't picked a building).
 * - Building has no extracted rows → `[]` (renders empty state).
 * - Each extracted row whose referenced storey is missing is
 *   skipped with a dev-only `console.warn` (orphan — the cascade
 *   that should have removed the extracted row did not run).
 * - Result is sorted by `storey.elevation` ascending, tiebreak by
 *   `storey.name` locale-compare. Same sort as `useStoreys`.
 */
export function useExtractedStoreys(
  buildingId: string | null,
): MappedStorey[] {
  return (
    useLiveQuery(async () => {
      if (!buildingId) return [] as MappedStorey[];

      const rows = await db.extractedStoreys
        .where("buildingId")
        .equals(buildingId)
        .toArray();

      if (rows.length === 0) return [] as MappedStorey[];

      // One .get() per row. The set is small (a building rarely has
      // more than a few dozen storeys), so N round-trips is fine
      // and keeps the join type-safe without a temp Map of storeys.
      const out: MappedStorey[] = [];
      for (const row of rows) {
        const storey = await db.storeys.get(row.storeyId);
        if (!storey) {
          // Orphan: the storey was deleted but the extracted row
          // was not. Surface in dev so the cascade gap is visible.
          // Production builds will still behave correctly (we just
          // skip the row).
          // eslint-disable-next-line no-console
          if (typeof console !== "undefined") {
            console.warn(
              `[useExtractedStoreys] orphan extracted row ${row.id} for missing storey ${row.storeyId} in building ${buildingId}`,
            );
          }
          continue;
        }
        out.push({ extractedId: row.id, storey });
      }

      // Stable sort: lowest elevation first, name as tiebreak.
      out.sort((a, b) => {
        if (a.storey.elevation !== b.storey.elevation) {
          return a.storey.elevation - b.storey.elevation;
        }
        return a.storey.name.localeCompare(b.storey.name);
      });

      return out;
    }, [buildingId]) ?? []
  );
}
