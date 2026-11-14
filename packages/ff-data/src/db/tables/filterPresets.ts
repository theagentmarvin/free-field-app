// src/core/db/tables/filterPresets.ts
//
// CRUD for the v6 `filterPresets` table. One row per saved user
// filter preset, keyed by (buildingId, presetId). Mirrors the
// `pdfFiles` shape (pure functions, no React, no live-query logic —
// the live-query hook lives in
// apps/models/src/hooks/useFilterPresetsForBuilding.ts).
//
// Cascade policy:
//   - building deletion (when it lands) should clean up filterPresets
//     for that building. Currently `deleteBuilding` doesn't exist in
//     the CRUD layer; a follow-up should wire the cascade.
//
// See the Task 20D filter spec §"Dexie Persistence" for
// the schema rationale and index choices.

import { db } from "../database";
import { uuid } from "../uuid";
import type {
  Combinator,
  ConditionGroup,
  FilterPresetRecord,
} from "@ff/types";

export type CreateFilterPresetInput = Omit<
  FilterPresetRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<FilterPresetRecord, "id" | "createdAt" | "updatedAt">>;

/**
 * Insert a new FilterPresetRecord row. If a row with the same `id`
 * already exists, Dexie's primary-key constraint will throw — use
 * `upsertFilterPreset` for the create-or-update pattern.
 */
export async function createFilterPreset(
  input: CreateFilterPresetInput,
): Promise<FilterPresetRecord> {
  const now = Date.now();
  const record: FilterPresetRecord = {
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    name: input.name,
    combinator: input.combinator,
    groups: input.groups,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.filterPresets.add(record);
  return record;
}

export async function getFilterPreset(
  id: string,
): Promise<FilterPresetRecord | undefined> {
  return db.filterPresets.get(id);
}

/**
 * List presets for a building, sorted most-recently-updated first.
 * Matches the live-query shape in
 * apps/models/src/hooks/useFilterPresetsForBuilding.ts.
 */
export async function listFilterPresetsByBuilding(
  buildingId: string,
): Promise<FilterPresetRecord[]> {
  const rows = await db.filterPresets
    .where("[buildingId+updatedAt]")
    .between([buildingId, 0], [buildingId, Number.MAX_SAFE_INTEGER])
    .toArray();
  // Dexie's `between` on a compound index returns ASCENDING. The
  // hook wants most-recent first — reverse here.
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

export type UpdateFilterPresetPatch = Partial<
  Omit<
    FilterPresetRecord,
    "id" | "buildingId" | "createdAt"
  >
>;

/**
 * Update a preset by id. Stamps `updatedAt` automatically.
 */
export async function updateFilterPreset(
  id: string,
  patch: UpdateFilterPresetPatch,
): Promise<void> {
  await db.filterPresets.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Upsert a preset by id. Used by the editor's save flow: the row
 * may not exist yet (first save of a freshly-authored preset) or
 * may already be on disk (subsequent edits). On insert we stamp
 * `createdAt`; on update we stamp `updatedAt` and preserve
 * `createdAt`.
 */
export async function upsertFilterPreset(
  input: CreateFilterPresetInput,
): Promise<FilterPresetRecord> {
  const existing = await db.filterPresets.get(input.id ?? "");
  const now = Date.now();
  if (existing) {
    const next: FilterPresetRecord = {
      ...existing,
      buildingId: input.buildingId,
      name: input.name,
      combinator: input.combinator,
      groups: input.groups,
      updatedAt: now,
    };
    await db.filterPresets.put(next);
    return next;
  }
  const record: FilterPresetRecord = {
    id: input.id ?? uuid(),
    buildingId: input.buildingId,
    name: input.name,
    combinator: input.combinator,
    groups: input.groups,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.filterPresets.put(record);
  return record;
}

/**
 * Delete a preset by id. The compound `[buildingId+updatedAt]`
 * index makes this a single-row removal; the custom-tree mirror in
 * modelsToolStore is the caller's responsibility.
 */
export async function deleteFilterPreset(id: string): Promise<void> {
  await db.filterPresets.delete(id);
}

/**
 * Cascade helper — delete every preset for a building. Called when
 * the building goes away (or when the user requests a hard reset).
 * Not yet wired to a building-deletion action; exists for future
 * use.
 */
export async function deleteFilterPresetsForBuilding(
  buildingId: string,
): Promise<void> {
  await db.filterPresets
    .where("buildingId")
    .equals(buildingId)
    .delete();
}

// Type re-exports so callers can write `import type { FilterPresetRecord }
// from "./filterPresets"` without a second import line.
export type {
  Combinator,
  ConditionGroup,
  FilterPresetRecord,
};
