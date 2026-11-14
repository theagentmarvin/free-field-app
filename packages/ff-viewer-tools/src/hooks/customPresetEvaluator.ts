// apps/models/src/hooks/customPresetEvaluator.ts
//
// Task 23 — pure evaluator that produces the
// `customToExpressIds` map (the per-preset → Set<localId>
// shape) the existing filter pipeline consumes in
// `useModelsToolFilter` and `computeMatchingExpressIds`.
//
// Wires the existing `evaluatePreset` / `evaluateGroup` /
// `evaluateRule` from `filterEvaluator.ts` to the in-memory
// inverted index from `useModelPropertyIndex`. Within a single
// preset: AND across groups, with each group's rules joined
// by the group's combinator. Across models: the evaluator
// keeps each model's matches separately (local ids overlap across
// models), keyed modelId → ids.
//
// This module is intentionally DOM-free and React-free so it
// can be unit-tested in isolation. The hook in
// `useViewerExpressIdMaps` imports it and threads the
// pre-built index in.

import { evaluatePreset } from "./filterEvaluator";
import type {
  ConditionGroup,
  FilterPreset,
  FilterState,
} from "../modelsToolStore";
import type {
  InvertedIndex,
  IndexFilterRule,
} from "@ff/viewer-react";
import { evaluateRule } from "@ff/viewer-react";

/**
 * The output of `evaluateActivePresets`: a map from
 * `${groupId}::${leafId}` (the key shape expected by
 * `useModelsToolFilter` and `computeMatchingExpressIds`) to the
 * Set<localId> of elements matching the preset.
 */
export interface CustomPresetResult {
  /** `${groupId}::${leafId}` → modelId → matching localIds. */
  byPreset: Map<string, Map<string, Set<number>>>;
}

/**
 * Find the (groupId, leafId) of the filter preset in the custom
 * tree. Returns `null` if the preset isn't in the tree (e.g. it
 * was removed but the caller still has a reference). Mirrors
 * the lookup in `useModelsToolFilter.ts` — kept local to this
 * module so the evaluator is a single import for callers.
 */
function findPresetLocation(
  presetId: string,
  customTree: FilterState["customTree"],
): { groupId: string; leafId: string } | null {
  const visit = (
    folders: ReadonlyArray<{
      id: string;
      kind: "user";
      children: ReadonlyArray<{
        id: string;
        kind: "user" | "filter";
        preset?: FilterPreset;
      }>;
    }>,
  ): { groupId: string; leafId: string } | null => {
    for (const folder of folders) {
      if (folder.kind !== "user") continue;
      for (const child of folder.children) {
        if (
          child.kind === "filter" &&
          child.preset?.id === presetId
        ) {
          return { groupId: folder.id, leafId: child.id };
        }
      }
      const subFolders = folder.children.filter(
        (c): c is typeof folder => c.kind === "user",
      );
      const found = visit(subFolders);
      if (found) return found;
    }
    return null;
  };
  return visit(customTree);
}

/**
 * Evaluate a single rule against a single model's index. The
 * local IDs in the returned Set are model-local; the caller
 * (the multi-model loop in `evaluateActivePresets`) is
 * responsible for the cross-model union.
 */
function evaluateRuleForModel(
  rule: ConditionGroup["rules"][number],
  index: InvertedIndex,
  allLocalIds: ReadonlySet<number>,
): Set<number> {
  // The strict `FilterRule` from modelsToolStore is structurally
  // compatible with the looser `IndexFilterRule` consumed by
  // `evaluateRule` (same `id` / `property` / `operator` / `value`
  // fields). We cast at the boundary to keep the pure evaluator
  // type-free of the UI store.
  return evaluateRule(
    rule as unknown as IndexFilterRule,
    index,
    allLocalIds,
  );
}

/**
 * Evaluate a single `ConditionGroup` against a single model's
 * index. Mirrors `evaluateGroup` from `filterEvaluator.ts` but
 * threads the index lookups via `evaluateRuleForModel`.
 */
function evaluateGroupForModel(
  group: ConditionGroup,
  index: InvertedIndex,
  allLocalIds: ReadonlySet<number>,
): Set<number> {
  if (group.rules.length === 0) {
    return group.combinator === "AND"
      ? new Set(allLocalIds)
      : new Set<number>();
  }
  if (group.combinator === "AND") {
    // Start with the full localId set and intersect.
    let acc: Set<number> | null = null;
    for (const rule of group.rules) {
      const matched = evaluateRuleForModel(rule, index, allLocalIds);
      if (acc === null) {
        acc = matched;
      } else {
        // Intersect: keep ids in BOTH `acc` and `matched`.
        const next = new Set<number>();
        for (const id of acc) if (matched.has(id)) next.add(id);
        acc = next;
        if (acc.size === 0) return acc; // early-out
      }
    }
    return acc ?? new Set();
  }
  // OR — start with empty and union.
  const out = new Set<number>();
  for (const rule of group.rules) {
    const matched = evaluateRuleForModel(rule, index, allLocalIds);
    for (const id of matched) out.add(id);
  }
  return out;
}

