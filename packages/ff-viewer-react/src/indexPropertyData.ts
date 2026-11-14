// packages/ff-viewer-react/src/indexPropertyData.ts
//
// Task 23 — in-memory inverted index for fast custom-filter
// evaluation. The Critic's Option C architecture (see
// `.critic-task23-custom-filters.md`).
//
// The index is a 2-level Map:
//   Map<"Pset_WallCommon.FireRating", Map<"2HR", Set<localId>>>
// At filter-toggle time, a rule like
//   { property: "Pset_WallCommon.FireRating", operator: "equals", value: "2HR" }
// is a single Map.get → Map.get → return Set. O(rules) per
// evaluation, not O(elements).
//
// All 12 operators from `filterEvaluator.ts` are supported here —
// TOE's `getItemsByQuery` cannot express numeric comparisons or
// emptiness checks, so we evaluate on the JS side.
//
// This module is intentionally pure (no React, no TOE, no Three.js,
// no Dexie) so it can be unit-tested in isolation. Consumers in
// `apps/models` import it and thread the pre-built index in.
//
// Note: this module does NOT import from `@ff/types` because
// `@ff/viewer-react` has no dependency on `@ff/types`. The
// `FilterRuleLike` shape is structural — the strict `FilterOperator`
// union lives in `apps/models/src/modelsToolStore.ts`; the consumer
// (`customPresetEvaluator.ts`) narrows on assignment.

/**
 * The subset of `FilterRule` we need at evaluation time. The shape
 * is structural — matches `@ff/types` `FilterRuleLike` and the
 * `FilterRule` interface in `apps/models/src/modelsToolStore.ts`.
 *
 * `operator` is intentionally typed as `string` here (not the
 * strict `FilterOperator` union) so this pure helper stays free of
 * any UI-store type coupling. The switch statement in `evaluateRule`
 * handles every operator literal that the consumer can pass.
 */
export interface IndexFilterRule {
  id: string;
  property: string;
  operator: string;
  value: string;
}

/**
 * A single row from the property extraction. The `localId` is
 * the TOE local ID for one element; `properties` is the flat
 * `Record<string, string>` produced by `flattenItemData` (pset
 * keys like "Pset_WallCommon.FireRating", or synthetic keys like
 * "_IfcClass").
 */
export interface PropertyDataRow {
  localId: number;
  properties: Record<string, string>;
}

/**
 * The inverted index:
 *   outer key   = qualified property name (pset.prop or "_IfcClass")
 *   inner key   = the string value (or "" for empty)
 *   inner value = Set<localId> — every element with that value for
 *                 that property
 *
 * For the "FireRating" example:
 *   index.get("Pset_WallCommon.FireRating")
 *     ?.get("2HR")  → Set<localId> for every wall with FireRating "2HR"
 *     ?.get("1HR")  → Set<localId> for every wall with FireRating "1HR"
 */
export type InvertedIndex = Map<string, Map<string, Set<number>>>;

/**
 * Build the inverted index from a flat list of (localId, properties)
 * rows.
 *
 * Dedup is automatic: each unique (property, value) pair's `Set<localId>`
 * grows as we encounter matching rows. The same localId for the same
 * (property, value) pair is a no-op (Set.add on an existing id).
 *
 * Properties with `undefined` / `null` / `""` values are SKIPPED — they
 * represent the absence of a value, which the `is_empty` operator
 * computes by subtracting the property's full value-set from
 * `allLocalIds`. The Critic's report notes this; the explicit skip
 * here keeps the index lean.
 *
 * Memory: per the Critic's report, a 50k-element / 30-property model
 * yields a ~12-15MB index. Acceptable for a desktop app.
 */
export function buildInvertedIndex(rows: PropertyDataRow[]): InvertedIndex {
  const index: InvertedIndex = new Map();
  for (const row of rows) {
    const props = row.properties;
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === undefined || value === null || value === "") continue;
      let valuesMap = index.get(key);
      if (!valuesMap) {
        valuesMap = new Map();
        index.set(key, valuesMap);
      }
      let idSet = valuesMap.get(value);
      if (!idSet) {
        idSet = new Set<number>();
        valuesMap.set(value, idSet);
      }
      idSet.add(row.localId);
    }
  }
  return index;
}

/**
 * Parse the `in` / `not_in` rule value into an array of trimmed,
 * non-empty tokens. Duplicates are de-duped to keep set operations
 * O(n) on the unique count.
 */
function parseInList(value: string): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return Array.from(out);
}

/**
 * Numeric-or-string compare. Tries parseFloat on both sides; if both
 * are finite numbers, compare numerically. Otherwise fall back to JS
 * string compare (`<` / `>`), which is locale-independent.
 *
 * Returns `null` for the "incomparable" case (e.g. one side is
 * non-numeric and the other side is also non-numeric but the
 * non-numeric halves can't be string-compared because the values
 * are objects — shouldn't happen here, but defensive).
 */
