// packages/ff-viewer-react/__tests__/indexPropertyData.test.ts
//
// Task 23 — unit tests for the in-memory inverted index and
// `evaluateRule` (the pure module powering the custom filter
// pipeline). All 12 operators from `filterEvaluator.ts` are
// covered, plus edge cases on `buildInvertedIndex` (dedup,
// empty values, special characters in pset names).
//
// We import directly from the standalone module to avoid the
// IfcViewer.tsx → three.webgpu module-load chain (mirrors the
// Task 22 pattern in `apps/models/__tests__/flattenItemData.test.ts`).

import { describe, expect, it } from "vitest";

import {
  buildInvertedIndex,
  evaluateRule,
  type IndexFilterRule,
  type InvertedIndex,
  type PropertyDataRow,
} from "../src/indexPropertyData";

// ── Helpers ───────────────────────────────────────────────────────

function makeRow(localId: number, properties: Record<string, string>): PropertyDataRow {
  return { localId, properties };
}

function ids(set: Set<number>): number[] {
  return Array.from(set).sort((a, b) => a - b);
}

function rule(operator: string, property: string, value: string): IndexFilterRule {
  return { id: `r-${operator}-${property}-${value}`, property, operator, value };
}

const allLocalIds = (rows: PropertyDataRow[]): Set<number> =>
  new Set(rows.map((r) => r.localId));

// ── buildInvertedIndex ────────────────────────────────────────────

describe("buildInvertedIndex", () => {
  it("indexes simple (property, value) → Set<localId> entries", () => {
    const rows: PropertyDataRow[] = [
      makeRow(1, { "Pset_WallCommon.FireRating": "2HR" }),
      makeRow(2, { "Pset_WallCommon.FireRating": "2HR" }),
      makeRow(3, { "Pset_WallCommon.FireRating": "1HR" }),
    ];
    const idx = buildInvertedIndex(rows);
    expect(idx.get("Pset_WallCommon.FireRating")?.get("2HR")).toEqual(
      new Set([1, 2]),
    );
    expect(idx.get("Pset_WallCommon.FireRating")?.get("1HR")).toEqual(
      new Set([3]),
    );
  });

  it("dedups the same localId for the same (property, value) pair", () => {
    const idx = buildInvertedIndex([
      makeRow(7, { "Pset_X.A": "v" }),
      makeRow(7, { "Pset_X.A": "v" }),
    ]);
    expect(idx.get("Pset_X.A")?.get("v")).toEqual(new Set([7]));
  });

  it("skips empty / null / undefined values (is_empty computes the complement)", () => {
    const rows: PropertyDataRow[] = [
      makeRow(1, { "Pset_X.A": "v1" }),
      makeRow(2, { "Pset_X.A": "" }),
      makeRow(3, { "Pset_X.A": null as unknown as string }),
      makeRow(4, { "Pset_X.A": undefined as unknown as string }),
    ];
    const idx = buildInvertedIndex(rows);
    expect(idx.has("Pset_X.A")).toBe(true);
    // Empty/null/undefined values are NOT in the index — `is_empty`
    // will compute them by subtracting allLocalIds minus the
    // value-set union.
    expect(idx.get("Pset_X.A")?.has("")).toBe(false);
    expect(idx.get("Pset_X.A")?.has("null")).toBe(false);
    expect(idx.get("Pset_X.A")?.get("v1")).toEqual(new Set([1]));
  });

  it("preserves keys with special characters in pset names", () => {
    const idx = buildInvertedIndex([
      makeRow(1, { "Pset_Foundation.01-nivel constructivo": "Subterráneo" }),
      makeRow(2, { "Pset_Foundation.01-nivel constructivo": "Subterráneo" }),
      makeRow(3, { "Pset_Foundation.01-nivel constructivo": "Superficie" }),
    ]);
    const psetMap = idx.get("Pset_Foundation.01-nivel constructivo");
    expect(psetMap?.get("Subterráneo")).toEqual(new Set([1, 2]));
    expect(psetMap?.get("Superficie")).toEqual(new Set([3]));
  });

  it("emits no entry for a property key with all-empty values", () => {
    const idx = buildInvertedIndex([
      makeRow(1, { "Pset_AllEmpty.A": "" }),
      makeRow(2, { "Pset_AllEmpty.A": null as unknown as string }),
    ]);
    expect(idx.has("Pset_AllEmpty.A")).toBe(false);
  });

  it("returns an empty Map for an empty input list", () => {
    const idx = buildInvertedIndex([]);
    expect(idx.size).toBe(0);
  });

  it("handles multiple properties per element (no cross-contamination)", () => {
    const idx = buildInvertedIndex([
      makeRow(1, { "Pset_A.X": "1", "Pset_B.Y": "2" }),
      makeRow(2, { "Pset_A.X": "1", "Pset_B.Y": "3" }),
    ]);
    expect(idx.get("Pset_A.X")?.get("1")).toEqual(new Set([1, 2]));
    expect(idx.get("Pset_B.Y")?.get("2")).toEqual(new Set([1]));
    expect(idx.get("Pset_B.Y")?.get("3")).toEqual(new Set([2]));
  });
});

