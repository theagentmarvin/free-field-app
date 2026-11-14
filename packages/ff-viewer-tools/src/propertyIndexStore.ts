// apps/models/src/propertyIndexStore.ts
//
// Task 24 — Zustand store holding the per-model inverted index
// built by `useModelPropertyIndex`. The store decouples the
// build side (the hook) from the consumption side (the filter
// pipeline and the PropertyValueDropdown), avoiding duplicate
// subscriptions on `onLoadedModelsChange`.
//
// The inverted index shape (Task 23):
//   Map<modelId, InvertedIndex>
//     where InvertedIndex = Map<"pset.prop", Map<value, Set<localId>>>

import { create } from "zustand";
import type { InvertedIndex } from "@ff/viewer-react";

export interface PropertyValueOption {
  /** The string value (e.g., "2HR", "IfcWall", "TRUE"). */
  value: string;
  /** Total element count across all loaded models with this value. */
  count: number;
}

export interface PropertyIndexState {
  /** Per-model inverted index, keyed by modelId. */
  indices: Map<string, InvertedIndex>;
  /** Per-model set of all geometric local IDs (for `is_empty` evaluation). */
  allLocalIds: Map<string, Set<number>>;
  /**
   * Wave 31: which model VERSION each index was built from, keyed by
   * modelId. A version replace keeps the same `file.id` (only the
   * frag blob key moves), so `indices.has(modelId)` alone cannot tell
   * "already built" from "built from replaced-out bytes". `null` means
   * the host could not say — treated as unknown, never as a match.
   */
  versions: Map<string, string | null>;
  /** Whether the index build is currently in progress for any model. */
  loading: boolean;
  /** Last error from a build attempt (null if none). */
  error: Error | null;
}

interface PropertyIndexActions {
  /** Called by useModelPropertyIndex on every load/dispose. */
  setModelIndex(
    modelId: string,
    index: InvertedIndex,
    allIds: Set<number>,
    versionKey?: string | null,
  ): void;
  removeModel(modelId: string): void;
  clearIndices(): void;
}

export const usePropertyIndexStore = create<
  PropertyIndexState & PropertyIndexActions
>((set) => ({
  indices: new Map(),
  allLocalIds: new Map(),
  versions: new Map(),
  loading: false,
  error: null,

  setModelIndex: (modelId, index, allIds, versionKey = null) =>
    set((state) => {
      const newIndices = new Map(state.indices);
      newIndices.set(modelId, index);
      const newAllLocalIds = new Map(state.allLocalIds);
      newAllLocalIds.set(modelId, allIds);
      const newVersions = new Map(state.versions);
      newVersions.set(modelId, versionKey ?? null);
      return {
        indices: newIndices,
        allLocalIds: newAllLocalIds,
        versions: newVersions,
        error: null,
      };
    }),

  removeModel: (modelId) =>
    set((state) => {
      const newIndices = new Map(state.indices);
      newIndices.delete(modelId);
      const newAllLocalIds = new Map(state.allLocalIds);
      newAllLocalIds.delete(modelId);
      const newVersions = new Map(state.versions);
      newVersions.delete(modelId);
      return {
        indices: newIndices,
        allLocalIds: newAllLocalIds,
        versions: newVersions,
      };
    }),

  clearIndices: () =>
    set({
      indices: new Map(),
      allLocalIds: new Map(),
      versions: new Map(),
      loading: false,
      error: null,
    }),
}));

/**
 * Walk all model indices, union the value-sets for the given
 * property, sort by count descending (alphabetical tiebreak),
 * and return the option list for the dropdown.
 *
 * Pure computation helper — exported for unit testing.
 */
export function computeOptions(
  propertyName: string,
  indices: Map<string, InvertedIndex>,
): PropertyValueOption[] {
  if (!propertyName || indices.size === 0) return [];
  const counts = new Map<string, number>();
  for (const index of indices.values()) {
    const valuesMap = index.get(propertyName);
    if (!valuesMap) continue;
    for (const [value, ids] of valuesMap) {
      counts.set(value, (counts.get(value) ?? 0) + ids.size);
    }
  }
  const out: PropertyValueOption[] = [];
  for (const [value, count] of counts) {
    out.push({ value, count });
  }
  // Sort by count descending, then alphabetically for tiebreaks.
  out.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.value.localeCompare(b.value);
  });
  return out;
}
