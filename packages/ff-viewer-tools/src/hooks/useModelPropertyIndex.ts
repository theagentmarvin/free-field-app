// apps/models/src/hooks/useModelPropertyIndex.ts
//
// Task 23 (Critic Option C) + Task 24 migration — at model load, build an
// in-memory inverted index of property values for every loaded model.
// The index powers `useViewerExpressIdMaps.customToExpressIds` (which
// the existing filter pipeline already consumes) and the
// `PropertyValueDropdown` combobox in `CustomFilterBuilder`.
//
// **Task 24 change:** the hook now writes the per-model indices
// to `propertyIndexStore` (Zustand) instead of holding them in
// local React state. Consumers (`useViewerExpressIdMaps`,
// `PropertyValueDropdown`) read from the store, avoiding duplicate
// subscriptions and keeping the index as a single source of truth.
//
// The hook subscribes to `IfcViewerHandle.onLoadedModelsChange`,
// fetches property data via `handle.getPropertyDataForModel` (the
// new batched `getItemsData` wrapper added in Task 23), and
// constructs a `Map<modelId, InvertedIndex>`. Per-model index
// builds run sequentially (not in parallel) so a single
// heavy-model load doesn't block the event loop or saturate the
// worker postMessage channel — the batched `getItemsData` calls
// already yield between batches internally.
//
// Build cost (per the Critic's report): 500ms-2s per model on a
// 50k-element IFC. Non-blocking — the model is visible
// immediately, the index is filled in as each batch lands.

import { useEffect, useRef, useState, type RefObject } from "react";

import type {
  PropertyDataRow,
} from "@ff/viewer-react";
import { buildInvertedIndex } from "@ff/viewer-react";
import type { IfcViewerHandle } from "@ff/viewer-react";
import { usePropertyIndexStore } from "../propertyIndexStore";
import { useManualVisibilityStore } from "../manualVisibilityStore";

/** Re-runs after a mid-build unload before a model is left unindexed. */
const MAX_UNLOAD_RETRIES = 5;

/**
 * Return type — `indices` and `allLocalIds` are now convenience
 * selectors from the store (for consumers that prefer the hook
 * shape). `loading` and `error` remain call-scoped.
 */
export interface ModelPropertyIndex {
  /** Per-model inverted index, keyed by ifcFileId (from the store). */
  indices: ReturnType<typeof usePropertyIndexStore.getState>["indices"];
  /** Per-model set of ALL localIds (from the store). */
  allLocalIds: ReturnType<typeof usePropertyIndexStore.getState>["allLocalIds"];
  /** True while at least one model is still building its index. */
  loading: boolean;
  /** The last build error (if any). Cleared on a successful build. */
  error: Error | null;
}

/**
 * Build and maintain the per-model property index.
 *
 * React lifecycle: the ref pattern mirrors
 * `useViewerExpressIdMaps`. We sync `viewerRef.current` to local
 * state on every render (refs are stable; reading `.current`
 * doesn't trigger re-renders), and run the build effect when
 * the handle lands or the model count changes.
 *
 * `modelCount` is bumped by the `onLoadedModelsChange`
 * subscription on every load/dispose, so each event re-runs the
 * effect and triggers a build for any newly-loaded model.
 *
 * Idempotency: the `buildingRef` Set tracks which models are
 * CURRENTLY in-flight (mid-build) or already built. The effect
 * consults this ref on every run so a model that just finished
 * building is NOT re-built on the next `modelCount` tick.
 *
 * Disposal: a model that disappears from `loadedModelIds` is
 * removed from the store on the next effect run. The dispose
 * step is idempotent — re-running it for a model that was
 * already pruned is a no-op. The in-flight marker is also
 * cleared on dispose so a future load of the same modelId gets
 * re-built.
 */
