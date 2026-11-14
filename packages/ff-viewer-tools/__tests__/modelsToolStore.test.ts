// apps/models/__tests__/modelsToolStore.test.ts
//
// Unit tests for the Filters-related slices of the Models tool store
// (Addendum B §B.2). Covers:
//   - setFilterEnabled / setFilterHidden toggling for auto folders
//   - setAutoFolderExpanded persistence in store state
//   - createCustomFolder / upsertCustomFilter (top-level + nested; Task 20D)
//   - renameCustom (group and leaf)
//   - deleteCustom with cascade
//   - toggleCustomExpanded
//   - setCustomFilterActive / setCustomFilterHidden
//
// The persistence helpers (loadPersistedAutoExpanded / persistAutoExpanded)
// are exercised separately in a couple of smoke tests because they
// need a localStorage polyfill.

import { beforeEach, describe, expect, it } from "vitest";

import {
  loadPersistedAutoExpanded,
  persistAutoExpanded,
  useModelsToolStore,
  type FilterPreset,
} from "../src/modelsToolStore";

// Reset store state between tests. The store is a singleton; we
// restore the default state by hand.
function resetStore(): void {
  const s = useModelsToolStore.getState();
  // Wipe custom tree & active/hidden sets.
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
  });
  void s;
}

beforeEach(() => {
  resetStore();
  // Wipe localStorage between tests.
  try {
    window.localStorage.clear();
  } catch {
    // ignore — localStorage may not be available in some test envs
  }
});

describe("useModelsToolStore — initial state", () => {
  it("starts with empty auto enabled/hidden sets", () => {
    const f = useModelsToolStore.getState().filters;
    expect(f.auto.models.enabled.size).toBe(0);
    expect(f.auto.models.hidden.size).toBe(0);
    expect(f.auto.levels.enabled.size).toBe(0);
    expect(f.auto.levels.hidden.size).toBe(0);
  });

  it("starts with empty customTree and empty custom maps", () => {
    const f = useModelsToolStore.getState().filters;
    expect(f.customTree).toEqual([]);
    expect(f.customActive.size).toBe(0);
    expect(f.customHidden.size).toBe(0);
  });
});

describe("useModelsToolStore — auto folder actions", () => {
  it("setFilterEnabled adds and removes an entry id", () => {
    const { setFilterEnabled } = useModelsToolStore.getState();
    setFilterEnabled("models", "f1", true);
    expect(
      useModelsToolStore.getState().filters.auto.models.enabled.has("f1"),
    ).toBe(true);

    setFilterEnabled("models", "f1", false);
    expect(
      useModelsToolStore.getState().filters.auto.models.enabled.has("f1"),
    ).toBe(false);
  });

  it("setFilterHidden adds and removes an entry id", () => {
    const { setFilterHidden } = useModelsToolStore.getState();
    setFilterHidden("levels", "s1", true);
    expect(
      useModelsToolStore.getState().filters.auto.levels.hidden.has("s1"),
    ).toBe(true);

    setFilterHidden("levels", "s1", false);
    expect(
      useModelsToolStore.getState().filters.auto.levels.hidden.has("s1"),
    ).toBe(false);
  });

  it("setFilterEnabled on one group does not affect the other", () => {
    const { setFilterEnabled } = useModelsToolStore.getState();
    setFilterEnabled("models", "f1", true);
    expect(
      useModelsToolStore.getState().filters.auto.levels.enabled.has("f1"),
    ).toBe(false);
  });

  it("setAutoFolderExpanded stores the new value", () => {
    const { setAutoFolderExpanded } = useModelsToolStore.getState();
    setAutoFolderExpanded("levels", true);
    expect(
      useModelsToolStore.getState().filters.auto.expanded.levels,
    ).toBe(true);
    setAutoFolderExpanded("levels", false);
    expect(
      useModelsToolStore.getState().filters.auto.expanded.levels,
    ).toBe(false);
  });
});

