// src/hooks/useLevelSelection.ts
//
// Reactive Dexie live-query + write helpers for the
// BuildingLevelSelectionRecord table (Dexie v2). The "default-checked"
// invariant from docs/TASK-3-UI.md is implemented in
// `getEffectiveSelection` (a pure helper) and in the read-side
// aggregator that builds the level list with the default layered on
// top of the explicit rows.
//
// See docs/TASK-3-UI.md "Data model additions" + "Get Levels popover
// flow".

import { useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import {
  getBuildingLevelSelection,
  putBuildingLevelSelection,
  putBuildingLevelSelections,
} from "@ff/data/db/tables/buildingLevelSelection";
import type { BuildingLevelSelectionRecord } from "@ff/types";

/**
 * Pure helper. Returns `true` for a (building, level) pair with no
 * explicit row, otherwise the row's `selected` value. Implementing
 * the "default-checked" semantic here keeps the read paths honest:
 * callers never see `undefined` for selection, only booleans.
 */
export function isSelected(
  explicit: BuildingLevelSelectionRecord | undefined,
): boolean {
  return explicit ? explicit.selected : true;
}

/**
 * Live-query every explicit row for a building. Returns `[]` while
 * Dexie is still hydrating or `buildingId` is null.
 *
 * Most callers want `getEffectiveSelection` (a per-pair lookup) or
 * `useLevelSelectionMap` (a per-building map). This raw hook is
 * exposed for tests and for the popover's "show me the explicit
 * overrides" debug path.
 */
/**
 * Stable "not loaded yet" value: a fresh `[]` per render would change
 * identity every render and re-fire effects that depend on the rows.
 */
const NO_ROWS: BuildingLevelSelectionRecord[] = [];

export function useLevelSelectionRows(
  buildingId: string | null,
): BuildingLevelSelectionRecord[] {
  return (
    useLiveQuery(async () => {
      if (!buildingId) return NO_ROWS;
      return db.buildingLevelSelection
        .where("buildingId")
        .equals(buildingId)
        .toArray();
    }, [buildingId]) ?? NO_ROWS
  );
}

/**
 * Snapshot the effective (default-checked + explicit overrides)
 * selection state for every level under a building. Returns a
 * `levelId -> boolean` map. Use this in the popover to seed its
 * initial checkbox state.
 */
export function useLevelSelectionMap(
  buildingId: string | null,
  levelIds: readonly string[],
): Record<string, boolean> {
  const rows = useLevelSelectionRows(buildingId);
  return buildEffectiveMap(rows, levelIds);
}

/** Pure helper exposed for tests. */
export function buildEffectiveMap(
  rows: BuildingLevelSelectionRecord[],
  levelIds: readonly string[],
): Record<string, boolean> {
  const explicit = new Map<string, boolean>();
  for (const r of rows) {
    explicit.set(r.levelId, r.selected);
  }
  const out: Record<string, boolean> = {};
  for (const id of levelIds) {
    out[id] = explicit.get(id) ?? true;
  }
  return out;
}

export interface UseLevelSelectionActions {
  setOne: (levelId: string, selected: boolean) => Promise<void>;
  setMany: (
    updates: ReadonlyArray<{ levelId: string; selected: boolean }>,
  ) => Promise<void>;
  /** Read the effective (default-checked) selection for a single level. */
  get: (levelId: string) => Promise<boolean>;
}

/**
 * Returned as a separate hook so the live-query result (re-renders
 * on every change) and the action callbacks (stable identity) can
 * be subscribed to independently.
 *
 * The `get` lookup is a one-shot Promise; the popover uses it on
 * open to seed its initial state. Live subscribers should use
 * `useLevelSelectionMap` instead.
 */
export function useLevelSelectionActions(
  buildingId: string,
): UseLevelSelectionActions {
  const setOne = useCallback(
    async (levelId: string, selected: boolean): Promise<void> => {
      await putBuildingLevelSelection({
        buildingId,
        levelId,
        selected,
      });
    },
    [buildingId],
  );

  const setMany = useCallback(
    async (
      updates: ReadonlyArray<{ levelId: string; selected: boolean }>,
    ): Promise<void> => {
      if (updates.length === 0) return;
      await putBuildingLevelSelections(
        updates.map((u) => ({
          buildingId,
          levelId: u.levelId,
          selected: u.selected,
        })),
      );
    },
    [buildingId],
  );

  const get = useCallback(
    async (levelId: string): Promise<boolean> => {
      const row = await getBuildingLevelSelection(buildingId, levelId);
      return isSelected(row);
    },
    [buildingId],
  );

  return { setOne, setMany, get };
}
