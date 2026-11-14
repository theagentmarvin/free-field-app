// apps/models/src/hooks/filterEvaluator.ts
//
// Task 19 — pure rule-evaluation logic for the inline FilterPreset
// evaluator (Maintainer decision, 2026-06-22 08:41 CLT: Option A — inline).
//
// This module is intentionally DOM-free and React-free so it can be
// unit-tested in isolation. The hook in `useModelsToolFilter.ts`
// imports these functions and threads them into the viewer handle.
//
// The evaluator implements every operator from the spec's semantics
// table (Task 19 §"Rule evaluator semantics"). The 12 operators are:
//
//   equals, not_equals, contains, does_not_contain, in, not_in,
//   greater_than, less_than, greater_than_or_equal, less_than_or_equal,
//   is_empty, is_not_empty
//
// Operators split into three families:
//   - Equality/string contains (case-sensitive, JS default)
//   - Set membership (`in` / `not_in`, parses comma-separated values)
//   - Numeric comparison (parseFloat with string compare fallback)
//
// `is_empty` / `is_not_empty` are VALUE_AGNOSTIC — the rule's `value`
// field is ignored. The CustomFilterBuilder respects this by
// skipping the value-required guard for these operators.
//
// `_IfcClass` synthetic property: handled like any other property.
// The catalog (and the fragments model's element metadata) exposes
// a `_IfcClass` pset whose name is the IFC class string. A rule
// like `_IfcClass equals IfcWall` reads `elementProperties["_IfcClass"]
//` (or the equivalent under whatever key the catalog exposes).
//
// Performance notes:
//   - All lookups are O(1) Map reads in the caller — this module
//     does not iterate over the catalog.
//   - `in` / `not_in` parse the comma-separated value ONCE per rule
//     evaluation (cached below via the `ParsedRule` helper). Caller
//     can pre-parse by calling `parseRule` once and reusing the
//     returned predicate.

import type {
  ConditionGroup,
  FilterOperator,
  FilterPreset,
  FilterRule,
} from "../modelsToolStore";

/**
 * Per-element property source. The simplest shape is `string | undefined`
 * (keyed by qualified property name "Pset_WallCommon.FireRating" or
 * `_IfcClass`). The evaluator also accepts a Map for fast lookup, and
 * a record where the caller decides how to resolve properties.
 *
 * Resolution convention: the qualified name is `pset` + "." + `name`
 * for normal properties, and `_IfcClass` (no dot) for the synthetic
 * entity-type property. We expose a `lookupProperty` helper to keep
 * the call-site readable.
 */
export type ElementPropertyLookup =
  | Map<string, string | undefined>
  | ReadonlyMap<string, string | undefined>
  | ((qualified: string) => string | undefined);

/**
 * Look up a property on an element by its qualified name. Returns
 * `undefined` if the property is not set (which `is_empty` treats
 * as "empty" and `equals "undefined"` treats as "not equal to any
 * concrete value").
 */
export function lookupProperty(
  source: ElementPropertyLookup,
  qualified: string,
): string | undefined {
  if (typeof source === "function") return source(qualified);
  return source.get(qualified);
}

/**
 * Parse the rule's `value` field for `in` / `not_in` operators. Splits
 * on commas, trims whitespace, drops empties. Exported so callers can
 * pre-parse once per rule if they want to amortize the cost.
 */
