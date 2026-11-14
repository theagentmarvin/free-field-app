// apps/models/__tests__/hooks/useModelPropertyIndex.test.ts
//
// Task 23 — focused tests for the `useModelPropertyIndex` hook.
// We exercise four behaviors:
//   1. The hook builds an index for a newly-loaded model.
//   2. The hook drops the index for a model that is disposed.
//   3. The hook logs an error and recovers if
//      `getPropertyDataForModel` throws.
//   4. The hook does NOT re-build an already-indexed model
//      when `modelCount` ticks for an unrelated reason.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RefObject } from "react";

import { useModelPropertyIndex } from "../../src/hooks/useModelPropertyIndex";
import { usePropertyIndexStore } from "../../src/propertyIndexStore";

import type { IfcViewerHandle } from "@ff/viewer-react";
import type { PropertyDataRow } from "../../../../packages/ff-viewer-react/src/indexPropertyData";

// ── Mock handle factory ─────────────────────────────────────────

interface MockHandle extends IfcViewerHandle {
  _loadedModelIds: Set<string>;
  _versions: Map<string, string | null>;
  _listeners: Set<(count: number) => void>;
  getPropertyDataForModel: ReturnType<typeof vi.fn>;
  onLoadedModelsChange: ReturnType<typeof vi.fn>;
}

function makeMockHandle(opts: {
  initialIds?: string[];
  propertyData?: Map<string, PropertyDataRow[]>;
  throwOn?: string;
} = {}): MockHandle {
  const loadedIds = new Set(opts.initialIds ?? []);
  const listeners = new Set<(count: number) => void>();
  const propertyData = opts.propertyData ?? new Map();
  const onLoadedChange = vi.fn((cb: ((count: number) => void) | null) => {
    if (cb === null) {
      listeners.clear();
      return () => undefined;
    }
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });
  const getPropertyData = vi.fn(
    async (modelId: string): Promise<PropertyDataRow[] | null> => {
      if (opts.throwOn && modelId === opts.throwOn) {
        throw new Error(`mock: failed for ${modelId}`);
      }
      return propertyData.get(modelId) ?? [];
    },
  );
  // Wave 31: the loaded version per model id, promoted by tests to
  // simulate `replaceIfcVersion` (same file id, new bytes).
  const handleVersions = new Map<string, string | null>();
  const handle: MockHandle = {
    loadedModelIds: loadedIds,
    _loadedModelIds: loadedIds,
    _listeners: listeners,
    update: vi.fn(async () => undefined),
    openLevel: vi.fn(async () => false),
    closeLevel: vi.fn(),
    pickWorldPoint: vi.fn(async () => null),
    getSelectionWorldCenter: vi.fn(async () => null as { x: number; y: number; z: number } | null),
    getSelectionWorldPoint: vi.fn(() => null as { x: number; y: number; z: number } | null),
    getSelectionWorldNormal: vi.fn(() => null as { x: number; y: number; z: number } | null),
    isSelectionPointPending: vi.fn(() => false),
    getSnapshot: vi.fn((): string | null => null),
    // Wave 30: opaque "did the projection change?" token. This
    // double returns a constant, i.e. "view frozen" — the real
    // handle derives it from the camera matrices.
    getViewportRevision: () => 0,
    // Wave 31: the loaded version per model id. Mutable so a test can
    // promote a version while the model id stays put — the exact
    // situation a version replace creates.
    // the SAME map the reader closes over, so tests can promote a
    // version through handle._versions and the hook sees it
    _versions: handleVersions,
    getModelVersionKey: (modelId: string) => handleVersions.get(modelId) ?? null,
    worldToScreen: vi.fn(() => null),
    getContainer: vi.fn(() => null),
    setActiveTool: vi.fn(),
    activeTool: null,
    zoom: vi.fn(),
    setElementVisibility: vi.fn(),
    setOnElementPick: vi.fn(),
    addFloorPlanPlane: vi.fn(() => "mock-plane-id"),
    removeFloorPlanPlane: vi.fn(),
    selectElement: vi.fn(),
    clearSelection: vi.fn(),
    getSelection: vi.fn(() => new Map()),
    onSelectionChange: vi.fn(),
    onLoadedModelsChange: onLoadedChange,
    getElementData: vi.fn(async () => null),
    getAllModelExpressIds: vi.fn(async () => new Map()),
    getModelLevelLocalIds: vi.fn(async () => null),
    getPropertyDataForModel: getPropertyData,
    getActiveStoreyFloorZ: vi.fn(() => null),
    getModelCentroid: vi.fn(() => null),
    setRestrictedThirdPerson: vi.fn(),
    releaseRestrictedCamera: vi.fn(),
    unprojectToFloorPlane: vi.fn(() => null),
    navigateTo: vi.fn(),
    // Task 23/24 required IfcViewerHandle members — the hook under test
    // never calls them; no-op stubs satisfy the interface (the package's
    // tsc was red at HEAD for the missing setFloorClipPlane, and Task 24
    // added resetCameraToDefault).
    setFloorClipPlane: vi.fn(),
    resetCameraToDefault: vi.fn(),
    // Tasks module (Day 2 prep): the pose methods joined the handle
    // interface; stubs per the same precedent as setFloorClipPlane /
    // resetCameraToDefault above.
    getPose: vi.fn(() => null),
    setViewPose: vi.fn(),
    // Wave 12: 3D measurement tool mode. The hook under test never
    // exercises them — no-op stubs satisfy the extended interface.
    setMeasureMode: vi.fn(),
    clearMeasurements: vi.fn(),
    onMeasureReadout: vi.fn(),
    // Wave 13: 3D section planes. The hook under test never
    // exercises them — no-op stubs satisfy the extended interface
    // (same precedent as setMeasureMode / setViewPose above).
    addSectionPlane: vi.fn(() => true),
    flipLastSectionPlane: vi.fn(),
    clearSectionPlanes: vi.fn(),
    getSectionPlaneCount: vi.fn(() => 0),
    getSectionPlanes: vi.fn(() => []),
    // Wave 54/55 handle additions — no-op stubs satisfy the extended
    // interface (same precedent as the section-plane stubs above).
    fitLevelPlan: vi.fn(async () => true),
    isMeasureInProgress: vi.fn(() => false),
    cancelMeasureCreation: vi.fn(),
    // Wave 58: level-plan framing height. Never exercised here.
    getLevelPlanDistance: vi.fn(() => 50),
  };
  return handle;
}

