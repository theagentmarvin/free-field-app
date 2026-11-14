// apps/models/__tests__/filterResolution.test.ts
//
// Unit tests for `computeMatchingExpressIds` — the AND/OR/wildcard/
// hidden semantics from Addendum B §B.3.
//
// The resolution function is pure: it takes a FilterState + three
// express-id maps and returns a Set<number> of express IDs. The
// maps are empty for the current stub (no viewer data) but the
// semantics can still be exercised by hand-rolling the maps in tests.
//
// Coverage:
//   - Auto Models: empty active = wildcard
//   - Auto Models: non-empty active = restrict to those entries
//   - Auto Models: hidden entries are always off (wildcard and active
//     cases both)
//   - Auto Levels: same semantics as Models
//   - AND across Models + Levels
//   - Custom groups: empty active = wildcard for that group
//   - Custom groups: non-empty active = OR within group, AND across
//     groups
//   - Custom hidden entries are filtered out
//   - Empty maps → empty result (no viewer data path)

import { beforeEach, describe, expect, it } from "vitest";

import {
  computeMatchingExpressIds,
  countPerModelIds,
} from "../src/hooks/filterResolution";
import type { ModelsToolFilters } from "../src/hooks/filterResolution";
import {
  useModelsToolStore,
  type FilterState,
} from "../src/modelsToolStore";

function emptyState(): FilterState {
  return {
    auto: {
      models: { enabled: new Set(), hidden: new Set() },
      levels: { enabled: new Set(), hidden: new Set() },
      expanded: { models: true, levels: false },
    },
    customTree: [],
    customActive: new Map(),
    customHidden: new Map(),
  };
}

function mapsOf<K>(entries: Array<[K, number[]]>): Map<K, Set<number>> {
  const m = new Map<K, Set<number>>();
  for (const [k, v] of entries) m.set(k, new Set(v));
  return m;
}

/**
 * The pre-wave-63 fixtures were written with FLAT level/custom id sets
 * and non-overlapping ids across models. `resolveFlat` lifts them to
 * the per-model shape (each id goes to the model(s) that own it) and
 * flattens the per-model result back, so those semantics tests stay
 * readable. The overlapping-id cases below use the real API directly.
 */
interface FlatFilters {
  modelToExpressIds: Map<string, Set<number>>;
  levelToExpressIds: Map<string, Set<number>>;
  customToExpressIds: Map<string, Set<number>>;
}

function liftToPerModel(
  models: Map<string, Set<number>>,
  flat: Map<string, Set<number>>,
): Map<string, Map<string, Set<number>>> {
  const out = new Map<string, Map<string, Set<number>>>();
  for (const [key, ids] of flat) {
    const perModel = new Map<string, Set<number>>();
    for (const id of ids) {
      for (const [modelId, modelIds] of models) {
        if (!modelIds.has(id)) continue;
        let s = perModel.get(modelId);
        if (!s) perModel.set(modelId, (s = new Set()));
        s.add(id);
      }
    }
    out.set(key, perModel);
  }
  return out;
}

function resolveFlat(state: FilterState, data: FlatFilters): Set<number> {
  const real: ModelsToolFilters = {
    modelToExpressIds: data.modelToExpressIds,
    levelToExpressIds: liftToPerModel(data.modelToExpressIds, data.levelToExpressIds),
    customToExpressIds: liftToPerModel(data.modelToExpressIds, data.customToExpressIds),
  };
  const out = new Set<number>();
  for (const ids of computeMatchingExpressIds(state, real).values()) {
    for (const id of ids) out.add(id);
  }
  return out;
}

let state: FilterState;

beforeEach(() => {
  // Reset the global store (so any tests that touch the store don't
  // leak state into these pure-function tests) and use a fresh,
  // local FilterState for each resolution call.
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
  state = emptyState();
});

