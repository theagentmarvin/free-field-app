import { useEffect, useMemo, useState } from "react";

import { useAuth, useProjectId } from "@ff/auth";

import { useTasksSource } from "./tasksSource";
import { mergePanelTasks, type PanelTask } from "./panelLogic";
import { useOutboxRows } from "./useOutboxRows";
import { tasksForBuilding, useTaskBuildingIndex } from "./taskBuilding";

/**
 * The panel's live-query feed (Wave 9, spec §A "NO new data path").
 * Subscribes the EXISTING `useTasksSource` live query (demo → Dexie,
 * cloud → Firestore) and folds queued outbox actions in with
 * `mergePanelTasks` — the same overlay discipline the list/table use,
 * but PRESERVING `location` so freshly-created (pending) tasks still
 * scope "In view".
 *
 * The panel component itself stays presentational: it receives the
 * merged rows as props; this hook is the host's one-line data source.
 *
 * `buildingId` (2026-11-14): viewers inside a building (Models, LinkView,
 * Documents) pass the active building and get ONLY its tasks — by the
 * task's own building, else by the model/PDF it is pinned to
 * (`taskBuilding.ts`). `null` = no building selected → no tasks. Omit it
 * (the Tasks module) to list every task in the project.
 */
export function usePanelTasks(
  opts: { buildingId?: string | null } = {},
): PanelTask[] {
  const { buildingId } = opts;
  const buildingIndex = useTaskBuildingIndex();
  const source = useTasksSource();
  const projectId = useProjectId();

  const [cloud, setCloud] = useState<PanelTask[]>([]);
  useEffect(() => {
    if (!projectId) {
      setCloud([]);
      return;
    }
    let unsub = () => {};
    try {
      unsub = source.watchTasks(projectId, null, (tasks) => setCloud(tasks as PanelTask[]), 100);
    } catch {
      /* no backend — pending outbox rows still merge through */
    }
    return () => unsub();
  }, [source, projectId]);

  const rows = useOutboxRows(projectId);

  return useMemo(() => {
    const merged = mergePanelTasks(cloud, rows, source.overlaySending);
    return buildingId === undefined
      ? merged
      : tasksForBuilding(merged, buildingId, buildingIndex);
  }, [cloud, rows, source.overlaySending, buildingId, buildingIndex]);
}

/** The current actor uid driving the panel's `Mine` filter. Demo → the
 *  synthetic role identity (admin@demo → "demo-admin"); cloud → the real
 *  Firebase uid. Falls back to null when there is no identity. */
export function usePanelActorUid(): string | null {
  const { user } = useAuth();
  return user?.uid ?? null;
}