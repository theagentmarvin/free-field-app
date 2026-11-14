// __tests__/hooks/useFilterEditor.test.ts
//
// Task 20D — covers the editor hook (draft + hydrate + submitFor +
// close). Pure React test, no Dexie.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useFilterEditor } from "../../src/hooks/useFilterEditor";
import { useModelsToolStore, type FilterPreset } from "../../src/modelsToolStore";

afterEach(() => {
  // Reset store between tests.
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
});

function makePreset(overrides: Partial<FilterPreset> = {}): FilterPreset {
  return {
    id: overrides.id ?? "preset-editor",
    name: overrides.name ?? "Editor",
    combinator: overrides.combinator ?? "AND",
    groups: overrides.groups ?? [
      {
        id: "g1",
        combinator: "AND",
        rules: [
          {
            id: "r1",
            property: "Pset_WallCommon.FireRating",
            operator: "equals",
            value: "60",
          },
        ],
      },
    ],
  };
}

describe("useFilterEditor", () => {
  it("draft is null when no leaf is being edited", () => {
    const { result } = renderHook(() => useFilterEditor());
    expect(result.current.draft).toBeNull();
    expect(result.current.editingPresetId).toBeNull();
  });

  it("draft reflects the leaf being edited", () => {
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(
      folderId,
      makePreset({ id: "p1", name: "Walls" }),
    );
    const childId = useModelsToolStore.getState().filters.customTree[0]
      ?.children[0]?.id;
    expect(childId).toBeDefined();

    act(() => {
      useModelsToolStore.getState().setEditingPreset(childId!);
    });

    const { result } = renderHook(() => useFilterEditor());
    expect(result.current.draft?.name).toBe("Walls");
    expect(result.current.draft?.id).toBe("p1");
    expect(result.current.editingPresetId).toBe(childId);
  });

  it("hydrate returns the preset for a known leaf id", () => {
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, makePreset({ id: "p2", name: "Doors" }));
    const childId = useModelsToolStore.getState().filters.customTree[0]
      ?.children[0]?.id;

    const { result } = renderHook(() => useFilterEditor());
    expect(result.current.hydrate(childId!)?.name).toBe("Doors");
    expect(result.current.hydrate("does-not-exist")).toBeNull();
  });

  it("submitFor dispatches updateCustomFilter and clears editing", () => {
    const persist = vi.fn();
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, makePreset({ id: "p3", name: "V1" }));
    const childId = useModelsToolStore.getState().filters.customTree[0]
      ?.children[0]?.id;
    expect(childId).toBeDefined();
    act(() => {
      useModelsToolStore.getState().setEditingPreset(childId!);
    });

    const { result } = renderHook(() => useFilterEditor());
    const next = makePreset({ id: "p3", name: "V2" });
    act(() => {
      result.current.submitFor(childId!, next, persist);
    });

    // In-memory tree reflects the update.
    const updatedLeaf = useModelsToolStore.getState().filters.customTree[0]
      ?.children[0];
    if (updatedLeaf?.kind === "filter") {
      expect(updatedLeaf.preset.name).toBe("V2");
    } else {
      expect.fail("expected leaf node");
    }
    // Editor is cleared.
    expect(useModelsToolStore.getState().editingPresetId).toBeNull();
    // Persist callback was invoked.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toEqual(next);
  });

  it("close clears the editing selection", () => {
    const { setEditingPreset } = useModelsToolStore.getState();
    act(() => {
      setEditingPreset("leaf-1");
    });
    expect(useModelsToolStore.getState().editingPresetId).toBe("leaf-1");

    const { result } = renderHook(() => useFilterEditor());
    act(() => {
      result.current.close();
    });
    expect(useModelsToolStore.getState().editingPresetId).toBeNull();
  });
});
