// packages/ff-viewer-tools/src/manualVisibilityStore.ts
//
// Wave 48 — durable manual-visibility overlay for the right-click context
// toolbar. The wave-47 toolbar called `setElementVisibility` directly and
// kept no record, so the auto-filter reapplication pass in
// `useModelsToolFilter` (which re-applies the FULL filter-derived visible
// set on every rerun) clobbered hide/isolate the moment the selection
// changed and the effect refired.
//
// This store is the single source of truth for MANUAL visibility. The
// filter pipeline reads it, merges it with the auto/custom filter result,
// and applies the FINAL set. Because the manual overlay is independent of
// the filter state and the selection, a deselect (or any other rerun) can
// re-apply the effect all it wants — the merge is idempotent w.r.t. manual
// ops.
//
// Merge semantics (see `computeFinalVisibleSets`):
//   - `isolate != null`  → final = matching ∩ isolate.visible
//   - else               → final = matching − hidden

import { create } from "zustand";

export interface ManualIsolate {
  /** When non-null, ONLY these ids may be visible (per model). */
  visible: Map<string, Set<number>>;
}

export interface ManualVisibilityState {
  /** Accumulated manual hides: modelId → localIds. */
  hidden: Map<string, Set<number>>;
  /** Active isolate set, or null when nothing is isolated. */
  isolate: ManualIsolate | null;
}

interface ManualVisibilityActions {
  /**
   * Accumulate `ids` into the manual-hide set for `modelId`. Also removes
   * those ids from an active isolate set so "hide while isolated" works —
   * the merge ignores `hidden` while `isolate` is non-null, so removing
   * from the isolate set is the only way a hide can take effect then.
   */
  hideIds(modelId: string, ids: ReadonlySet<number>): void;
  /** Replace the isolate set so ONLY the given ids (per model) are visible. */
  isolateTo(map: ReadonlyMap<string, ReadonlySet<number>>): void;
  /** Clear both the hide and isolate overlays (restore full-filter view). */
  showAll(): void;
  /**
   * Wave 54 — replace BOTH overlays wholesale (saved-viewpoint restore).
   * `null` (or empty maps) is equivalent to showAll(). The filter effect
   * re-applies on the store change, so callers never touch the handle.
   */
  replaceOverlay(next: {
    hidden: ReadonlyMap<string, ReadonlySet<number>>;
    isolate: { visible: ReadonlyMap<string, ReadonlySet<number>> } | null;
  } | null): void;
  /** Forget a model's overlay entries (call on dispose/version-replace). */
  clearModel(modelId: string): void;
}

export type ManualVisibilityStore = ManualVisibilityState &
  ManualVisibilityActions;

export const useManualVisibilityStore = create<ManualVisibilityStore>(
  (set) => ({
    hidden: new Map(),
    isolate: null,

    hideIds: (modelId, ids) =>
      set((state) => {
        const existing = state.hidden.get(modelId) ?? new Set<number>();
        const merged = new Set(existing);
        for (const id of ids) merged.add(id);
        const nextHidden = new Map(state.hidden);
        nextHidden.set(modelId, merged);

        let nextIsolate = state.isolate;
        if (nextIsolate) {
          const modelVisible = nextIsolate.visible.get(modelId);
          if (modelVisible && modelVisible.size > 0) {
            const nextModelVisible = new Set(modelVisible);
            for (const id of ids) nextModelVisible.delete(id);
            const visible = new Map(nextIsolate.visible);
            visible.set(modelId, nextModelVisible);
            nextIsolate = { visible };
          }
        }
        return { hidden: nextHidden, isolate: nextIsolate };
      }),

    isolateTo: (map) =>
      set(() => {
        const visible = new Map<string, Set<number>>();
        for (const [modelId, ids] of map) {
          visible.set(modelId, new Set(ids));
        }
        return { isolate: { visible } };
      }),

    showAll: () => set({ hidden: new Map(), isolate: null }),

    replaceOverlay: (next) =>
      set(() => {
        if (!next) return { hidden: new Map(), isolate: null };
        const hidden = new Map<string, Set<number>>();
        for (const [modelId, ids] of next.hidden) {
          if (ids.size > 0) hidden.set(modelId, new Set(ids));
        }
        const isolate = next.isolate
          ? {
              visible: new Map<string, Set<number>>(
                Array.from(next.isolate.visible, ([modelId, ids]) => [
                  modelId,
                  new Set(ids),
                ]),
              ),
            }
          : null;
        return { hidden, isolate };
      }),

    clearModel: (modelId) =>
      set((state) => {
        const nextHidden = new Map(state.hidden);
        nextHidden.delete(modelId);
        let nextIsolate = state.isolate;
        if (nextIsolate) {
          const visible = new Map(nextIsolate.visible);
          if (visible.delete(modelId)) {
            nextIsolate = { visible };
          }
        }
        return { hidden: nextHidden, isolate: nextIsolate };
      }),
  }),
);

/**
 * The overlay slice `computeFinalVisibleSets` reads — structural, so
 * consumers can pass the store state directly (its `hidden` /
 * `isolate` fields match this shape).
 */
export interface ManualVisibilityOverlay {
  hidden: ReadonlyMap<string, ReadonlySet<number>>;
  isolate: { visible: ReadonlyMap<string, ReadonlySet<number>> } | null;
}

/**
 * Compute the final per-model visible/hidden split from the filter
 * `matching` set and the manual overlay.
 *
 *   - `isolate != null` → `final = matching ∩ isolate.visible`
 *   - else             → `final = matching − hidden`
 *
 * Idempotent w.r.t. the overlay: re-running with the same inputs returns
 * the same split, so the filter effect can refire on deselect without
 * undoing a manual hide/isolate. Pure — no React, no viewer.
 */
export function computeFinalVisibleSets(
  modelId: string,
  modelIds: ReadonlySet<number>,
  matching: ReadonlySet<number>,
  overlay: ManualVisibilityOverlay,
): { visible: Set<number>; hidden: Set<number> } {
  const visible = new Set<number>();
  const hidden = new Set<number>();
  const hiddenIds = overlay.hidden.get(modelId);
  const isolateVisible = overlay.isolate?.visible.get(modelId);
  for (const id of modelIds) {
    const inMatching = matching.has(id);
    let keep: boolean;
    if (overlay.isolate) {
      keep = inMatching && (isolateVisible?.has(id) ?? false);
    } else {
      keep = inMatching && !(hiddenIds?.has(id) ?? false);
    }
    if (keep) visible.add(id);
    else hidden.add(id);
  }
  return { visible, hidden };
}