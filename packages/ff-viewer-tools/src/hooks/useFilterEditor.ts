// apps/models/src/hooks/useFilterEditor.ts
//
// Task 20D — bridge between the `editingPresetId` slice of the
// modelsToolStore and the CustomFilterBuilder modal. The hook
// exposes:
//   - `draft`: the FilterPreset being edited (or null)
//   - `hydrate(leafId)`: returns the preset if the leaf is in the
//     tree; null otherwise. Used to decide whether to open the modal.
//   - `submitFor(preset)`: persists the edit (in-memory + the
//     caller-provided Dexie sink).
//
// The store owns the canonical state — `editingPresetId` lives in
// `modelsToolStore`. This hook is a thin React layer over it.

import { useCallback } from "react";

import {
  useModelsToolStore,
  type FilterPreset,
  type UserFilterLeaf,
} from "../modelsToolStore";

export interface UseFilterEditorResult {
  /** The FilterPreset currently being edited, or null. */
  draft: FilterPreset | null;
  /** The leaf id currently being edited, or null. */
  editingPresetId: string | null;
  /**
   * Look up the preset for `leafId` from the store's custom tree.
   * Returns `null` if the leaf is unknown. Callers typically use
   * this to gate opening the modal — if `hydrate` returns null, the
   * leaf was deleted between click and handler.
   */
  hydrate: (leafId: string) => FilterPreset | null;
  /**
   * Persist the edit. Dispatches `updateCustomFilter` on the store
   * (which mutates the in-memory tree) and calls the supplied
   * `persist` callback so the caller can write through to Dexie.
   * Returns the new leaf id (always equal to `leafId`).
   */
  submitFor: (
    leafId: string,
    preset: FilterPreset,
    persist: (preset: FilterPreset) => void | Promise<void>,
  ) => string;
  /**
   * Close the editor. Clears `editingPresetId` on the store.
   * The caller is responsible for hiding the modal.
   */
  close: () => void;
}

/**
 * Walk the custom tree to find a leaf by id. Mirrors the helper in
 * `modelsToolStore.ts` (kept private there) so the hook doesn't need
 * a new public export.
 */
function findLeafById(
  tree: ReturnType<typeof useModelsToolStore.getState>["filters"]["customTree"],
  id: string,
): UserFilterLeaf | null {
  for (const g of tree) {
    for (const c of g.children) {
      if (c.id === id && c.kind === "filter") {
        return c;
      }
    }
    // Recurse into sub-folders.
    const subFolders = g.children.filter(
      (cc): cc is typeof g => cc.kind === "user",
    );
    for (const sub of subFolders) {
      const found = findLeafById([sub], id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Read/write the editing slice of the filter store. Returns a stable
 * object identity across renders (no memoization needed — the hook
 * only exposes callbacks that read fresh state on each call).
 */
export function useFilterEditor(): UseFilterEditorResult {
  const editingPresetId = useModelsToolStore((s) => s.editingPresetId);
  const tree = useModelsToolStore((s) => s.filters.customTree);
  const updateCustomFilter = useModelsToolStore(
    (s) => s.updateCustomFilter,
  );
  const setEditingPreset = useModelsToolStore((s) => s.setEditingPreset);

  const draft: FilterPreset | null = (() => {
    if (!editingPresetId) return null;
    const leaf = findLeafById(tree, editingPresetId);
    return leaf?.preset ?? null;
  })();

  const hydrate = useCallback(
    (leafId: string): FilterPreset | null => {
      const currentTree = useModelsToolStore.getState().filters.customTree;
      const leaf = findLeafById(currentTree, leafId);
      return leaf?.preset ?? null;
    },
    [],
  );

  const submitFor = useCallback(
    (
      leafId: string,
      preset: FilterPreset,
      persist: (preset: FilterPreset) => void | Promise<void>,
    ): string => {
      // Preserve the leaf id — the caller built the preset with
      // `editingPreset.id` so it should already match, but we
      // defensively re-stamp it here.
      const next: FilterPreset = { ...preset, id: leafId };
      updateCustomFilter(leafId, next);
      void persist(next);
      setEditingPreset(null);
      return leafId;
    },
    [updateCustomFilter, setEditingPreset],
  );

  const close = useCallback((): void => {
    setEditingPreset(null);
  }, [setEditingPreset]);

  return {
    draft,
    editingPresetId,
    hydrate,
    submitFor,
    close,
  };
}