describe("computeMatchingExpressIds — Models folder", () => {
  it("empty active set is a wildcard — every visible model entry contributes", () => {
    // Both auto folders are wildcards. To isolate the Models logic
    // we set Levels to the SAME express ids as Models so the AND-join
    // passes everything through. (In production, when the viewer is
    // loaded, Levels contribute their own express ids.)
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([
        ["f1", [10, 11, 12]],
        ["f2", [20, 21]],
      ]),
      levelToExpressIds: mapsOf<string>([
        ["all", [10, 11, 12, 20, 21]],
      ]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([10, 11, 12, 20, 21]));
  });

  it("non-empty active set restricts to those entries only", () => {
    state.auto.models.enabled = new Set(["f1"]);
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([
        ["f1", [10, 11]],
        ["f2", [20, 21]],
      ]),
      levelToExpressIds: mapsOf<string>([["all", [10, 11, 20, 21]]]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([10, 11]));
  });

  it("hidden entries are filtered out under wildcard", () => {
    state.auto.models.hidden = new Set(["f1"]);
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([
        ["f1", [10, 11]],
        ["f2", [20, 21]],
      ]),
      levelToExpressIds: mapsOf<string>([["all", [10, 11, 20, 21]]]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([20, 21]));
  });

  it("hidden entries are filtered out under active set", () => {
    state.auto.models.enabled = new Set(["f1", "f2"]);
    state.auto.models.hidden = new Set(["f2"]);
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([
        ["f1", [10, 11]],
        ["f2", [20, 21]],
      ]),
      levelToExpressIds: mapsOf<string>([["all", [10, 11, 20, 21]]]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([10, 11]));
  });
});

describe("computeMatchingExpressIds — Levels folder", () => {
  it("empty active set is a wildcard — every visible level entry contributes", () => {
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["all", [100, 101, 200]]]),
      levelToExpressIds: mapsOf<string>([
        ["l1", [100, 101]],
        ["l2", [200]],
      ]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([100, 101, 200]));
  });

  it("non-empty active set restricts to those entries only", () => {
    state.auto.levels.enabled = new Set(["l2"]);
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["all", [100, 101, 200]]]),
      levelToExpressIds: mapsOf<string>([
        ["l1", [100, 101]],
        ["l2", [200]],
      ]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([200]));
  });

  it("hidden level entries are filtered out", () => {
    state.auto.levels.hidden = new Set(["l1"]);
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["all", [100, 200]]]),
      levelToExpressIds: mapsOf<string>([
        ["l1", [100]],
        ["l2", [200]],
      ]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([200]));
  });
});

describe("computeMatchingExpressIds — AND across Models + Levels", () => {
  it("an express ID is in the result only if BOTH folders contain it", () => {
    const data: FlatFilters = {
      // Models contribute 10, 11, 20, 21
      modelToExpressIds: mapsOf<string>([
        ["f1", [10, 11]],
        ["f2", [20, 21]],
      ]),
      // Levels contribute 11, 20, 99
      levelToExpressIds: mapsOf<string>([
        ["l1", [11]],
        ["l2", [20, 99]],
      ]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    // Intersection of {10,11,20,21} and {11,20,99} = {11, 20}
    expect(result).toEqual(new Set([11, 20]));
  });

  it("empty intersection yields empty result", () => {
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 11]]]),
      levelToExpressIds: mapsOf<string>([["l1", [99]]]),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set());
  });
});

describe("computeMatchingExpressIds — Custom groups", () => {
  it("empty customActive per group is a wildcard (does not constrain)", () => {
    // Start with a non-empty auto result so we can see that empty
    // custom groups don't remove anything from it. To make Models AND
    // Levels non-empty we feed Levels the same express ids.
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 11]]]),
      levelToExpressIds: mapsOf<string>([["all", [10, 11]]]),
      customToExpressIds: new Map(),
    };
    state.customActive = new Map([
      ["g1", new Set()],
      ["g2", new Set()],
    ]);
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([10, 11]));
  });

  it("non-empty customActive per group narrows by AND within group", () => {
    // Models produce {10, 20, 30}; Levels produce {10, 20, 30}.
    // AND across auto = {10, 20, 30}.
    // Custom group "g1" has active entries e1 → {10, 20, 40} and e2 → {10, 30, 50}.
    // AND within group: {10, 20, 30} ∩ {10, 20, 40} = {10, 20}
    //                   → {10, 20} ∩ {10, 30, 50} = {10}
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 20, 30]]]),
      levelToExpressIds: mapsOf<string>([["all", [10, 20, 30]]]),
      customToExpressIds: mapsOf<string>([
        ["g1::e1", [10, 20, 40]],
        ["g1::e2", [10, 30, 50]],
      ]),
    };
    state.customActive = new Map([["g1", new Set(["e1", "e2"])]]);
    const result = resolveFlat(state, data);
    // Only expressId 10 is in ALL three sets (auto, e1, e2).
    expect(result).toEqual(new Set([10]));
  });

  it("hidden custom entries are filtered out (AND across active presets)", () => {
    // Group g1: active = {e1, e2}; hidden = {e1}
    // So e1 contributes nothing, e2 contributes its ids.
    // Auto = {10, 20, 30, 40}. After group join: {20, 40}.
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 20, 30, 40]]]),
      levelToExpressIds: mapsOf<string>([["all", [10, 20, 30, 40]]]),
      customToExpressIds: mapsOf<string>([
        ["g1::e1", [10, 30]],
        ["g1::e2", [20, 40]],
      ]),
    };
    state.customActive = new Map([["g1", new Set(["e1", "e2"])]]);
    state.customHidden = new Map([["g1", new Set(["e1"])]]);
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([20, 40]));
  });

  it("AND across multiple non-wildcard custom groups", () => {
    // Two non-wildcard groups. Group A narrows to {10, 20}; group B narrows to {20, 30}.
    // AND across both = {20}.
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 20, 30]]]),
      levelToExpressIds: mapsOf<string>([["all", [10, 20, 30]]]),
      customToExpressIds: mapsOf<string>([
        ["gA::a1", [10, 20]],
        ["gB::b1", [20, 30]],
      ]),
    };
    state.customActive = new Map([
      ["gA", new Set(["a1"])],
      ["gB", new Set(["b1"])],
    ]);
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([20]));
  });

  it("a wildcard group does not constrain the result", () => {
    // Group A is wildcard; group B narrows to {20}.
    // AND across them = {20}.
    const data: FlatFilters = {
      modelToExpressIds: mapsOf<string>([["f1", [10, 20, 30]]]),
      levelToExpressIds: mapsOf<string>([["all", [10, 20, 30]]]),
      customToExpressIds: mapsOf<string>([["gB::b1", [20]]]),
    };
    state.customActive = new Map([
      ["gA", new Set()], // wildcard
      ["gB", new Set(["b1"])],
    ]);
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set([20]));
  });
});

