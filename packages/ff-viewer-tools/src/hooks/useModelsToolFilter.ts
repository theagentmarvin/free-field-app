// apps/models/src/hooks/useModelsToolFilter.ts
//
// Wire the filter pipeline to the viewer handle. When the filter
// state or the express-id maps change, we:
//   1. Resolve the set of express IDs that should be visible via
//      `computeMatchingExpressIds` (auto AND of Models + Levels;
//      custom groups AND-joined in from the inverted index).
//   2. For each loaded model, call `handle.setElementVisibility(...)`
//      with the matching express IDs (visible=true) and the
//      non-matching express IDs (visible=false).
//
// The handle internally batches + RAF-flushes these calls with
// separate true/false buckets per model — callers can safely send
// both `visible=true` and `visible=false` in the same frame.
//
// Wave 63: the matching sets are PER MODEL, memoized, and each rerun
// sends only the ids whose visibility changed since the last apply.
//
// Custom filter evaluation: presets are evaluated against the
// in-memory inverted index (built by `useModelPropertyIndex`)
// via `evaluateActivePresets` → `customToExpressIds` map → fed
// into `computeMatchingExpressIds` which AND-joins custom groups
// with the auto filter result. One useEffect is enough; the
// dependency on `data` covers both Dexie live-query updates and
// user toggles.

import { useEffect, useMemo, useRef, type RefObject } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

import { useModelsToolStore } from "../modelsToolStore";
import { useManualVisibilityStore, computeFinalVisibleSets } from "../manualVisibilityStore";
import { computeMatchingExpressIds } from "./filterResolution";

import type { ModelsToolFilters, PerModelIds } from "./filterResolution";

const EMPTY_IDS: ReadonlySet<number> = new Set();

export interface UseModelsToolFilterResult {
  /**
   * The ids that should be visible in the scene, PER MODEL
   * (modelId → ids), given the current filter state and per-model
   * express-id maps. Element ids are only unique within a model, so
   * a flat set would leak one model's match into another (wave 63).
   *
   * Resolved via `computeMatchingExpressIds` (the AND/wildcard/
   * hidden logic from Addendum B §B.3). Stable across renders until
   * the filter state or the maps change.
   */
  matching: ReadonlyMap<string, ReadonlySet<number>>;
}

/**
 * What the hook last sent to the viewer for one model: the
 * `modelToExpressIds` set it was computed against (identity — a new
 * set means the model was (re)loaded and its visibility reset) and
 * the ids it left visible.
 */
interface AppliedModelState {
  base: ReadonlySet<number>;
  visible: Set<number>;
}

export function useModelsToolFilter(
  data: ModelsToolFilters,
  viewerRef?: RefObject<IfcViewerHandle>,
): UseModelsToolFilterResult {
  const filters = useModelsToolStore((s) => s.filters);
  const hidden = useManualVisibilityStore((s) => s.hidden);
  const isolate = useManualVisibilityStore((s) => s.isolate);

  // The per-model "should be visible" sets, resolved by
  // computeMatchingExpressIds which AND-joins the auto filter
  // (Models ∧ Levels) with any active custom presets (evaluated
  // against the inverted index via customToExpressIds). Memoized so
  // an unrelated re-render (e.g. a selection click) neither
  // re-resolves nor re-applies.
  const matching: PerModelIds = useMemo(
    () => computeMatchingExpressIds(filters, data),
    [filters, data],
  );

  // Wave 63: the last state applied per model, so a rerun sends only
  // the ids whose visibility CHANGED instead of the full model.
  const appliedRef = useRef<{
    handle: IfcViewerHandle | null;
    models: Map<string, AppliedModelState>;
  }>({ handle: null, models: new Map() });

  useEffect(() => {
    const handle = viewerRef?.current;
    if (!handle) return;
    const loadedIds = handle.loadedModelIds;
    if (loadedIds.size === 0) return;

    // A different handle (viewer remount) knows nothing of what we sent.
    if (appliedRef.current.handle !== handle) {
      appliedRef.current = { handle, models: new Map() };
    }
    const applied = appliedRef.current.models;
    for (const modelId of Array.from(applied.keys())) {
      if (!loadedIds.has(modelId)) applied.delete(modelId);
    }

    // For each loaded model, resolve the FINAL visible set as the
    // overlay-merge of the filter result and the manual hide/isolate
    // overlay (Wave 48):
    //   isolate != null → matching ∩ isolate.visible
    //   else            → matching − hidden
    // This is idempotent w.r.t. manual ops, so a deselect rerun cannot
    // clobber a hide/isolate the context toolbar applied.
    const overlay = { hidden, isolate };
    for (const modelId of loadedIds) {
      const modelIds = data.modelToExpressIds.get(modelId);
      if (!modelIds || modelIds.size === 0) continue;
      const { visible: visibleInModel, hidden: hiddenInModel } =
        computeFinalVisibleSets(
          modelId,
          modelIds,
          matching.get(modelId) ?? EMPTY_IDS,
          overlay,
        );
      const prev = applied.get(modelId);
      let toShow: Set<number>;
      let toHide: Set<number>;
      if (!prev || prev.base !== modelIds) {
        // First apply for this model load: send everything.
        toShow = visibleInModel;
        toHide = hiddenInModel;
      } else {
        toShow = new Set<number>();
        toHide = new Set<number>();
        for (const id of visibleInModel) {
          if (!prev.visible.has(id)) toShow.add(id);
        }
        for (const id of prev.visible) {
          if (!visibleInModel.has(id)) toHide.add(id);
        }
      }
      if (toShow.size > 0) handle.setElementVisibility(modelId, toShow, true);
      if (toHide.size > 0) handle.setElementVisibility(modelId, toHide, false);
      applied.set(modelId, { base: modelIds, visible: visibleInModel });
    }

    // Custom presets are already AND-joined into `matching` by
    // computeMatchingExpressIds (filterResolution.ts §3). No
    // separate visibility pass needed here.
  }, [matching, data, viewerRef, hidden, isolate]);

  return { matching };
}
