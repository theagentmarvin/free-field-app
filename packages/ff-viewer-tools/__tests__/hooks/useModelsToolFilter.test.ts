// __tests__/hooks/useModelsToolFilter.test.ts
//
// Wave 49 verification (Maintainer ask 2026-11-08 10:50): prove the manual
// hide/isolate overlay coexists correctly with the auto/custom filter
// pipeline at the HOOK level — i.e. the merged final set is what actually
// reaches `setElementVisibility`. The pure merge helper
// (`computeFinalVisibleSets`) is covered in manualVisibilityStore.test.ts;
// this suite pins the wiring: filter reapplication must never clobber a
// manual op, and manual ops must never resurrect filter-hidden elements.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";

import { useModelsToolFilter } from "../../src/hooks/useModelsToolFilter";
import { useModelsToolStore } from "../../src/modelsToolStore";
import { useManualVisibilityStore } from "../../src/manualVisibilityStore";
import type { IfcViewerHandle } from "@ff/viewer-react";

function makeHandle(modelIds: string[]): {
  handle: IfcViewerHandle;
  setElementVisibility: ReturnType<typeof vi.fn>;
} {
  const setElementVisibility = vi.fn();
  const handle = {
    get loadedModelIds() {
      return new Set(modelIds);
    },
    setElementVisibility,
  } as unknown as IfcViewerHandle;
  return { handle, setElementVisibility };
}

function baseData() {
  return {
    modelToExpressIds: new Map<string, Set<number>>([
      ["m1", new Set([1, 2, 3])],
      ["m2", new Set([10, 11])],
    ]),
    levelToExpressIds: new Map<string, Map<string, Set<number>>>(),
    customToExpressIds: new Map<string, Map<string, Set<number>>>(),
  };
}

function resetStores(): void {
  useModelsToolStore.setState({
    filters: {
      auto: {
        models: { enabled: new Set(), hidden: new Set() },
        levels: { enabled: new Set(), hidden: new Set() },
        expanded: { models: true, levels: false },
      },
      customTree: [],
      customActive: new Map(),
      customHidden: new Map(),
    },
    editingPresetId: null,
  });
  useManualVisibilityStore.getState().showAll();
}

afterEach(resetStores);

describe("useModelsToolFilter × manual visibility overlay", () => {
  it("applies filter-only visibility when no overlay is active", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = {
      current: handle,
    } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    renderHook(() => useModelsToolFilter(data, viewerRef));
    // Wildcard filters (nothing enabled/hidden) → everything visible.
    expect(setElementVisibility).toHaveBeenCalledWith(
      "m1",
      new Set([1, 2, 3]),
      true,
    );
    expect(setElementVisibility).toHaveBeenCalledWith(
      "m2",
      new Set([10, 11]),
      true,
    );
  });

  it("manual hide is applied on top of the filter view", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = {
      current: handle,
    } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    renderHook(() => useModelsToolFilter(data, viewerRef));
    setElementVisibility.mockClear();

    act(() => {
      useManualVisibilityStore.getState().hideIds("m1", new Set([1]));
    });

    // Wave 63: only the delta is sent — m1:#1 goes hidden, nothing else.
    expect(setElementVisibility).toHaveBeenCalledTimes(1);
    expect(setElementVisibility).toHaveBeenCalledWith("m1", new Set([1]), false);
  });

  it("a filter change keeps the manual hide applied (merged, not clobbered)", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = {
      current: handle,
    } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    renderHook(() => useModelsToolFilter(data, viewerRef));

    act(() => {
      useManualVisibilityStore.getState().hideIds("m1", new Set([1]));
    });
    setElementVisibility.mockClear();

    // Filter hides model m2 entirely.
    act(() => {
      useModelsToolStore.setState((s) => ({
        filters: {
          ...s.filters,
          auto: {
            ...s.filters.auto,
            models: { enabled: new Set(), hidden: new Set(["m2"]) },
          },
        },
      }));
    });

    // m1: unchanged (manual hide still in force) → nothing re-sent.
    // m2: filter-hidden → everything false.
    expect(setElementVisibility).toHaveBeenCalledTimes(1);
    expect(setElementVisibility).toHaveBeenCalledWith(
      "m2",
      new Set([10, 11]),
      false,
    );
  });

  it("isolate intersects with the filter result", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = {
      current: handle,
    } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    renderHook(() => useModelsToolFilter(data, viewerRef));
    setElementVisibility.mockClear();

    act(() => {
      useManualVisibilityStore
        .getState()
        .isolateTo(new Map([["m1", new Set([2])]]));
    });

    // m1:#2 was already visible → only the newly hidden ids go out.
    expect(setElementVisibility).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
    );
    expect(setElementVisibility).toHaveBeenCalledWith(
      "m1",
      new Set([1, 3]),
      false,
    );
    // m2 has no isolate entry → fully hidden while isolated.
    expect(setElementVisibility).toHaveBeenCalledWith(
      "m2",
      new Set([10, 11]),
      false,
    );
  });

  it("show-all restores the filter view — active filters still apply", () => {
    resetStores();
    // Start with m2 filter-hidden.
    useModelsToolStore.setState((s) => ({
      filters: {
        ...s.filters,
        auto: {
          ...s.filters.auto,
          models: { enabled: new Set(), hidden: new Set(["m2"]) },
        },
      },
    }));
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = {
      current: handle,
    } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    renderHook(() => useModelsToolFilter(data, viewerRef));

    act(() => {
      useManualVisibilityStore.getState().hideIds("m1", new Set([1]));
    });
    setElementVisibility.mockClear();

    act(() => {
      useManualVisibilityStore.getState().showAll();
    });

    // m1:#1 comes back; m2 stays filter-hidden (unchanged → not re-sent).
    expect(setElementVisibility).toHaveBeenCalledTimes(1);
    expect(setElementVisibility).toHaveBeenCalledWith("m1", new Set([1]), true);
  });
});

