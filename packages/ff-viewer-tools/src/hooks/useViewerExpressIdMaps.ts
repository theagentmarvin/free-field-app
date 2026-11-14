// apps/models/src/hooks/useViewerExpressIdMaps.ts
//
// Reads the loaded fragments models from the IfcViewer handle
// to build the ID maps the filter pipeline uses for per-model
// visibility decisions (hide/show entire models, filter by
// model name in the Models auto-folder, isolate by level).
//
//   - `modelToExpressIds` : ifcFileId → Set of IDs (TOE local IDs)
//                           in that loaded model's fragments
//   - `levelToExpressIds` : storey name → modelId → Set of IDs (TOE local IDs,
//                           queried from the model's spatial
//                           structure at runtime — search-set
//                           Search Sets semantics)
//   - `customToExpressIds`: `${groupId}::${entryId}` → modelId → Set of IDs
//                           matching the user-created filter
//                           (Task 23 — populated by the
//                           in-memory inverted index)

import { useEffect, useMemo, useState, type RefObject } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import type { IfcViewerHandle } from "@ff/viewer-react";
import { useViewerToolsDataSource } from "../dataSource";

import type { ModelsToolFilters, PerModelIds } from "./filterResolution";
import { useModelPropertyIndex } from "./useModelPropertyIndex";
import { evaluateActivePresets } from "./customPresetEvaluator";
import { collectActiveCustomPresets } from "./collectActiveCustomPresets";
import { useModelsToolStore } from "../modelsToolStore";
import { usePropertyIndexStore } from "../propertyIndexStore";

/**
 * Return the filter data maps.
 *
 * React lifecycle note: we do NOT depend on `viewerRef` in any
 * `useEffect` deps array, because the ref object is stable
 * (never changes reference across renders) — only
 * `viewerRef.current` changes, and reading that doesn't trigger
 * a re-render. Depending on the ref directly creates a deadlock
 * where the effect bails on first render (handle not yet
 * attached) and can never re-run. We work around this with two
 * effects:
 *
 *   1. A no-deps effect that reads `viewerRef.current` on every
 *      render and syncs it into local `handle` state.
 *   2. A `[handle]`-deps effect: subscribes to
 *      `onLoadedModelsChange`, fetches `getAllModelExpressIds`
 *      inside the callback (after FragmentsManager is ready).
 */
export function useViewerExpressIdMaps(
  viewerRef?: RefObject<IfcViewerHandle>,
): ModelsToolFilters {
  const [modelToExpressIds, setModelToExpressIds] = useState<
    Map<string, Set<number>>
  >(() => new Map());
  const [levelToExpressIds, setLevelToExpressIds] = useState<
    Map<string, PerModelIds>
  >(() => new Map());
  const [handle, setHandle] = useState<IfcViewerHandle | null>(null);

  // (1) Sync viewerRef.current → local handle state on every render.
  useEffect(() => {
    const h = viewerRef?.current ?? null;
    if (h !== handle) setHandle(h);
  });

  // (2) Subscribe to model-load events. Fetches express IDs
  // INSIDE the callback so FragmentsManager is guaranteed ready.
  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    // Wave 63: keep OUR unsubscribe — `onLoadedModelsChange(null)`
    // dropped every other subscriber (property index, LinkView) too.
    const off = handle.onLoadedModelsChange(() => {
      if (cancelled) return;
      void (async () => {
        try {
          const raw = await handle.getAllModelExpressIds();
          if (cancelled) return;
          setModelToExpressIds(
            new Map(Array.from(raw.entries(), ([k, v]) => [k, new Set(v)])),
          );
        } catch (err: unknown) {
          // eslint-disable-next-line no-console
          console.warn(
            "[useViewerExpressIdMaps] getAllModelExpressIds failed",
            err,
          );
        }
      })();
    });

    return () => {
      cancelled = true;
      off?.();
    };
  }, [handle]);

  // Storey rows from the injected data source — used to populate
  // the Levels filter UI entries AND to match spatial-structure
  // storey names to Dexie storey IDs. Wrapped in `useLiveQuery` so
  // Dexie's global observation keeps this reactive (the adapter
  // reads `db.storeys` inside the querier).
  const ds = useViewerToolsDataSource();
  const storeyRows = useLiveQuery(() => ds.queryStoreys(), [ds]);

  // (3) search-set-style: build levelToExpressIds from the model's
  // spatial structure at query time. Runs when modelToExpressIds
  // changes (model loaded) AND storeyRows are available.
  useEffect(() => {
    if (!handle || modelToExpressIds.size === 0) return;
    if (!storeyRows || storeyRows.length === 0) return;
    let cancelled = false;

    void (async () => {
      try {
        const next = new Map<string, PerModelIds>();
        // Wave 33 — levels are keyed by storey NAME (trimmed), not by
        // per-model storeyId, so two federated models each carrying
        // "Level 1" resolve to ONE level entry. The express IDs from
        // every model that has that storey name are grouped under the
        // name, PER MODEL (wave 63 — ids overlap across models), matching `queryLevels` which now emits one auto-filter
        // entry per unique name. `knownNames` guards to storeys that
        // actually exist in Dexie, so a spatial-structure-only storey
        // is never offered to the filter.
        const knownNames = new Set<string>(
          storeyRows.map((s) => s.name.trim()),
        );

        for (const modelId of modelToExpressIds.keys()) {
          if (cancelled) return;
          const levelMap = await handle.getModelLevelLocalIds(modelId);
          if (!levelMap) continue;
          for (const [storeyName, localIds] of levelMap) {
            const key = storeyName.trim();
            if (!knownNames.has(key)) continue;
            let perModel = next.get(key);
            if (!perModel) {
              perModel = new Map();
              next.set(key, perModel);
            }
            const existing = perModel.get(modelId);
            if (existing) {
              for (const id of localIds) existing.add(id);
            } else {
              perModel.set(modelId, new Set(localIds));
            }
          }
        }

        if (cancelled) return;
        setLevelToExpressIds(next);
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.warn(
          "[useViewerExpressIdMaps] getModelLevelLocalIds failed",
          err,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handle, modelToExpressIds, storeyRows]);

  // Task 23: build the in-memory inverted index per model.
  useModelPropertyIndex(viewerRef);

  const storeIndices = usePropertyIndexStore((s) => s.indices);
  const storeAllLocalIds = usePropertyIndexStore((s) => s.allLocalIds);

  const customActive = useModelsToolStore((s) => s.filters.customActive);
  const customHidden = useModelsToolStore((s) => s.filters.customHidden);
  const customTree = useModelsToolStore((s) => s.filters.customTree);

  const customToExpressIds = useMemo(() => {
    const state = useModelsToolStore.getState();
    const activePresets = collectActiveCustomPresets();
    if (activePresets.length === 0 || storeIndices.size === 0) {
      return new Map<string, PerModelIds>();
    }
    const result = evaluateActivePresets(
      activePresets,
      state.filters,
      storeIndices,
      storeAllLocalIds,
    );
    return result.byPreset;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customActive, customHidden, customTree, storeIndices, storeAllLocalIds]);

  // Wave 63: a STABLE object across renders. A fresh literal here made
  // every render of the host (e.g. a selection click) look like new
  // filter data, so `useModelsToolFilter` re-resolved and re-sent the
  // full visibility of every model.
  return useMemo(
    () => ({ modelToExpressIds, levelToExpressIds, customToExpressIds }),
    [modelToExpressIds, levelToExpressIds, customToExpressIds],
  );
}