/**
 * Mount the hook with a mock handle. The mock handle is the
 * `current` of a `RefObject` — the hook reads `viewerRef.current`
 * on every render to pick up the latest handle, and we use a
 * wrapper component to keep the ref stable across renders.
 */
function mountHook(initialHandle: MockHandle) {
  const ref: RefObject<MockHandle> = {
    current: initialHandle,
  };
  // We have to also use the test-handle mock pattern. Pass a
  // RefObject<IfcViewerHandle> — the test handle satisfies the
  // structural type.
  return {
    ref: ref as unknown as RefObject<IfcViewerHandle>,
    ...renderHook(() => useModelPropertyIndex(ref as unknown as RefObject<IfcViewerHandle>)),
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("useModelPropertyIndex", () => {
  beforeEach(() => {
    // Silence the warning noise from the catch block.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an index for a newly-loaded model", async () => {
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
    ];
    const propertyData = new Map([["model-A", rowsA]]);
    const handle = makeMockHandle({
      initialIds: ["model-A"],
      propertyData,
    });
    const { result } = mountHook(handle);

    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });

    const index = result.current.indices.get("model-A")!;
    expect(index.get("_IfcClass")?.get("IfcWall")).toEqual(new Set([1]));
    expect(index.get("_IfcClass")?.get("IfcSlab")).toEqual(new Set([2]));

    expect(result.current.allLocalIds.get("model-A")).toEqual(
      new Set([1, 2]),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("drops the index for a model that is disposed", async () => {
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const rowsB: PropertyDataRow[] = [
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
    ];
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", rowsA],
      ["model-B", rowsB],
    ]);
    const handle = makeMockHandle({
      initialIds: ["model-A", "model-B"],
      propertyData,
    });
    const { result } = mountHook(handle);

    await waitFor(() => {
      expect(result.current.indices.size).toBe(2);
    });

    // Dispose model-A: remove from the loaded set and fire
    // onLoadedModelsChange listeners (the parent hook pattern).
    act(() => {
      handle._loadedModelIds.delete("model-A");
      for (const cb of handle._listeners) {
        cb(handle._loadedModelIds.size);
      }
    });

    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(false);
      expect(result.current.allLocalIds.has("model-A")).toBe(false);
    });
    expect(result.current.indices.has("model-B")).toBe(true);
  });

  it("unmount removes only its own load listener (wave 63)", async () => {
    const handle = makeMockHandle({ initialIds: [] });
    const foreign = vi.fn();
    handle.onLoadedModelsChange(foreign);
    const { unmount } = mountHook(handle);
    await waitFor(() => {
      expect(handle._listeners.size).toBe(2);
    });
    unmount();
    expect(handle._listeners.size).toBe(1);
    expect(handle._listeners.has(foreign)).toBe(true);
  });

  it("logs an error and continues when getPropertyDataForModel throws", async () => {
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", rowsA],
    ]);
    const handle = makeMockHandle({
      initialIds: ["model-A"],
      propertyData,
      throwOn: "model-A",
    });
    const { result } = mountHook(handle);

    await waitFor(() => {
      // Build attempts completed — either with an index (if the
      // call succeeded) or an error (if it failed). For this
      // test, the call throws, so the index is empty and the
      // error flag is set.
      expect(result.current.loading).toBe(false);
    });

    // The catch path drops the in-flight marker and sets the
    // error. The index map does not gain an entry for model-A.
    expect(result.current.indices.has("model-A")).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("treats a mid-build unload as lifecycle: no error, no partial index, retries", async () => {
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const handle = makeMockHandle({
      initialIds: ["model-A"],
      propertyData: new Map([["model-A", rowsA]]),
    });
    // First walk: the model is disposed under it (building switch /
    // viewer remount). The viewer reports that with ModelUnloadedError.
    let calls = 0;
    const realImpl = handle.getPropertyDataForModel.getMockImplementation()!;
    handle.getPropertyDataForModel.mockImplementation(async (id: string) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error(`Model ${id} was unloaded while it was being read`);
        err.name = "ModelUnloadedError";
        throw err;
      }
      return realImpl(id);
    });
    const warn = vi.spyOn(console, "warn");
    const { result } = mountHook(handle);

    // The deferred retry (1 s) rebuilds from the live model.
    await waitFor(
      () => {
        expect(result.current.indices.has("model-A")).toBe(true);
      },
      { timeout: 3000 },
    );
    expect(calls).toBe(2);
    expect(result.current.error).toBeNull();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("build failed")),
    ).toBe(false);
  });

  it("does NOT re-build an already-indexed model on a stale modelCount tick", async () => {
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", rowsA],
    ]);
    const handle = makeMockHandle({
      initialIds: ["model-A"],
      propertyData,
    });
    const { result } = mountHook(handle);

    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });

    const callsAfterFirstBuild = handle.getPropertyDataForModel.mock.calls.length;

    // Fire a modelCount tick for a reason OTHER than a new
    // model being loaded (e.g. a building switch that re-uses
    // the same modelId). The hook should NOT call
    // getPropertyDataForModel again.
    act(() => {
      for (const cb of handle._listeners) {
        cb(handle._loadedModelIds.size);
      }
    });

    // Give the effect a chance to re-run.
    await new Promise((r) => setTimeout(r, 10));

    expect(handle.getPropertyDataForModel.mock.calls.length).toBe(
      callsAfterFirstBuild,
    );
  });

  // Task 24: verify the hook writes to the shared store.
  it("write to the store on successful build", async () => {
    // Dynamic import because the module already imported may
    // reference the same store singleton.
    const { usePropertyIndexStore } = await import(
      "../../src/propertyIndexStore"
    );
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const propertyData = new Map([["model-A", rowsA]]);
    const handle = makeMockHandle({
      initialIds: ["model-A"],
      propertyData,
    });
    const { result } = mountHook(handle);

    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });

    // The store should also have the entry.
    const storeState = usePropertyIndexStore.getState();
    expect(storeState.indices.has("model-A")).toBe(true);
    expect(storeState.allLocalIds.has("model-A")).toBe(true);
  });

  it("removes model from the store on dispose", async () => {
    const { usePropertyIndexStore } = await import(
      "../../src/propertyIndexStore"
    );
    const rowsA: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const rowsB: PropertyDataRow[] = [
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
    ];
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", rowsA],
      ["model-B", rowsB],
    ]);
    const handle = makeMockHandle({
      initialIds: ["model-A", "model-B"],
      propertyData,
    });
    mountHook(handle);

    await waitFor(() => {
      const storeState = usePropertyIndexStore.getState();
      expect(storeState.indices.size).toBe(2);
    });

    act(() => {
      handle._loadedModelIds.delete("model-A");
      for (const cb of handle._listeners) {
        cb(handle._loadedModelIds.size);
      }
    });

    await waitFor(() => {
      const storeState = usePropertyIndexStore.getState();
      expect(storeState.indices.has("model-A")).toBe(false);
      expect(storeState.allLocalIds.has("model-A")).toBe(false);
    });
  });
});