/**
 * Evaluate a full `FilterPreset` against a single model's index.
 * Mirrors `evaluatePreset` from `filterEvaluator.ts` with the
 * same AND-across-groups / OR-across-groups semantics. Empty
 * groups list matches vacuously per the combinator (same as
 * `evaluatePreset`).
 */
function evaluatePresetForModel(
  preset: FilterPreset,
  index: InvertedIndex,
  allLocalIds: ReadonlySet<number>,
): Set<number> {
  if (preset.groups.length === 0) {
    return preset.combinator === "AND"
      ? new Set(allLocalIds)
      : new Set<number>();
  }
  if (preset.combinator === "AND") {
    let acc: Set<number> | null = null;
    for (const group of preset.groups) {
      const matched = evaluateGroupForModel(group, index, allLocalIds);
      if (acc === null) {
        acc = matched;
      } else {
        const next = new Set<number>();
        for (const id of acc) if (matched.has(id)) next.add(id);
        acc = next;
        if (acc.size === 0) return acc; // early-out
      }
    }
    return acc ?? new Set();
  }
  // OR — start with empty and union.
  const out = new Set<number>();
  for (const group of preset.groups) {
    const matched = evaluateGroupForModel(group, index, allLocalIds);
    for (const id of matched) out.add(id);
  }
  return out;
}

/**
 * Evaluate each active custom preset against the model property
 * indices. Returns a map keyed by `${groupId}::${leafId}` (the
 * shape `computeMatchingExpressIds` and `useModelsToolFilter`
 * expect) to the Set<localId> of elements matching the preset
 * across the union of loaded models.
 *
 * Active / hidden semantics (mirroring `useModelsToolFilter`):
 *   - A leaf is "active" if its parent group has it in
 *     `customActive` (or the group has empty active — wildcard
 *     for the group, see `filterResolution.ts` §3). Hidden
 *     wins over active.
 *   - Hidden presets are excluded entirely.
 *   - If a preset has no location in the custom tree, it's
 *     skipped (defensive — handles the race where a preset was
 *     removed but the store still references it).
 *
 * Per-model results: local ids are only unique within a model,
 * so each preset's matches are kept per model (modelId → ids).
 * Models with no match have no entry.
 *
 * Pure function — no React, no viewer, no Dexie.
 */
export function evaluateActivePresets(
  activePresets: ReadonlyArray<FilterPreset>,
  state: FilterState,
  indices: Map<string, InvertedIndex>,
  allLocalIds: Map<string, Set<number>>,
): CustomPresetResult {
  const byPreset = new Map<string, Map<string, Set<number>>>();

  for (const preset of activePresets) {
    const location = findPresetLocation(preset.id, state.customTree);
    if (!location) continue;
    // Re-check hidden at evaluation time: the caller passes
    // only "active" presets, but the hidden set may have
    // changed since the caller collected them. Hidden wins.
    const hidden = state.customHidden.get(location.groupId);
    if (hidden?.has(location.leafId)) continue;

    const key = `${location.groupId}::${location.leafId}`;
    const perModel = new Map<string, Set<number>>();
    for (const [modelId, index] of indices) {
      const modelAll = allLocalIds.get(modelId);
      if (!modelAll || modelAll.size === 0) continue;
      const matched = evaluatePresetForModel(preset, index, modelAll);
      if (matched.size > 0) perModel.set(modelId, matched);
    }
    byPreset.set(key, perModel);
  }

  return { byPreset };
}

/**
 * Wave 63: total number of elements (summed per model) that `preset`
 * matches across the indexed models. Used by the filter tree to flag
 * an active filter that matches nothing — the resolver skips such a
 * preset (it would otherwise hide everything), so without a "0
 * matches" hint the filter looked like it silently did nothing.
 */
export function countPresetMatches(
  preset: FilterPreset,
  indices: Map<string, InvertedIndex>,
  allLocalIds: Map<string, Set<number>>,
): number {
  let n = 0;
  for (const [modelId, index] of indices) {
    const modelAll = allLocalIds.get(modelId);
    if (!modelAll || modelAll.size === 0) continue;
    n += evaluatePresetForModel(preset, index, modelAll).size;
  }
  return n;
}

/**
 * Re-export the pure preset evaluator from `filterEvaluator.ts`
 * for downstream consumers that want to evaluate a single
 * preset against an element property source. Useful for
 * debugging and for the CustomFilterBuilder's live match-count
 * badge (per-element evaluation is O(1) once the source is in
 * memory).
 */
export { evaluatePreset };
