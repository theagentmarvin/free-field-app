// apps/models/__tests__/hooks/customPresetEvaluator.test.ts
//
// Task 23 — unit tests for the pure `evaluateActivePresets`
// function in `customPresetEvaluator.ts`. The function produces
// the `customToExpressIds` map that the existing filter
// pipeline consumes. It wires the existing
// `evaluatePreset` / `evaluateGroup` from `filterEvaluator.ts`
// to the in-memory inverted index from
// `useModelPropertyIndex`.
//
// We exercise:
//   - AND within a group (multiple rules → intersection)
//   - OR within a group (multiple rules → union)
//   - AND across groups (multiple groups → intersection)
//   - OR across groups (multiple groups → union)
//   - Hidden preset exclusion
//   - Multi-model union
//   - Single-rule preset
//   - Empty preset (vacuous-truth semantics)

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildInvertedIndex,
  type InvertedIndex,
  type PropertyDataRow,
} from "../../../../packages/ff-viewer-react/src/indexPropertyData";

import { evaluateActivePresets } from "../../src/hooks/customPresetEvaluator";
import { useModelsToolStore, type FilterPreset } from "../../src/modelsToolStore";

beforeEach(() => {
  // Reset the store between tests so a prior test's tree / sets
  // don't leak into the next.
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
});

function makePreset(overrides: Partial<FilterPreset> = {}): FilterPreset {
  return {
    id: overrides.id ?? "p1",
    name: overrides.name ?? "P1",
    combinator: overrides.combinator ?? "AND",
    groups: overrides.groups ?? [
      {
        id: "g1",
        combinator: "AND",
        rules: [
          {
            id: "r1",
            property: "_IfcClass",
            operator: "equals",
            value: "IfcWall",
          },
        ],
      },
    ],
  };
}