// ─── Wave 31: version invalidation ─────────────────────────────────
//
// A version replace keeps the modelId (`replaceIfcVersion` mints a new
// frag blob key, not a new file), so "is the index built?" cannot answer
// "is the index still about the loaded bytes?". The viewer DOES notify on
// dispose, but the hook must not depend on observing that instant: the
// swap re-loads under the same id immediately, and if the effect runs
// after that, the id was never seen missing and the stale index survives.
// These tests pin the version-stamp path, which is race-free.

describe("useModelPropertyIndex wave 31 version invalidation", () => {
  beforeEach(() => {
    usePropertyIndexStore.getState().clearIndices();
  });

  afterEach(() => {
    usePropertyIndexStore.getState().clearIndices();
  });

  it("rebuilds when a version is promoted under a still-loaded model id", async () => {
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", [{ localId: 1, properties: { _IfcClass: "IfcWall" } }]],
    ]);
    const handle = makeMockHandle({ initialIds: ["model-A"], propertyData });
    handle._versions.set("model-A", "model-A__v1");
    const { result } = mountHook(handle);

    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });
    expect(handle.getPropertyDataForModel).toHaveBeenCalledTimes(1);
    expect(usePropertyIndexStore.getState().versions.get("model-A")).toBe(
      "model-A__v1",
    );

    // v2 becomes latest. Note `model-A` never leaves `_loadedModelIds`:
    // the model id is stable, only the bytes move.
    propertyData.set("model-A", [
      { localId: 7, properties: { _IfcClass: "IfcPipeSegment" } },
    ]);
    act(() => {
      handle._versions.set("model-A", "model-A__v2");
      for (const cb of handle._listeners) cb(handle._loadedModelIds.size);
    });

    await waitFor(() => {
      expect(
        result.current.indices.get("model-A")?.get("_IfcClass")?.get("IfcPipeSegment"),
      ).toEqual(new Set([7]));
    });
    // the replaced-out values are gone, not merged in
    expect(
      result.current.indices.get("model-A")?.get("_IfcClass")?.get("IfcWall"),
    ).toBeUndefined();
    expect(handle.getPropertyDataForModel).toHaveBeenCalledTimes(2);
    expect(usePropertyIndexStore.getState().versions.get("model-A")).toBe(
      "model-A__v2",
    );
  });

  it("does not rebuild when the version is unchanged", async () => {
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", [{ localId: 1, properties: { _IfcClass: "IfcWall" } }]],
    ]);
    const handle = makeMockHandle({ initialIds: ["model-A"], propertyData });
    handle._versions.set("model-A", "model-A__v1");
    const { result } = mountHook(handle);
    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });

    act(() => {
      for (const cb of handle._listeners) cb(handle._loadedModelIds.size);
    });
    await new Promise((r) => setTimeout(r, 40));
    act(() => {
      for (const cb of handle._listeners) cb(handle._loadedModelIds.size);
    });
    await new Promise((r) => setTimeout(r, 40));

    // extra live-query ticks must not re-fetch a whole model's properties
    expect(handle.getPropertyDataForModel).toHaveBeenCalledTimes(1);
    expect(result.current.indices.has("model-A")).toBe(true);
  });

  it("keeps trusting the cache when the host cannot report a version", async () => {
    // A handle predating getModelVersionKey: both sides read null, so the
    // stamp matches and the old "already built" behavior applies — the
    // hook must not thrash on every notify.
    const propertyData = new Map<string, PropertyDataRow[]>([
      ["model-A", [{ localId: 1, properties: { _IfcClass: "IfcWall" } }]],
    ]);
    const handle = makeMockHandle({ initialIds: ["model-A"], propertyData });
    delete (handle as unknown as { getModelVersionKey?: unknown }).getModelVersionKey;
    const { result } = mountHook(handle);
    await waitFor(() => {
      expect(result.current.indices.has("model-A")).toBe(true);
    });
    act(() => {
      for (const cb of handle._listeners) cb(handle._loadedModelIds.size);
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(handle.getPropertyDataForModel).toHaveBeenCalledTimes(1);
  });
});