export function parseCommaSeparated(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Compare two values for "greater than" / "less than" semantics.
 *
 * Numeric-first: tries `parseFloat` on both sides. If both parse to
 * finite numbers, compare numerically. Otherwise fall back to string
 * compare (locale-independent, JS default `<` / `>` on strings).
 *
 * The fallback matches the spec table: "fall back to string compare
 * if NaN". We treat NaN as "not numeric" and stringify both sides
 * before comparing — e.g. `"B10" > "A5"` returns true under string
 * compare. This is the same comparison JS's `<` uses on strings.
 */
function compareValues(
  a: string | undefined,
  b: string,
): number | null {
  const aStr = a ?? "";
  const aNum = parseFloat(aStr);
  const bNum = parseFloat(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
    return aNum - bNum;
  }
  // String fallback (locale-independent). `aStr.localeCompare(b)`
  // returns a number — we keep its sign for "less than" / "greater than".
  const cmp = aStr < b ? -1 : aStr > b ? 1 : 0;
  return cmp;
}

/**
 * Evaluate a single rule against a single element's properties.
 *
 * `elementProperty` is the resolved value for the rule's qualified
 * property name. For `is_empty` / `is_not_empty`, `elementProperty`
 * is still passed but the rule's `value` is ignored.
 *
 * Returns `true` iff the rule matches the element.
 */
export function evaluateRule(
  rule: FilterRule,
  elementProperty: string | undefined,
): boolean {
  const op: FilterOperator = rule.operator;
  const v = rule.value;
  const p = elementProperty;

  switch (op) {
    case "equals":
      return p === v;
    case "not_equals":
      return p !== v;
    case "contains":
      // Empty value is never contained in anything (avoids the
      // `("").includes("") === true` JS quirk matching nothing
      // meaningful for users).
      if (v === "") return false;
      return typeof p === "string" && p.includes(v);
    case "does_not_contain":
      // Mirror of contains — empty value is not "not contained"
      // either; both halves of the pair return false on empty.
      if (v === "") return false;
      return typeof p !== "string" || !p.includes(v);
    case "in": {
      // `in` semantics: comma-separated list of allowed values.
      // The element matches if its property equals any item.
      const allowed = parseCommaSeparated(v);
      if (allowed.length === 0) return false;
      if (p === undefined) return false;
      return allowed.includes(p);
    }
    case "not_in": {
      // `not_in` is the negation of `in`. Empty list → false
      // (matches the "always false" rule in `in`).
      const blocked = parseCommaSeparated(v);
      if (blocked.length === 0) return false;
      if (p === undefined) return true;
      return !blocked.includes(p);
    }
    case "greater_than": {
      const cmp = compareValues(p, v);
      return cmp !== null && cmp > 0;
    }
    case "less_than": {
      const cmp = compareValues(p, v);
      return cmp !== null && cmp < 0;
    }
    case "greater_than_or_equal": {
      const cmp = compareValues(p, v);
      return cmp !== null && cmp >= 0;
    }
    case "less_than_or_equal": {
      const cmp = compareValues(p, v);
      return cmp !== null && cmp <= 0;
    }
    case "is_empty":
      // VALUE_AGNOSTIC — `v` is ignored.
      return p === undefined || p === null || p === "";
    case "is_not_empty":
      // VALUE_AGNOSTIC — negation of `is_empty`.
      return !(p === undefined || p === null || p === "");
    default: {
      // Exhaustiveness guard: if a new operator is added to the
      // union without updating this switch, return false (the
      // safe default — the rule fails closed).
      const _exhaustive: never = op as never;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Evaluate a single rule against an element's property source.
 * Convenience wrapper that resolves `rule.property` to a concrete
 * value via `lookupProperty`.
 */
export function evaluateRuleOnElement(
  rule: FilterRule,
  source: ElementPropertyLookup,
): boolean {
  return evaluateRule(rule, lookupProperty(source, rule.property));
}

/**
 * Evaluate a `ConditionGroup` against an element.
 *
 * Combinator semantics:
 *   - `AND`: every rule in the group must match (empty group
 *     matches everything — vacuous truth).
 *   - `OR`:  at least one rule must match (empty group matches
 *     nothing — same vacuous-truth rule flipped).
 *
 * The spec table calls these out explicitly in §"Rule evaluator
 * semantics" + §"Presets combine groups via `preset.combinator`"
 * (same logic, applied at the group/preset level too).
 */
export function evaluateGroup(
  group: ConditionGroup,
  source: ElementPropertyLookup,
): boolean {
  if (group.rules.length === 0) {
    // Vacuous-truth rule for AND; the OR equivalent returns false
    // because "any of zero" is false.
    return group.combinator === "AND";
  }
  if (group.combinator === "AND") {
    for (const rule of group.rules) {
      if (!evaluateRuleOnElement(rule, source)) return false;
    }
    return true;
  }
  // combinator === "OR"
  for (const rule of group.rules) {
    if (evaluateRuleOnElement(rule, source)) return true;
  }
  return false;
}

/**
 * Evaluate a full `FilterPreset` against an element.
 *
 * Group combinator `preset.combinator` joins sibling groups:
 *   - AND: every group must match (empty groups list → true)
 *   - OR:  at least one group must match (empty list → false)
 *
 * Within each group, `group.combinator` joins rules (see
 * `evaluateGroup`).
 *
 * Presets with empty groups match vacuously (same vacuous-truth
 * rule as `evaluateGroup`).
 */
export function evaluatePreset(
  preset: FilterPreset,
  source: ElementPropertyLookup,
): boolean {
  if (preset.groups.length === 0) {
    return preset.combinator === "AND";
  }
  if (preset.combinator === "AND") {
    for (const group of preset.groups) {
      if (!evaluateGroup(group, source)) return false;
    }
    return true;
  }
  // combinator === "OR"
  for (const group of preset.groups) {
    if (evaluateGroup(group, source)) return true;
  }
  return false;
}

/**
 * Batch helper: evaluate a list of presets against an element.
 *
 * The Models module's filter pipeline (see
 * `useModelsToolFilter.ts`) resolves element matches as
 * "matches AT LEAST ONE active custom preset AND passes auto".
 * The "matches at least one preset" half is what this helper
 * computes — it short-circuits on the first match.
 *
 * Empty list returns false (no presets to match against).
 */
export function evaluateAnyPreset(
  presets: ReadonlyArray<FilterPreset>,
  source: ElementPropertyLookup,
): boolean {
  for (const preset of presets) {
    if (evaluatePreset(preset, source)) return true;
  }
  return false;
}