/** Union of every model's matches (fixtures here never collide). */
function ids(m: Map<string, Set<number>>): number[] {
  const out = new Set<number>();
  for (const s of m.values()) for (const id of s) out.add(id);
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Build an index and `allLocalIds` map for a single model. The
 * rows are the property data extracted from the model; the
 * index is the inverted Map produced by `buildInvertedIndex`.
 */
function buildSingleModelIndex(
  rows: PropertyDataRow[],
): { indices: Map<string, InvertedIndex>; allLocalIds: Map<string, Set<number>> } {
  return {
    indices: new Map([["model-A", buildInvertedIndex(rows)]]),
    allLocalIds: new Map([
      ["model-A", new Set(rows.map((r) => r.localId))],
    ]),
  };
}

describe("evaluateActivePresets", () => {
  it("AND within a group intersects rule matches", () => {
    // Model with 4 elements:
    //   id 1: Wall, FireRating 2HR
    //   id 2: Wall, FireRating 1HR
    //   id 3: Slab, FireRating 2HR
    //   id 4: Wall, FireRating 2HR
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 2, properties: { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "1HR" } },
      { localId: 3, properties: { _IfcClass: "IfcSlab", "Pset_WallCommon.FireRating": "2HR" } },
      { localId: 4, properties: { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "2HR" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    // Build the preset + tree so `findPresetLocation` resolves.
    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
            { id: "r2", property: "Pset_WallCommon.FireRating", operator: "equals", value: "2HR" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    expect(result.byPreset.size).toBe(1);
    const key = Array.from(result.byPreset.keys())[0];
    // Walls AND FireRating 2HR → ids 1 and 4.
    expect(ids(result.byPreset.get(key)!)).toEqual([1, 4]);
  });

  it("OR within a group unions rule matches", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
      { localId: 3, properties: { _IfcClass: "IfcDoor" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "OR",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
            { id: "r2", property: "_IfcClass", operator: "equals", value: "IfcSlab" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Walls OR Slabs → ids 1, 2 (not the door).
    expect(ids(result.byPreset.get(key)!)).toEqual([1, 2]);
  });

  it("AND across groups intersects group matches", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall", "Pset_WallCommon.IsExternal": "true" } },
      { localId: 2, properties: { _IfcClass: "IfcWall", "Pset_WallCommon.IsExternal": "false" } },
      { localId: 3, properties: { _IfcClass: "IfcSlab", "Pset_WallCommon.IsExternal": "true" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      combinator: "AND",
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
          ],
        },
        {
          id: "g2",
          combinator: "AND",
          rules: [
            { id: "r2", property: "Pset_WallCommon.IsExternal", operator: "equals", value: "true" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Wall ∧ IsExternal=true → id 1 only.
    expect(ids(result.byPreset.get(key)!)).toEqual([1]);
  });

  it("OR across groups unions group matches", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
      { localId: 3, properties: { _IfcClass: "IfcDoor" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      combinator: "OR",
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
          ],
        },
        {
          id: "g2",
          combinator: "AND",
          rules: [
            { id: "r2", property: "_IfcClass", operator: "equals", value: "IfcSlab" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Wall ∨ Slab → ids 1, 2.
    expect(ids(result.byPreset.get(key)!)).toEqual([1, 2]);
  });

  it("hidden preset is excluded even if active", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset();
    const { createCustomFolder, upsertCustomFilter } =
      useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    const leafId = upsertCustomFilter(folderId, preset);
    // Activate, then hide.
    useModelsToolStore.getState().setCustomFilterActive(folderId, leafId, true);
    useModelsToolStore.getState().setCustomFilterHidden(folderId, leafId, true);

    const state = useModelsToolStore.getState();
    // The caller is supposed to pass only active presets, but
    // hidden wins at evaluation time. Pass the preset anyway.
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    expect(result.byPreset.size).toBe(0);
  });

  it("multi-model: preset match is the union across models", () => {
    // Model A has one wall (id 100); model B has one wall (id 200)
    // and one slab (id 201).
    const rowsA: PropertyDataRow[] = [
      { localId: 100, properties: { _IfcClass: "IfcWall" } },
    ];
    const rowsB: PropertyDataRow[] = [
      { localId: 200, properties: { _IfcClass: "IfcWall" } },
      { localId: 201, properties: { _IfcClass: "IfcSlab" } },
    ];
    const indices = new Map<string, InvertedIndex>([
      ["model-A", buildInvertedIndex(rowsA)],
      ["model-B", buildInvertedIndex(rowsB)],
    ]);
    const allLocalIds = new Map<string, Set<number>>([
      ["model-A", new Set([100])],
      ["model-B", new Set([200, 201])],
    ]);

    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Walls from both models, kept per model.
    const perModel = result.byPreset.get(key)!;
    expect(perModel.get("model-A")).toEqual(new Set([100]));
    expect(perModel.get("model-B")).toEqual(new Set([200]));
  });

  it("keeps colliding local ids separate per model (wave 63)", () => {
    // Both models use local id 1, but only model-B's #1 is a wall.
    const indices = new Map<string, InvertedIndex>([
      ["model-A", buildInvertedIndex([{ localId: 1, properties: { _IfcClass: "IfcSlab" } }])],
      ["model-B", buildInvertedIndex([{ localId: 1, properties: { _IfcClass: "IfcWall" } }])],
    ]);
    const allLocalIds = new Map<string, Set<number>>([
      ["model-A", new Set([1])],
      ["model-B", new Set([1])],
    ]);
    const preset = makePreset();
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);
    const result = evaluateActivePresets(
      [preset],
      useModelsToolStore.getState().filters,
      indices,
      allLocalIds,
    );
    const perModel = Array.from(result.byPreset.values())[0];
    expect(perModel.has("model-A")).toBe(false);
    expect(perModel.get("model-B")).toEqual(new Set([1]));
  });

  it("single-rule preset resolves directly", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "_IfcClass", operator: "equals", value: "IfcWall" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    expect(ids(result.byPreset.get(key)!)).toEqual([1]);
  });

  it("empty preset (no groups) AND combinator matches everything", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({ groups: [] });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Vacuous truth for AND: empty groups list → all elements match.
    expect(ids(result.byPreset.get(key)!)).toEqual([1, 2]);
  });

  it("numeric operator (greater_than) uses the index's numeric path", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { "Pset.W": "10" } },
      { localId: 2, properties: { "Pset.W": "20" } },
      { localId: 3, properties: { "Pset.W": "30" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "Pset.W", operator: "greater_than", value: "15" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    expect(ids(result.byPreset.get(key)!)).toEqual([2, 3]);
  });

  it("is_empty operator returns elements without the property", () => {
    const rows: PropertyDataRow[] = [
      { localId: 1, properties: { _IfcClass: "IfcWall" } },
      { localId: 2, properties: { _IfcClass: "IfcSlab", "Pset_Foo.A": "v" } },
      { localId: 3, properties: { _IfcClass: "IfcDoor" } },
    ];
    const { indices, allLocalIds } = buildSingleModelIndex(rows);

    const preset = makePreset({
      groups: [
        {
          id: "g1",
          combinator: "AND",
          rules: [
            { id: "r1", property: "Pset_Foo.A", operator: "is_empty", value: "" },
          ],
        },
      ],
    });
    const { createCustomFolder, upsertCustomFilter } = useModelsToolStore.getState();
    const folderId = createCustomFolder(null, "Filters");
    upsertCustomFilter(folderId, preset);

    const state = useModelsToolStore.getState();
    const result = evaluateActivePresets(
      [preset],
      state.filters,
      indices,
      allLocalIds,
    );

    const key = Array.from(result.byPreset.keys())[0];
    // Elements WITHOUT the Pset_Foo.A property: 1, 3.
    expect(ids(result.byPreset.get(key)!)).toEqual([1, 3]);
  });
});
