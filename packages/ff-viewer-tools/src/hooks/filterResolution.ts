// apps/models/src/hooks/filterResolution.ts
//
// Pure resolution function for the filters panel — given the current
// `FilterState` and the express-id maps built from the loaded viewer
// fragments + Dexie, return the express IDs that should be visible in
// the scene, PER MODEL (modelId → ids; ids overlap across models).
//
// Resolution semantics (Addendum B §B.3):
//   - For each auto folder (Models / Levels):
//       * `enabled` is the active set (funnel toggled on).
//       * `hidden` is the explicit-visibility-off set (eye-off).
//       * Empty `enabled` = WILDCARD (every entry in that folder's map
//         contributes its express IDs).
//       * Non-empty `enabled` = include only those entries' express IDs.
//       * `hidden` entries are filtered out in BOTH cases.
//   - The two auto folders are AND-joined: an express ID is in the
//     result iff it's in BOTH the models set and the levels set.
//   - For each CUSTOM group with a non-empty `customActive` set:
//       * Each active preset within a group is AND-joined
//         individually with the running result (presets are
//         independent constraints — "Status = X AND Cycle = Y"
//         not "Status = X OR Cycle = Y").
//       * Empty `customActive` per group = WILDCARD for that group
//         (no further constraint — does NOT remove from result).
//       * Each non-wildcard custom group is AND-joined with the
//         running result (same as before — groups are the outer
//         AND container, presets within are also AND'd).
//
// Element addressing note: the filter pipeline uses **express IDs**
// from the fragments model only. No `IfcGuid` lookup anywhere.
//
// This module has NO React, NO Dexie, NO viewer dependencies — it's
// a pure function so unit tests can hammer the AND/OR/wildcard/
// hidden semantics without any setup.

import type { FilterState } from "../modelsToolStore";

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Element ids grouped by the model they live in: modelId → localIds.
 * Element (express / local) ids are only unique WITHIN a model — two
 * federated models routinely share ids — so every id set that crosses
 * model boundaries is keyed by model (wave 63).
 */
export type PerModelIds = Map<string, Set<number>>;

/**
 * The express-id maps the caller feeds into `computeMatchingExpressIds`.
 *
 *   - `modelToExpressIds`  → ifcFileId (= modelId) → ids  (Models folder)
 *   - `levelToExpressIds`  → level key → modelId → ids    (Levels folder)
 *   - `customToExpressIds` → `${groupId}::${entryId}` → modelId → ids
 *
 * Empty maps = "no viewer data" (the current stub state).
 */
export interface ModelsToolFilters {
  modelToExpressIds: Map<string, Set<number>>;
  levelToExpressIds: Map<string, PerModelIds>;
  customToExpressIds: Map<string, PerModelIds>;
}

/** Union the per-model ids of several entries into `into`. */
function unionInto(into: PerModelIds, src: PerModelIds): void {
  for (const [modelId, ids] of src) {
    let acc = into.get(modelId);
    if (!acc) {
      acc = new Set<number>();
      into.set(modelId, acc);
    }
    for (const id of ids) acc.add(id);
  }
}

/** Total id count across every model of a per-model map. */
export function countPerModelIds(m: ReadonlyMap<string, ReadonlySet<number>>): number {
  let n = 0;
  for (const ids of m.values()) n += ids.size;
  return n;
}

/**
 * Resolve the ids that should be visible under the given filter state
 * and express-id maps, per model (modelId → visible ids). A model with
 * nothing matching is absent or maps to an empty set.
 *
 * The function is pure and side-effect-free. Re-running it with the
 * same inputs always returns the same result.
 */
export function computeMatchingExpressIds(
  state: FilterState,
  data: ModelsToolFilters,
): PerModelIds {
  // ── 1. Models folder ─────────────────────────────────────────────────
  const result: PerModelIds = new Map();
  const modelsActive = state.auto.models.enabled;
  const modelsHidden = state.auto.models.hidden;
  const modelIds =
    modelsActive.size === 0
      ? Array.from(data.modelToExpressIds.keys()) // wildcard
      : Array.from(modelsActive);
  for (const id of modelIds) {
    if (modelsHidden.has(id)) continue;
    const ids = data.modelToExpressIds.get(id);
    if (!ids) continue;
    result.set(id, new Set(ids));
  }

  // ── 2. Levels folder (AND-joined with Models, per model) ─────────────
  // Pass-through when level data hasn't loaded yet (spatial structure
  // query still in flight). Without this, the AND-join kills all
  // elements because levelMatched is empty.
  if (data.levelToExpressIds.size > 0) {
    const levelMatched: PerModelIds = new Map();
    const levelsActive = state.auto.levels.enabled;
    const levelsHidden = state.auto.levels.hidden;
    const levelKeys =
      levelsActive.size === 0
        ? Array.from(data.levelToExpressIds.keys())
        : Array.from(levelsActive);
    for (const key of levelKeys) {
      if (levelsHidden.has(key)) continue;
      const perModel = data.levelToExpressIds.get(key);
      if (perModel) unionInto(levelMatched, perModel);
    }
    for (const [modelId, ids] of result) {
      const lv = levelMatched.get(modelId);
      if (!lv) {
        ids.clear();
        continue;
      }
      for (const eid of Array.from(ids)) if (!lv.has(eid)) ids.delete(eid);
    }
  }

  // ── 3. Custom groups (AND across presets — each active preset
  //    is an independent constraint). ────────────────────────────────
  // Pass-through: if the property index hasn't been built yet
  // (customToExpressIds is empty), skip custom AND-join entirely.
  // Without this guard, an active custom preset with an empty index
  // takes `groupMatched=0` and AND-joins it with the running result,
  // zeroing out ALL elements — hiding the whole model.
  if (data.customToExpressIds.size === 0) {
    return result;
  }
  for (const [groupId, activeSet] of state.customActive) {
    if (activeSet.size === 0) {
      // Wildcard for this group — skip AND-join.
      continue;
    }
    const hiddenSet: ReadonlySet<string> =
      state.customHidden.get(groupId) ?? EMPTY_SET;
    for (const entryId of activeSet) {
      if (hiddenSet.has(entryId)) continue;
      const key = `${groupId}::${entryId}`;
      const perModel = data.customToExpressIds.get(key);
      // Skip presets that match nothing in ANY model — prevents one
      // empty preset from zeroing out the entire result set. The UI
      // reports these as "0 matches" (see `countPerModelIds`).
      if (!perModel || countPerModelIds(perModel) === 0) continue;
      // AND-join per model: only keep elements of THIS model that
      // also match the preset in THIS model.
      for (const [modelId, ids] of result) {
        const matched = perModel.get(modelId);
        if (!matched) {
          ids.clear();
          continue;
        }
        for (const eid of Array.from(ids)) {
          if (!matched.has(eid)) ids.delete(eid);
        }
      }
    }
  }

  return result;
}