describe("useModelsToolStore — custom folder / filter actions", () => {
  it("createCustomFolder at top level appends to customTree", () => {
    const { createCustomFolder } = useModelsToolStore.getState();
    const id = createCustomFolder(null, "Discipline");
    expect(id).toBeTruthy();
    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree).toHaveLength(1);
    expect(tree[0]?.id).toBe(id);
    expect(tree[0]?.label).toBe("Discipline");
    expect(tree[0]?.parentId).toBeNull();
  });

  it("createCustomFolder under a parent nests the new group", () => {
    const { createCustomFolder } = useModelsToolStore.getState();
    const parentId = createCustomFolder(null, "Discipline");
    const childId = createCustomFolder(parentId, "Structural");
    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree).toHaveLength(1);
    const parent = tree[0];
    expect(parent).toBeDefined();
    expect(parent!.children).toHaveLength(1);
    const child = parent!.children[0];
    expect(child).toBeDefined();
    expect(child!.id).toBe(childId);
    expect(child!.kind).toBe("user");
    expect((child as { parentId: string | null }).parentId).toBe(parentId);
  });

  it("upsertCustomFilter creates a leaf under the given parent (Task 20D)", () => {
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Discipline");
    const preset: FilterPreset = {
      id: "preset-1",
      name: "Walls",
      combinator: "AND",
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            {
              id: "rule-1",
              property: "Pset_WallCommon.IsExternal",
              operator: "equals",
              value: "true",
            },
          ],
        },
      ],
    };
    const leafId = upsertCustomFilter(groupId, preset);
    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree[0]?.children).toHaveLength(1);
    const leaf = tree[0]?.children[0];
    expect(leaf).toBeDefined();
    expect(leaf!.id).toBe(leafId);
    expect(leaf!.kind).toBe("filter");
    if (leaf!.kind === "filter") {
      expect(leaf!.label).toBe("Walls");
      expect(leaf!.parentId).toBe(groupId);
      // Task 20D: the leaf carries the full FilterPreset (groups shape).
      expect(leaf!.preset).toEqual(preset);
    }
    // Filters start OFF by default — new presets are NOT auto-activated.
    // The user explicitly clicks the funnel icon to activate them.
    const active = useModelsToolStore
      .getState()
      .filters.customActive.get(groupId);
    expect(active?.has(leafId)).toBe(false);
  });

  it("renameCustom renames a folder", () => {
    const { createCustomFolder, renameCustom } = useModelsToolStore.getState();
    const id = createCustomFolder(null, "Discipline");
    renameCustom(id, "Disciplines");
    expect(useModelsToolStore.getState().filters.customTree[0]?.label).toBe(
      "Disciplines",
    );
  });

  it("renameCustom renames a filter leaf", () => {
    const { createCustomFolder, upsertCustomFilter, renameCustom } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Discipline");
    const preset: FilterPreset = {
      id: "preset-rename",
      name: "Walls",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    };
    const leafId = upsertCustomFilter(groupId, preset);
    renameCustom(leafId, "All Walls");
    const tree = useModelsToolStore.getState().filters.customTree;
    const leaf = tree[0]?.children[0];
    if (leaf?.kind === "filter") {
      expect(leaf.label).toBe("All Walls");
      // The preset object on the leaf is unchanged by renameCustom —
      // only the leaf's display label moves. This is intentional
      // (renaming a leaf is a display concern, not a ruleset change).
      expect(leaf.preset.name).toBe("Walls");
    } else {
      expect.fail("expected leaf node");
    }
  });

  it("deleteCustom removes a top-level folder and prunes active/hidden", () => {
    const { createCustomFolder, deleteCustom, setCustomFilterActive } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Discipline");
    // touch customActive so we can verify it's pruned on delete
    setCustomFilterActive(groupId, "ghost", true);
    expect(
      useModelsToolStore.getState().filters.customActive.has(groupId),
    ).toBe(true);

    deleteCustom(groupId);

    expect(useModelsToolStore.getState().filters.customTree).toHaveLength(0);
    expect(
      useModelsToolStore.getState().filters.customActive.has(groupId),
    ).toBe(false);
  });

  it("deleteCustom cascades — children of a deleted folder are also gone", () => {
    const { createCustomFolder, upsertCustomFilter, deleteCustom } =
      useModelsToolStore.getState();
    const parentId = createCustomFolder(null, "Discipline");
    const childId = createCustomFolder(parentId, "Structural");
    const preset: FilterPreset = {
      id: "preset-cascade",
      name: "Rebar",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    };
    upsertCustomFilter(childId, preset);

    deleteCustom(parentId);

    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree).toHaveLength(0);
    // child group's active map is also gone
    expect(
      useModelsToolStore.getState().filters.customActive.has(childId),
    ).toBe(false);
  });

  it("toggleCustomExpanded flips a folder's expanded flag", () => {
    const { createCustomFolder, toggleCustomExpanded } =
      useModelsToolStore.getState();
    const id = createCustomFolder(null, "Discipline");
    // freshly created folder is expanded
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.expanded,
    ).toBe(true);

    toggleCustomExpanded(id);
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.expanded,
    ).toBe(false);

    toggleCustomExpanded(id);
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.expanded,
    ).toBe(true);
  });

  it("setCustomFilterActive adds and removes an entry from a group's active set", () => {
    const { createCustomFolder, upsertCustomFilter, setCustomFilterActive } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Discipline");
    const preset: FilterPreset = {
      id: "preset-active",
      name: "Walls",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    };
    const leafId = upsertCustomFilter(groupId, preset);

    // Filters start OFF by default — activate first, then toggle off.
    setCustomFilterActive(groupId, leafId, true);
    expect(
      useModelsToolStore.getState().filters.customActive.get(groupId)?.has(leafId),
    ).toBe(true);

    setCustomFilterActive(groupId, leafId, false);
    expect(
      useModelsToolStore
        .getState()
        .filters.customActive.get(groupId)
        ?.has(leafId),
    ).toBe(false);
  });

  it("setCustomFilterHidden adds and removes an entry from a group's hidden set", () => {
    const { createCustomFolder, upsertCustomFilter, setCustomFilterHidden } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Discipline");
    const preset: FilterPreset = {
      id: "preset-hidden",
      name: "Walls",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    };
    const leafId = upsertCustomFilter(groupId, preset);

    setCustomFilterHidden(groupId, leafId, true);
    expect(
      useModelsToolStore
        .getState()
        .filters.customHidden.get(groupId)
        ?.has(leafId),
    ).toBe(true);

    setCustomFilterHidden(groupId, leafId, false);
    expect(
      useModelsToolStore
        .getState()
        .filters.customHidden.get(groupId)
        ?.has(leafId),
    ).toBe(false);
  });
});

