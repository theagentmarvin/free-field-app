// src/hooks/useBuildings.ts
//
// Reactive Dexie live-query for BuildingRecord rows under a project +
// imperative helpers for create / rename / delete. The list hook is
// the one the sidebar will subscribe to; the imperative helpers are
// called from <BuildingTabs> and <BuildingCreateDialog>.
//
// "Active building" is the responsibility of the caller (AppShell /
// <BuildingTabs>) — the hook only exposes the buildings list. We
// keep it that way to avoid baking "current active" into the table
// layer; the active flag is a UI concern that survives page refresh
// via Dexie persistence but isn't a column on the record (per
// docs/TASK-3-UI.md "State model" — the active flag was simplified
// to live in React state, not on the record).
//
// See docs/TASK-3-UI.md "Component breakdown" and
// docs/SPEC-PHASE-1.md §4 (BuildingRecord).

import { useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import {
  createBuilding as createBuildingRow,
  deleteBuilding as deleteBuildingRow,
  updateBuilding as updateBuildingRow,
} from "@ff/data/db/tables/buildings";
import type { BuildingRecord } from "@ff/types";

/**
 * Live-query the list of buildings under a project. Returns an empty
 * array while `projectId` is null (no project yet) or while Dexie is
 * still hydrating.
 *
 * Results are sorted by `createdAt` ascending so the tab order
 * matches the order the user created them.
 */
export function useBuildings(projectId: string | null): BuildingRecord[] {
  return (
    useLiveQuery(async () => {
      if (!projectId) return [] as BuildingRecord[];
      const rows = await db.buildings
        .where("projectId")
        .equals(projectId)
        .toArray();
      rows.sort((a, b) => a.createdAt - b.createdAt);
      return rows;
    }, [projectId]) ?? []
  );
}

export interface UseBuildingsActions {
  create: (name: string) => Promise<BuildingRecord>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/**
 * Returned as a separate hook so that the live-query result (which
 * re-renders on every change) and the action callbacks (stable
 * identity) can be subscribed to independently. AppShell typically
 * calls both, but a leaf component that only needs the actions (e.g.
 * a non-tab building menu somewhere) can call this one alone.
 */
export function useBuildingActions(
  projectId: string,
): UseBuildingsActions {
  const create = useCallback(
    async (name: string): Promise<BuildingRecord> => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error("Building name cannot be empty");
      }
      return createBuildingRow({
        projectId,
        name: trimmed,
        metadata: {},
      });
    },
    [projectId],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<void> => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error("Building name cannot be empty");
      }
      await updateBuildingRow(id, { name: trimmed });
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    await deleteBuildingRow(id);
  }, []);

  return { create, rename, remove };
}