describe("computeMatchingExpressIds — empty maps (no viewer data)", () => {
  it("returns an empty set when all maps are empty", () => {
    const data: FlatFilters = {
      modelToExpressIds: new Map(),
      levelToExpressIds: new Map(),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set());
  });

  it("returns an empty set when the active set points to missing entries", () => {
    state.auto.models.enabled = new Set(["nonexistent"]);
    const data: FlatFilters = {
      modelToExpressIds: new Map(),
      levelToExpressIds: new Map(),
      customToExpressIds: new Map(),
    };
    const result = resolveFlat(state, data);
    expect(result).toEqual(new Set());
  });
});

describe("computeMatchingExpressIds — overlapping ids across models (wave 63)", () => {
  // Two federated models whose local ids collide: id 1 and 2 exist in
  // BOTH. Before wave 63 a flat Set<number> leaked one model's match
  // into the other.
  const models = (): Map<string, Set<number>> =>
    mapsOf<string>([
      ["A", [1, 2, 3]],
      ["B", [1, 2, 4]],
    ]);

  it("a level match in model A does not show the same id in model B", () => {
    const data: ModelsToolFilters = {
      modelToExpressIds: models(),
      levelToExpressIds: new Map([
        ["L1", new Map([["A", new Set([1])], ["B", new Set([4])]])],
        ["L2", new Map([["A", new Set([2, 3])], ["B", new Set([1, 2])]])],
      ]),
      customToExpressIds: new Map(),
    };
    state.auto.levels.enabled = new Set(["L1"]);
    const result = computeMatchingExpressIds(state, data);
    expect(result.get("A")).toEqual(new Set([1]));
    expect(result.get("B")).toEqual(new Set([4]));
  });

  it("a custom preset matching id 2 in model B only keeps B:2, not A:2", () => {
    const data: ModelsToolFilters = {
      modelToExpressIds: models(),
      levelToExpressIds: new Map(),
      customToExpressIds: new Map([
        ["g::e", new Map([["B", new Set([2])]])],
      ]),
    };
    state.customActive = new Map([["g", new Set(["e"])]]);
    const result = computeMatchingExpressIds(state, data);
    expect(result.get("A") ?? new Set()).toEqual(new Set());
    expect(result.get("B")).toEqual(new Set([2]));
  });

  it("hiding model B keeps model A's ids even when they collide", () => {
    state.auto.models.hidden = new Set(["B"]);
    const data: ModelsToolFilters = {
      modelToExpressIds: models(),
      levelToExpressIds: new Map(),
      customToExpressIds: new Map(),
    };
    const result = computeMatchingExpressIds(state, data);
    expect(result.get("A")).toEqual(new Set([1, 2, 3]));
    expect(result.has("B")).toBe(false);
  });

  it("countPerModelIds counts colliding ids once per model", () => {
    expect(countPerModelIds(models())).toBe(6);
  });
});
