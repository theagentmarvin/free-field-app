// apps/models/src/hooks/useFilterPresetsForBuilding.ts
//
// Task 20D — Dexie-backed live query for the per-building filter
// presets. Wraps `useLiveQuery` to read from the v6 `filterPresets`
// table and exposes `save()` / `remove()` helpers that mirror the
// store-side actions but write through to IndexedDB.
//
// Per spec §"Hooks":
//   - `useLiveQuery(() => db.filterPresets.where("buildingId")
//      .equals(buildingId).reverse().sortBy("updatedAt"))`
//   - Returns `{ presets, loading, error, save(preset), remove(id) }`
//   - `save()` upserts (Dexie `put`) and stamps `updatedAt`
//
// The hook is intentionally thin — all schema logic lives in
// apps/settings/src/core/db/tables/filterPresets.ts.

import { useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useViewerToolsDataSource } from "../dataSource";

import type { FilterPresetRecord } from "@ff/types";

export interface UseFilterPresetsForBuildingResult {
  /** Live snapshot of presets for the active building, newest first. */
  presets: FilterPresetRecord[];
  /** True while the live query is in-flight (cold start, no data yet). */
  loading: boolean;
  /** Error from the underlying Dexie read, if any. */
  error: Error | undefined;
  /**
   * Insert-or-update a preset. `save` accepts a partial record —
   * `createdAt` and `updatedAt` are stamped automatically by the
   * Dexie helper. Callers should pass `id`, `buildingId`, `name`,
   * `combinator`, and `groups` at minimum.
   */
  save: (preset: FilterPresetRecord) => Promise<FilterPresetRecord>;
  /**
   * Hard-delete a preset by id. Use this in tandem with
   * `useModelsToolStore.deleteCustomFilter` — the store handles the
   * in-memory mirror, this hook handles the on-disk row.
   */
  remove: (id: string) => Promise<void>;
}

/**
 * Read and mutate the per-building filter-preset store.
 *
 * When `buildingId` is `null`, the live query returns an empty
 * array (no building = no presets). `save` / `remove` are still
 * callable but will throw if they receive a record whose
 * `buildingId` doesn't match the active one — Dexie's primary-key
 * index is the source of truth.
 */
export function useFilterPresetsForBuilding(
  buildingId: string | null,
): UseFilterPresetsForBuildingResult {
  const ds = useViewerToolsDataSource();
  // Dexie's live query keys on the dependency array; we pass
  // `[buildingId, ds]` so building switches (or a swapped adapter)
  // trigger a fresh subscription. Reactivity is preserved because
  // `ds.queryFilterPresets` reads the global Dexie instance inside
  // the querier — see dataSource.ts "Reactivity note".
  const result = useLiveQuery<FilterPresetRecord[], FilterPresetRecord[]>(
    async () => {
      if (!buildingId) return [];
      // The adapter returns rows in any order; we sort newest-first
      // in JS so the hook API stays declarative.
      const rows = await ds.queryFilterPresets(buildingId);
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows;
    },
    [buildingId, ds],
    [],
  );

  // Normalise `result` into the public shape. `useLiveQuery` returns
  // `undefined` on first render before the query has resolved; we
  // surface that as `loading: true`.
  const loading = result === undefined;
  const presets = result ?? [];

  const save = useCallback(
    async (preset: FilterPresetRecord): Promise<FilterPresetRecord> => {
      if (!buildingId) {
        throw new Error(
          "useFilterPresetsForBuilding.save: no active buildingId",
        );
      }
      // Force the buildingId from the hook scope so a stale caller
      // can't write a record into the wrong building's row space.
      return ds.saveFilterPreset({ ...preset, buildingId });
    },
    [buildingId, ds],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await ds.removeFilterPreset(id);
    },
    [ds],
  );

  return {
    presets,
    loading,
    error: undefined,
    save,
    remove,
  };
}