describe("auto-folder expanded persistence", () => {
  it("persistAutoExpanded writes JSON to localStorage", () => {
    persistAutoExpanded({ models: false, levels: true });
    const raw = window.localStorage.getItem("ff:mainapp:auto-folder-expanded");
    expect(raw).toBe('{"models":false,"levels":true}');
  });

  it("loadPersistedAutoExpanded reads what persistAutoExpanded wrote", () => {
    persistAutoExpanded({ models: false, levels: true });
    expect(loadPersistedAutoExpanded()).toEqual({
      models: false,
      levels: true,
    });
  });

  it("loadPersistedAutoExpanded returns null when nothing is stored", () => {
    expect(loadPersistedAutoExpanded()).toBeNull();
  });

  it("loadPersistedAutoExpanded returns null when the payload is malformed", () => {
    window.localStorage.setItem(
      "ff:mainapp:auto-folder-expanded",
      "not-json",
    );
    expect(loadPersistedAutoExpanded()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 20D — schema migration, persistence actions, OR-group UI surface
// ---------------------------------------------------------------------------

describe("Task 20D — schema migration in modelsToolStore", () => {
  it("FilterPreset accepts groups but not rules", () => {
    // The TypeScript compiler is the real check here — this runtime
    // test documents that the type only allows the `groups` shape.
    const preset: FilterPreset = {
      id: "schema-check",
      name: "X",
      combinator: "AND",
      groups: [
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
    expect(preset.groups[0]?.rules).toHaveLength(1);
    expect(preset.combinator).toBe("AND");
  });

  it("ConditionGroup has a stable id and combinator", () => {
    const g = {
      id: "stable-id",
      combinator: "OR" as const,
      rules: [],
    };
    expect(g.id).toBe("stable-id");
    expect(g.combinator).toBe("OR");
  });
});

describe("Task 20D — upsertCustomFilter (update-in-place)", () => {
  it("updates an existing leaf when preset.id matches", () => {
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Filters");
    const v1: FilterPreset = {
      id: "preset-upsert",
      name: "Original",
      combinator: "AND",
      groups: [
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
    const leafId = upsertCustomFilter(groupId, v1);
    const tree1 = useModelsToolStore.getState().filters.customTree;
    expect(tree1[0]?.children).toHaveLength(1);

    const v2: FilterPreset = {
      ...v1,
      name: "Renamed",
      combinator: "OR",
      groups: [
        ...v1.groups,
        {
          id: "g2",
          combinator: "OR",
          rules: [
            {
              id: "r2",
              property: "Pset_WallCommon.FireRating",
              operator: "equals",
              value: "90",
            },
          ],
        },
      ],
    };
    const sameLeafId = upsertCustomFilter(groupId, v2);
    expect(sameLeafId).toBe(leafId); // preserved
    const tree2 = useModelsToolStore.getState().filters.customTree;
    expect(tree2[0]?.children).toHaveLength(1); // still one leaf
    const leaf = tree2[0]?.children[0];
    if (leaf?.kind === "filter") {
      expect(leaf.label).toBe("Renamed");
      expect(leaf.preset.combinator).toBe("OR");
      expect(leaf.preset.groups).toHaveLength(2);
    } else {
      expect.fail("expected leaf node");
    }
  });
});

describe("Task 20D — updateCustomFilter (explicit edit path)", () => {
  it("replaces preset + label on a known leaf id", () => {
    const { createCustomFolder, upsertCustomFilter, updateCustomFilter } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Filters");
    const v1: FilterPreset = {
      id: "preset-edit",
      name: "Old",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    };
    const leafId = upsertCustomFilter(groupId, v1);
    updateCustomFilter(leafId, { ...v1, name: "New" });
    const leaf = useModelsToolStore
      .getState()
      .filters.customTree[0]?.children[0];
    if (leaf?.kind === "filter") {
      expect(leaf.label).toBe("New");
      expect(leaf.preset.name).toBe("New");
    } else {
      expect.fail("expected leaf node");
    }
  });

  it("is a no-op for unknown leaf ids", () => {
    const { updateCustomFilter } = useModelsToolStore.getState();
    const before = useModelsToolStore.getState().filters.customTree;
    updateCustomFilter("does-not-exist", {
      id: "does-not-exist",
      name: "X",
      combinator: "AND",
      groups: [],
    });
    const after = useModelsToolStore.getState().filters.customTree;
    expect(after).toBe(before); // referential equality (no state change)
  });
});

describe("Task 20D — deleteCustomFilter (leaf-only, no cascade)", () => {
  it("removes a leaf and prunes active/hidden entries", () => {
    const { createCustomFolder, upsertCustomFilter, deleteCustomFilter } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Filters");
    const leafId = upsertCustomFilter(groupId, {
      id: "preset-leaf-del",
      name: "X",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    });
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.children,
    ).toHaveLength(1);

    deleteCustomFilter(leafId);
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.children,
    ).toHaveLength(0);
    expect(
      useModelsToolStore
        .getState()
        .filters.customActive.get(groupId)
        ?.has(leafId),
    ).toBe(false);
  });

  it("clears editingPresetId when the deleted leaf was being edited", () => {
    const {
      createCustomFolder,
      upsertCustomFilter,
      deleteCustomFilter,
      setEditingPreset,
    } = useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Filters");
    const leafId = upsertCustomFilter(groupId, {
      id: "preset-edit-del",
      name: "X",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    });
    setEditingPreset(leafId);
    expect(useModelsToolStore.getState().editingPresetId).toBe(leafId);

    deleteCustomFilter(leafId);
    expect(useModelsToolStore.getState().editingPresetId).toBeNull();
  });

  it("does NOT cascade — sibling leaves survive", () => {
    const { createCustomFolder, upsertCustomFilter, deleteCustomFilter } =
      useModelsToolStore.getState();
    const groupId = createCustomFolder(null, "Filters");
    upsertCustomFilter(groupId, {
      id: "preset-keep",
      name: "Keep",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    });
    const delId = upsertCustomFilter(groupId, {
      id: "preset-del",
      name: "Del",
      combinator: "AND",
      groups: [{ id: "g", combinator: "AND", rules: [] }],
    });
    expect(
      useModelsToolStore.getState().filters.customTree[0]?.children,
    ).toHaveLength(2);

    deleteCustomFilter(delId);
    const remaining = useModelsToolStore
      .getState()
      .filters.customTree[0]?.children;
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.kind).toBe("filter");
    if (remaining?.[0]?.kind === "filter") {
      expect(remaining[0].preset.name).toBe("Keep");
    }
  });
});

describe("Task 20D — hydrateFilterPresets (Dexie → store)", () => {
  it("synthesises a parent folder and inserts one leaf per record", () => {
    const { hydrateFilterPresets } = useModelsToolStore.getState();
    hydrateFilterPresets(
      [
        {
          id: "p1",
          buildingId: "b1",
          name: "Fire-rated",
          combinator: "AND",
          groups: [
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
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: "p2",
          buildingId: "b1",
          name: "External walls",
          combinator: "OR",
          groups: [
            {
              id: "g2",
              combinator: "OR",
              rules: [
                {
                  id: "r2",
                  property: "Pset_WallCommon.IsExternal",
                  operator: "equals",
                  value: "true",
                },
              ],
            },
          ],
          createdAt: 3,
          updatedAt: 4,
        },
      ],
      { parentId: null, folderLabel: "Filters" },
    );
    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree).toHaveLength(1);
    expect(tree[0]?.label).toBe("Filters");
    expect(tree[0]?.children).toHaveLength(2);
    const leaf1 = tree[0]?.children[0];
    if (leaf1?.kind === "filter") {
      expect(leaf1.preset.name).toBe("Fire-rated");
      expect(leaf1.preset.combinator).toBe("AND");
      expect(leaf1.preset.groups[0]?.rules).toHaveLength(1);
    }
  });

  it("is idempotent — calling twice yields the same shape", () => {
    const { hydrateFilterPresets } = useModelsToolStore.getState();
    const records = [
      {
        id: "p1",
        buildingId: "b1",
        name: "X",
        combinator: "AND" as const,
        groups: [
          {
            id: "g1",
            combinator: "AND" as const,
            rules: [
              {
                id: "r1",
                property: "P",
                operator: "equals",
                value: "v",
              },
            ],
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    hydrateFilterPresets(records);
    hydrateFilterPresets(records);
    const tree = useModelsToolStore.getState().filters.customTree;
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
  });

  it("re-uses an existing top-level folder instead of duplicating", () => {
    const { createCustomFolder, hydrateFilterPresets } =
      useModelsToolStore.getState();
    createCustomFolder(null, "My Filters");
    hydrateFilterPresets(
      [
        {
          id: "p1",
          buildingId: "b1",
          name: "X",
          combinator: "AND",
          groups: [
            {
              id: "g1",
              combinator: "AND",
              rules: [
                {
                  id: "r1",
                  property: "P",
                  operator: "equals",
                  value: "v",
                },
              ],
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      { parentId: null, folderLabel: "Filters" },
    );
    const tree = useModelsToolStore.getState().filters.customTree;
    // The existing "My Filters" folder is kept; no synthetic
    // "Filters" folder is added because one already exists at the
    // top level.
    expect(tree).toHaveLength(1);
    expect(tree[0]?.label).toBe("My Filters");
  });
});

describe("Task 20D — editingPresetId slice", () => {
  it("starts as null", () => {
    // Reset to initial state for this case.
    useModelsToolStore.setState({ editingPresetId: null });
    expect(useModelsToolStore.getState().editingPresetId).toBeNull();
  });

  it("setEditingPreset stores and clears the id", () => {
    const { setEditingPreset } = useModelsToolStore.getState();
    setEditingPreset("leaf-abc");
    expect(useModelsToolStore.getState().editingPresetId).toBe("leaf-abc");
    setEditingPreset(null);
    expect(useModelsToolStore.getState().editingPresetId).toBeNull();
  });
});

// ─── Task 21: selection state ──────────────────────────────────────────
// Selection is single-element, in-memory (not persisted). The store
// exposes a `selection` slice plus `selectElement` / `clearSelection`
// actions. The viewer reads via `useViewerSelectionSync`; the
// PropertiesDrawer reads directly via Zustand's selector.

describe("useModelsToolStore — selection (Task 21)", () => {
  beforeEach(() => {
    // Each test starts fresh — selection is transient UI state.
    useModelsToolStore.setState({ selection: null });
  });

  it("initial state has selection === null", () => {
    expect(useModelsToolStore.getState().selection).toBeNull();
  });

  it("selectElement sets the selection payload", () => {
    useModelsToolStore.getState().selectElement({
      modelId: "m-1",
      expressId: 42,
    });
    expect(useModelsToolStore.getState().selection).toEqual({
      modelId: "m-1",
      expressId: 42,
    });
  });

  it("selectElement(null) clears the selection", () => {
    useModelsToolStore.getState().selectElement({
      modelId: "m-1",
      expressId: 42,
    });
    expect(useModelsToolStore.getState().selection).not.toBeNull();
    useModelsToolStore.getState().selectElement(null);
    expect(useModelsToolStore.getState().selection).toBeNull();
  });

  it("clearSelection nulls the selection", () => {
    useModelsToolStore.getState().selectElement({
      modelId: "m-1",
      expressId: 42,
    });
    useModelsToolStore.getState().clearSelection();
    expect(useModelsToolStore.getState().selection).toBeNull();
  });

  it("selectElement replaces a previous selection (single-element)", () => {
    useModelsToolStore.getState().selectElement({
      modelId: "m-1",
      expressId: 42,
    });
    useModelsToolStore.getState().selectElement({
      modelId: "m-2",
      expressId: 99,
    });
    expect(useModelsToolStore.getState().selection).toEqual({
      modelId: "m-2",
      expressId: 99,
    });
  });
});
