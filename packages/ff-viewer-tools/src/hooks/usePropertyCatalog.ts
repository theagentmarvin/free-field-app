// apps/models/src/hooks/usePropertyCatalog.ts
//
// In-memory cache of the property catalog for a single file.
//
// Source: db.propertyCatalog via Dexie's `useLiveQuery` (reactive).
// Cache layer: lives in component memory for the session. No Zustand
// slice is needed because every consumer of this hook with the same
// fileId gets the same Dexie subscription result — `dexie-react-hooks`
// caches by [query, deps] across the render tree, so a single live
// query is reused.
//
// Read patterns the filter UI needs (Task 2 / search-set):
//   - List all psets for a file  →  Array.from(byPset.keys())
//   - List properties in a pset  →  byPset.get(psetName) ?? []
//   - Count                       →  count
//
// See docs/task-20c-part-1-property-catalog.md §4.

import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import {
  useViewerToolsDataSource,
  type PropertyCatalogEntryLite,
} from "../dataSource";

export interface PropertyCatalogCache {
  /** All entries for the given file, kept fresh via Dexie live query. */
  entries: PropertyCatalogEntryLite[];
  /** Grouped by pset, for tree-style rendering in the property
   * selector. Sorted alphabetically within each pset. */
  byPset: Map<string, string[]>;
  /** Total entry count — useful for empty states. */
  count: number;
  /** True while Dexie is still hydrating. False after the initial
   * query resolves (even if the resolved set is empty). */
  loading: boolean;
}

/**
 * Hook into the property catalog for a single file. Returns a
 * reactive cache that's stable until Dexie writes (the live query
 * result is referentially stable across re-renders).
 *
 * Pass `null` to clear the subscription (typical when no file is
 * selected). The hook will return an empty cache immediately
 * without hitting Dexie.
 */
export function usePropertyCatalog(
  fileId: string | null,
): PropertyCatalogCache {
  const ds = useViewerToolsDataSource();
  const raw = useLiveQuery(
    async () => {
      if (!fileId) return [] as PropertyCatalogEntryLite[];
      return ds.queryPropertyCatalog(fileId);
    },
    [fileId, ds],
    [] as PropertyCatalogEntryLite[],
  );

  // Grouping is memoized on the raw entries array. The live-query
  // returns a new array reference only when the underlying Dexie
  // table changes, so this is cheap across unrelated re-renders.
  const grouped = useMemo(() => {
    const byPset = new Map<string, string[]>();
    for (const e of raw) {
      const list = byPset.get(e.pset) ?? [];
      list.push(e.name);
      byPset.set(e.pset, list);
    }
    // Sort each pset's properties alphabetically for stable UI order.
    for (const list of byPset.values()) {
      list.sort();
    }
    return byPset;
  }, [raw]);

  // `useLiveQuery` returns `undefined` while the initial query is
  // in flight. Once it resolves it stays at the resolved value
  // (even an empty array). Normalize that into a stable boolean.
  const loading = raw === undefined;

  return {
    entries: raw,
    byPset: grouped,
    count: raw.length,
    loading,
  };
}