export function useModelPropertyIndex(
  viewerRef?: RefObject<IfcViewerHandle>,
): ModelPropertyIndex {
  // ── Read from the store ──────────────────────────────────────────
  const indices = usePropertyIndexStore((s) => s.indices);
  const allLocalIds = usePropertyIndexStore((s) => s.allLocalIds);

  // Local state — call-scoped flags the store doesn't own.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Refs — internal state that must NOT trigger re-renders.
  // `buildingRef` tracks which models are mid-build or built, so
  // the effect can skip them on subsequent runs.
  const buildingRef = useRef<Set<string>>(new Set());
  // Mirror the store's `indices` for reading inside the effect
  // without subscribing (avoids a build loop).
  const indicesRef = useRef(indices);
  indicesRef.current = indices;

  // ── (1) Sync ref → state on every render ───────────────────────
  const [handle, setHandle] = useState<IfcViewerHandle | null>(null);
  useEffect(() => {
    const h = viewerRef?.current ?? null;
    if (h !== handle) setHandle(h);
  });

  // ── (2) Subscribe to load/dispose events ────────────────────────
  const [modelCount, setModelCount] = useState(0);
  // Bumped when a build was aborted because its model was unloaded
  // mid-walk (see the catch below): one deferred re-run picks the model
  // up again from the live viewer instance, even if the load/dispose
  // notifications coalesced into a single render.
  const [retryTick, setRetryTick] = useState(0);
  const unloadRetriesRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    // Wave 63: remove only OUR listener on cleanup (the legacy
    // `onLoadedModelsChange(null)` cleared every subscriber).
    const off = handle.onLoadedModelsChange(() => {
      if (cancelled) return;
      setModelCount((c) => c + 1);
    });

    return () => {
      cancelled = true;
      off?.();
    };
  }, [handle]);

  // ── (3) Build / dispose effect ─────────────────────────────────
  useEffect(() => {
    if (!handle) return;
    let cancelled = false;
    const loadedIds = Array.from(handle.loadedModelIds);
    const loadedSet = new Set(loadedIds);

    // (a) Prune indices for models that are no longer loaded.
    const store = usePropertyIndexStore.getState();
    const currentIndices = store.indices;
    let pruned = false;
    for (const id of Array.from(currentIndices.keys())) {
      if (!loadedSet.has(id)) {
        store.removeModel(id);
        useManualVisibilityStore.getState().clearModel(id);
        buildingRef.current.delete(id);
        pruned = true;
      }
    }
    // (a2) Wave 31: prune indices built from a SUPERSEDED VERSION of a
    // model that is still loaded. A version replace keeps the modelId,
    // so presence checks cannot see it. This must not rely on observing
    // the instant the old model is disposed: the viewer re-loads under
    // the same id immediately, and if React runs this effect after that,
    // the id was never seen missing — the stale index would survive.
    // Comparing the stored version stamp is race-free.
    const storeVersions = store.versions;
    const currentVersionOf = (id: string): string | null => {
      const host = handle as unknown as {
        getModelVersionKey?: (modelId: string) => string | null;
      };
      // Called as a method, not pulled off the object first: a host may
      // implement this against its own state through `this`, and a
      // detached call would throw there. (Our own mock handle proved it.)
      return typeof host.getModelVersionKey === "function"
        ? host.getModelVersionKey(id) ?? null
        : null;
    };
    let versioned = false;
    for (const id of Array.from(storeVersions.keys())) {
      if (!loadedSet.has(id)) continue; // (a) already handled above
      if (storeVersions.get(id) === currentVersionOf(id)) continue;
      store.removeModel(id);
      useManualVisibilityStore.getState().clearModel(id);
      buildingRef.current.delete(id);
      versioned = true;
    }

    // Re-read after pruning.
    const prunedIndices =
      pruned || versioned
        ? usePropertyIndexStore.getState().indices
        : currentIndices;
    indicesRef.current = prunedIndices;

    // (b) Build indices for newly-loaded models.
    const toBuild = loadedIds.filter((id) => {
      if (buildingRef.current.has(id)) return false;
      if (!prunedIndices.has(id)) return true;
      // An index exists for this id. Keep it only if it was built from
      // the version that is loaded NOW. Hosts that predate
      // `getModelVersionKey` report null on both sides, so they keep the
      // old "trust the cache" behavior instead of thrashing.
      const built = usePropertyIndexStore.getState().versions.get(id);
      return built !== currentVersionOf(id);
    });
    if (toBuild.length === 0) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // NOTE: do NOT add to buildingRef here — if the effect
    // re-runs (modelCount bump during async fetch), the
    // cleanup sets cancelled=true and the in-flight build
    // is killed. Marking "built" before the async work
    // completes means the next effect run skips the model
    // permanently, and the store stays empty.

    void (async () => {
      for (const modelId of toBuild) {
        if (cancelled) return;
        try {
          const rows = (await handle.getPropertyDataForModel(modelId)) ?? [];
          if (cancelled) return;
          const index = buildInvertedIndex(rows);
          const allIds = new Set<number>(
            rows.map((r: PropertyDataRow) => r.localId),
          );
          if (cancelled) return;
          // Mark built BEFORE writing to store so the store write
          // is the durable success signal. If cancelled after this
          // line, the store has the data and the next effect will
          // skip (buildingRef has it) — no double-build.
          buildingRef.current.add(modelId);
          unloadRetriesRef.current.delete(modelId);
          // Write to the store (Zustand batch — single set).
          usePropertyIndexStore.getState().setModelIndex(
            modelId,
            index,
            allIds,
            currentVersionOf(modelId),
          );
          indicesRef.current = usePropertyIndexStore.getState().indices;
          setError(null);
        } catch (err: unknown) {
          if (cancelled) return;
          if (err instanceof Error && err.name === "ModelUnloadedError") {
            // Lifecycle, not failure: the model was disposed while its
            // index was being built (building switch, version swap,
            // viewer remount). Keep no partial index and try again once
            // the viewer has settled; a model that stays gone is pruned.
            buildingRef.current.delete(modelId);
            const tries = (unloadRetriesRef.current.get(modelId) ?? 0) + 1;
            unloadRetriesRef.current.set(modelId, tries);
            if (tries <= MAX_UNLOAD_RETRIES && retryTimer === null) {
              retryTimer = setTimeout(() => setRetryTick((t) => t + 1), 1000);
            }
            continue;
          }
          // eslint-disable-next-line no-console
          console.warn(
            "[useModelPropertyIndex] build failed for",
            modelId,
            err,
          );
          setError(err instanceof Error ? err : new Error(String(err)));
          buildingRef.current.delete(modelId);
        }
      }
      if (!cancelled) {
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, modelCount, retryTick]);

  return { indices, allLocalIds, loading, error };
}