describe("useModelsToolFilter — memoized, delta-only applies (wave 63)", () => {
  it("a re-render with unchanged inputs sends nothing", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = { current: handle } as MutableRefObject<IfcViewerHandle>;
    const data = baseData();
    const { rerender } = renderHook(() => useModelsToolFilter(data, viewerRef));
    expect(setElementVisibility).toHaveBeenCalled();
    setElementVisibility.mockClear();
    rerender();
    rerender();
    expect(setElementVisibility).not.toHaveBeenCalled();
  });

  it("a reloaded model (new id set) gets its full visibility re-sent", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["m1", "m2"]);
    const viewerRef = { current: handle } as MutableRefObject<IfcViewerHandle>;
    let data = baseData();
    const { rerender } = renderHook(() => useModelsToolFilter(data, viewerRef));
    setElementVisibility.mockClear();
    data = {
      ...data,
      modelToExpressIds: new Map([
        ["m1", new Set([1, 2, 3])],
        ["m2", data.modelToExpressIds.get("m2")!],
      ]),
    };
    rerender();
    expect(setElementVisibility).toHaveBeenCalledTimes(1);
    expect(setElementVisibility).toHaveBeenCalledWith("m1", new Set([1, 2, 3]), true);
  });

  it("filters by model, not by bare id, when ids collide across models", () => {
    resetStores();
    const { handle, setElementVisibility } = makeHandle(["A", "B"]);
    const viewerRef = { current: handle } as MutableRefObject<IfcViewerHandle>;
    const data = {
      modelToExpressIds: new Map([
        ["A", new Set([1, 2])],
        ["B", new Set([1, 2])],
      ]),
      levelToExpressIds: new Map([
        ["L1", new Map([["A", new Set([1])], ["B", new Set([2])]])],
      ]),
      customToExpressIds: new Map<string, Map<string, Set<number>>>(),
    };
    renderHook(() => useModelsToolFilter(data, viewerRef));
    expect(setElementVisibility).toHaveBeenCalledWith("A", new Set([1]), true);
    expect(setElementVisibility).toHaveBeenCalledWith("A", new Set([2]), false);
    expect(setElementVisibility).toHaveBeenCalledWith("B", new Set([2]), true);
    expect(setElementVisibility).toHaveBeenCalledWith("B", new Set([1]), false);
  });
});