function compareNumericOrString(
  a: string,
  b: string,
): number | null {
  const aNum = parseFloat(a);
  const bNum = parseFloat(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
    return aNum - bNum;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Evaluate a single rule against the inverted index, returning the
 * Set<localId> of matching elements.
 *
 * All 12 operators from `filterEvaluator.ts` are supported:
 *
 *   Equality     : equals, not_equals
 *   String       : contains, does_not_contain
 *   Set          : in, not_in
 *   Numeric      : greater_than, less_than, greater_than_or_equal,
 *                  less_than_or_equal
 *   Emptiness    : is_empty, is_not_empty  (value-agnostic; `value` ignored)
 *
 * If the property is not in the index (no element has it), the
 * semantics are:
 *   - equals / in / numeric / contains   → empty Set
 *     (no value matches anything)
 *   - not_equals / not_in / does_not_contain / is_not_empty
 *                                          → allLocalIds
 *     (no value is "blocked" so everything passes)
 *   - is_empty                            → allLocalIds
 *     (every element "lacks" the property)
 *
 * Numeric operators iterate the value-set keys for the property
 * (typically <100 unique values for typical IFC properties like
 * FireRating, ThermalTransmittance) and compare each. O(k) per rule
 * where k = unique values for that property, not O(elements).
 *
 * The `allLocalIds` set is only required for the negation /
 * emptiness operators. Pass an empty Set if you only evaluate
 * positive operators.
 */
export function evaluateRule(
  rule: IndexFilterRule,
  index: InvertedIndex,
  allLocalIds: ReadonlySet<number>,
): Set<number> {
  const op = rule.operator;
  const prop = rule.property;
  const v = rule.value;
  const valuesMap = index.get(prop);

  // ── Property not in index ──────────────────────────────────────────
  if (!valuesMap) {
    switch (op) {
      case "not_equals":
      case "not_in":
      case "does_not_contain":
      case "is_empty":
        return new Set(allLocalIds);
      case "is_not_empty":
        return new Set();
      default:
        return new Set();
    }
  }

  switch (op) {
    case "equals": {
      const set = valuesMap.get(v);
      return set ? new Set(set) : new Set();
    }
    case "not_equals": {
      // Complement within `allLocalIds`.
      const exclude = valuesMap.get(v);
      const out = new Set(allLocalIds);
      if (exclude) {
        for (const id of exclude) out.delete(id);
      }
      return out;
    }
    case "contains": {
      // Empty value is never contained in anything (mirrors
      // `filterEvaluator.ts` semantics: `("").includes("") === true`
      // is treated as no-op).
      if (v === "") return new Set();
      const out = new Set<number>();
      for (const [value, ids] of valuesMap) {
        if (value.includes(v)) {
          for (const id of ids) out.add(id);
        }
      }
      return out;
    }
    case "does_not_contain": {
      // Mirror of contains — empty value returns allLocalIds (the
      // negation of "no match for empty").
      if (v === "") return new Set(allLocalIds);
      const out = new Set(allLocalIds);
      for (const [value, ids] of valuesMap) {
        if (value.includes(v)) {
          for (const id of ids) out.delete(id);
        }
      }
      return out;
    }
    case "in": {
      const allowed = parseInList(v);
      if (allowed.length === 0) return new Set();
      const out = new Set<number>();
      for (const allowedValue of allowed) {
        const set = valuesMap.get(allowedValue);
        if (set) {
          for (const id of set) out.add(id);
        }
      }
      return out;
    }
    case "not_in": {
      const blocked = parseInList(v);
      if (blocked.length === 0) return new Set(allLocalIds);
      const out = new Set(allLocalIds);
      for (const blockedValue of blocked) {
        const set = valuesMap.get(blockedValue);
        if (set) {
          for (const id of set) out.delete(id);
        }
      }
      return out;
    }
    case "greater_than":
    case "less_than":
    case "greater_than_or_equal":
    case "less_than_or_equal": {
      const out = new Set<number>();
      const ruleNum = parseFloat(v);
      const ruleIsNumeric = Number.isFinite(ruleNum);
      for (const [value, ids] of valuesMap) {
        let match = false;
        if (ruleIsNumeric) {
          // Rule side is numeric — only consider values that
          // also parse as numbers. Non-numeric property values
          // can't be ordered numerically.
          const valueNum = parseFloat(value);
          if (!Number.isFinite(valueNum)) continue;
          switch (op) {
            case "greater_than":
              match = valueNum > ruleNum;
              break;
            case "less_than":
              match = valueNum < ruleNum;
              break;
            case "greater_than_or_equal":
              match = valueNum >= ruleNum;
              break;
            case "less_than_or_equal":
              match = valueNum <= ruleNum;
              break;
            default:
              match = false;
          }
        } else {
          // Non-numeric rule — fall back to string compare.
          const cmp = compareNumericOrString(value, v);
          if (cmp === null) continue;
          switch (op) {
            case "greater_than":
              match = cmp > 0;
              break;
            case "less_than":
              match = cmp < 0;
              break;
            case "greater_than_or_equal":
              match = cmp >= 0;
              break;
            case "less_than_or_equal":
              match = cmp <= 0;
              break;
            default:
              match = false;
          }
        }
        if (match) {
          for (const id of ids) out.add(id);
        }
      }
      return out;
    }
    case "is_empty": {
      // Complement of all values in the property's value-map.
      const out = new Set(allLocalIds);
      for (const ids of valuesMap.values()) {
        for (const id of ids) out.delete(id);
      }
      return out;
    }
    case "is_not_empty": {
      // Union of all values for the property.
      const out = new Set<number>();
      for (const ids of valuesMap.values()) {
        for (const id of ids) out.add(id);
      }
      return out;
    }
    default: {
      // Unknown operator — fail closed. (The strict `FilterOperator`
      // union lives in apps/models; this module accepts `string` so
      // it doesn't have to import the UI store. The consumer should
      // only ever pass known operators.)
      return new Set();
    }
  }
}