// ── evaluateRule — equality ───────────────────────────────────────

describe("evaluateRule — equals / not_equals", () => {
  const rows: PropertyDataRow[] = [
    makeRow(1, { _IfcClass: "IfcWall" }),
    makeRow(2, { _IfcClass: "IfcWall" }),
    makeRow(3, { _IfcClass: "IfcSlab" }),
    makeRow(4, { _IfcClass: "IfcDoor" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("equals returns the matching Set<localId>", () => {
    const result = evaluateRule(rule("equals", "_IfcClass", "IfcWall"), idx, allIds);
    expect(ids(result)).toEqual([1, 2]);
  });

  it("not_equals returns the complement within allLocalIds", () => {
    const result = evaluateRule(
      rule("not_equals", "_IfcClass", "IfcWall"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([3, 4]);
  });

  it("equals on a property not in the index returns empty", () => {
    const result = evaluateRule(
      rule("equals", "Pset_Missing.A", "X"),
      idx,
      allIds,
    );
    expect(result.size).toBe(0);
  });

  it("not_equals on a property not in the index returns all", () => {
    const result = evaluateRule(
      rule("not_equals", "Pset_Missing.A", "X"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2, 3, 4]);
  });
});

// ── evaluateRule — string ops ─────────────────────────────────────

describe("evaluateRule — contains / does_not_contain", () => {
  const rows: PropertyDataRow[] = [
    makeRow(1, { Name: "Wall-001" }),
    makeRow(2, { Name: "Wall-002" }),
    makeRow(3, { Name: "Slab-001" }),
    makeRow(4, { Name: "Door-001" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("contains matches across all values for the property", () => {
    const result = evaluateRule(rule("contains", "Name", "Wall"), idx, allIds);
    expect(ids(result)).toEqual([1, 2]);
  });

  it("does_not_contain returns the complement", () => {
    const result = evaluateRule(
      rule("does_not_contain", "Name", "Wall"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([3, 4]);
  });

  it("contains with empty value returns empty (no-op)", () => {
    const result = evaluateRule(rule("contains", "Name", ""), idx, allIds);
    expect(result.size).toBe(0);
  });

  it("does_not_contain with empty value returns all", () => {
    const result = evaluateRule(
      rule("does_not_contain", "Name", ""),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2, 3, 4]);
  });
});

// ── evaluateRule — set ops ────────────────────────────────────────

describe("evaluateRule — in / not_in", () => {
  const rows: PropertyDataRow[] = [
    makeRow(1, { _IfcClass: "IfcWall" }),
    makeRow(2, { _IfcClass: "IfcSlab" }),
    makeRow(3, { _IfcClass: "IfcDoor" }),
    makeRow(4, { _IfcClass: "IfcWindow" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("in matches the union of allowed values", () => {
    const result = evaluateRule(
      rule("in", "_IfcClass", "IfcWall,IfcDoor"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 3]);
  });

  it("in trims whitespace around values", () => {
    const result = evaluateRule(
      rule("in", "_IfcClass", " IfcWall , IfcSlab "),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2]);
  });

  it("in with empty list returns empty", () => {
    const result = evaluateRule(rule("in", "_IfcClass", ""), idx, allIds);
    expect(result.size).toBe(0);
    const result2 = evaluateRule(
      rule("in", "_IfcClass", "  ,  "),
      idx,
      allIds,
    );
    expect(result2.size).toBe(0);
  });

  it("not_in excludes the listed values", () => {
    const result = evaluateRule(
      rule("not_in", "_IfcClass", "IfcWall,IfcDoor"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([2, 4]);
  });

  it("not_in with empty list returns all", () => {
    const result = evaluateRule(
      rule("not_in", "_IfcClass", ""),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2, 3, 4]);
  });
});

// ── evaluateRule — numeric ───────────────────────────────────────

describe("evaluateRule — greater_than / less_than / greater_than_or_equal / less_than_or_equal", () => {
  const rows: PropertyDataRow[] = [
    makeRow(1, { "Pset_WallCommon.ThermalTransmittance": "0.20" }),
    makeRow(2, { "Pset_WallCommon.ThermalTransmittance": "0.35" }),
    makeRow(3, { "Pset_WallCommon.ThermalTransmittance": "0.50" }),
    makeRow(4, { "Pset_WallCommon.ThermalTransmittance": "1.00" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("greater_than (numeric) excludes equal and below", () => {
    const result = evaluateRule(
      rule("greater_than", "Pset_WallCommon.ThermalTransmittance", "0.35"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([3, 4]);
  });

  it("less_than (numeric) excludes equal and above", () => {
    const result = evaluateRule(
      rule("less_than", "Pset_WallCommon.ThermalTransmittance", "0.50"),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2]);
  });

  it("greater_than_or_equal (numeric) includes equal", () => {
    const result = evaluateRule(
      rule(
        "greater_than_or_equal",
        "Pset_WallCommon.ThermalTransmittance",
        "0.35",
      ),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([2, 3, 4]);
  });

  it("less_than_or_equal (numeric) includes equal", () => {
    const result = evaluateRule(
      rule(
        "less_than_or_equal",
        "Pset_WallCommon.ThermalTransmittance",
        "0.50",
      ),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2, 3]);
  });

  it("skips non-numeric property values when the rule is numeric", () => {
    const mixedIdx = buildInvertedIndex([
      makeRow(1, { X: "5" }),
      makeRow(2, { X: "10" }),
      makeRow(3, { X: "not-a-number" }),
      makeRow(4, { X: "20" }),
    ]);
    const result = evaluateRule(rule("greater_than", "X", "5"), mixedIdx, new Set([1, 2, 3, 4]));
    expect(ids(result)).toEqual([2, 4]);
  });

  it("falls back to string compare when rule value is non-numeric", () => {
    const strIdx = buildInvertedIndex([
      makeRow(1, { Tag: "A1" }),
      makeRow(2, { Tag: "A5" }),
      makeRow(3, { Tag: "B10" }),
    ]);
    // String compare: "A5" > "A1" → true; "B10" > "A1" → true; "A1" > "A1" → false.
    const result = evaluateRule(rule("greater_than", "Tag", "A1"), strIdx, new Set([1, 2, 3]));
    expect(ids(result)).toEqual([2, 3]);
  });
});

// ── evaluateRule — emptiness ──────────────────────────────────────

describe("evaluateRule — is_empty / is_not_empty", () => {
  const rows: PropertyDataRow[] = [
    makeRow(1, { "Pset_X.A": "v1" }),
    makeRow(2, { "Pset_X.A": "v2" }),
    // 3 and 4 have no Pset_X.A property at all.
    makeRow(3, {}),
    makeRow(4, { Other: "Z" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("is_empty returns the elements without a value for this property", () => {
    const result = evaluateRule(
      rule("is_empty", "Pset_X.A", ""),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([3, 4]);
  });

  it("is_not_empty returns the elements with at least one value for this property", () => {
    const result = evaluateRule(
      rule("is_not_empty", "Pset_X.A", ""),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2]);
  });

  it("is_empty on a property not in the index returns all", () => {
    const result = evaluateRule(
      rule("is_empty", "Pset_Nonexistent.A", ""),
      idx,
      allIds,
    );
    expect(ids(result)).toEqual([1, 2, 3, 4]);
  });

  it("is_not_empty on a property not in the index returns empty", () => {
    const result = evaluateRule(
      rule("is_not_empty", "Pset_Nonexistent.A", ""),
      idx,
      allIds,
    );
    expect(result.size).toBe(0);
  });
});

// ── evaluateRule — combined / realistic ───────────────────────────

describe("evaluateRule — realistic IFC scenario (walls by class + fire rating)", () => {
  // 4 walls, each with _IfcClass and a FireRating value (or none).
  const rows: PropertyDataRow[] = [
    makeRow(10, { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "2HR" }),
    makeRow(11, { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "1HR" }),
    makeRow(12, { _IfcClass: "IfcWall", "Pset_WallCommon.FireRating": "2HR" }),
    makeRow(13, { _IfcClass: "IfcWall" /* no FireRating set */ }),
    makeRow(20, { _IfcClass: "IfcSlab", "Pset_SlabCommon.FireRating": "2HR" }),
  ];
  const idx = buildInvertedIndex(rows);
  const allIds = allLocalIds(rows);

  it("selects only IfcWall elements", () => {
    const result = evaluateRule(rule("equals", "_IfcClass", "IfcWall"), idx, allIds);
    expect(ids(result)).toEqual([10, 11, 12, 13]);
  });

  it("selects walls with FireRating 2HR (intersection by chain)", () => {
    // Two-step: walls ∧ FireRating=2HR
    const walls = evaluateRule(
      rule("equals", "_IfcClass", "IfcWall"),
      idx,
      allIds,
    );
    const twoHR = evaluateRule(
      rule("equals", "Pset_WallCommon.FireRating", "2HR"),
      idx,
      allIds,
    );
    const intersection = new Set<number>();
    for (const id of walls) if (twoHR.has(id)) intersection.add(id);
    expect(ids(intersection)).toEqual([10, 12]);
  });

  it("selects walls with NO FireRating (is_empty on the rating)", () => {
    const walls = evaluateRule(
      rule("equals", "_IfcClass", "IfcWall"),
      idx,
      allIds,
    );
    const noRating = evaluateRule(
      rule("is_empty", "Pset_WallCommon.FireRating", ""),
      idx,
      allIds,
    );
    const intersection = new Set<number>();
    for (const id of walls) if (noRating.has(id)) intersection.add(id);
    expect(ids(intersection)).toEqual([13]);
  });
});

// ── Sanity: index type-level signature ────────────────────────────

describe("InvertedIndex type — sanity checks", () => {
  it("the public types are exported and shape matches", () => {
    const idx: InvertedIndex = new Map();
    const inner = new Map<string, Set<number>>();
    inner.set("v", new Set([1, 2]));
    idx.set("Pset_X.A", inner);
    expect(idx.get("Pset_X.A")?.get("v")?.size).toBe(2);
  });
});
