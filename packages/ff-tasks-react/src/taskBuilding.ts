// packages/ff-tasks-react/src/taskBuilding.ts
//
// Building scope for tasks shown INSIDE a building's viewers (Models,
// LinkView, Documents): pins and task panels there must only show the
// active building's tasks. The Tasks module keeps listing across
// buildings and does not use this.
//
// A task's EFFECTIVE building is:
//   1. its own `buildingId`, when set (every task created from a viewer
//      is stamped with the active building);
//   2. otherwise the building that owns where it is pinned — the IFC
//      model of its 3D location (`location.bim.elements[].modelId` is the
//      IfcFile id) or the PDF of its plan location
//      (`location.pdf.pdfFileId`). This covers tasks created before
//      stamping and the demo seed;
//   3. otherwise none — an unlocated, unassigned task belongs to no
//      building and only appears in the Tasks module.

import { useLiveQuery } from "dexie-react-hooks";

import { db as localDb } from "@ff/data/db/database";

/** IfcFile id → building id, PdfFile id → building id. */
export interface TaskBuildingIndex {
  modelToBuilding: ReadonlyMap<string, string>;
  pdfToBuilding: ReadonlyMap<string, string>;
}

export const EMPTY_TASK_BUILDING_INDEX: TaskBuildingIndex = {
  modelToBuilding: new Map(),
  pdfToBuilding: new Map(),
};

/** The task shape this module reads (a structural subset of a task doc). */
export interface BuildingScopedTask {
  buildingId?: string | null;
  location?: {
    bim?: { elements?: ReadonlyArray<unknown> | null } | null;
    pdf?: unknown;
  } | null;
}

/** The task's effective building id (see the file header), or null. */
export function effectiveTaskBuildingId(
  task: BuildingScopedTask,
  index: TaskBuildingIndex,
): string | null {
  if (typeof task.buildingId === "string" && task.buildingId.length > 0) {
    return task.buildingId;
  }
  const loc = task.location;
  for (const raw of loc?.bim?.elements ?? []) {
    const el = raw as { modelId?: string | null } | null;
    const b = el?.modelId ? index.modelToBuilding.get(el.modelId) : undefined;
    if (b) return b;
  }
  const pdfId = (loc?.pdf as { pdfFileId?: string | null } | null | undefined)?.pdfFileId;
  if (pdfId) {
    const b = index.pdfToBuilding.get(pdfId);
    if (b) return b;
  }
  return null;
}

/**
 * Strict building scope: only tasks whose effective building is
 * `buildingId`. `null` (no building selected) → nothing. Each kept task
 * is returned with its effective `buildingId` filled in, so downstream
 * pin extraction carries the scope too.
 */
export function tasksForBuilding<T extends BuildingScopedTask>(
  tasks: readonly T[],
  buildingId: string | null,
  index: TaskBuildingIndex,
): T[] {
  if (!buildingId) return [];
  const out: T[] = [];
  for (const t of tasks) {
    if (effectiveTaskBuildingId(t, index) === buildingId) {
      out.push(t.buildingId === buildingId ? t : { ...t, buildingId });
    }
  }
  return out;
}

/**
 * Live index of which building owns each IFC model and PDF file (local
 * Dexie rows, so it updates when files are added, moved or deleted).
 */
export function useTaskBuildingIndex(): TaskBuildingIndex {
  return (
    useLiveQuery(async () => {
      const [ifcs, pdfs] = await Promise.all([
        localDb.ifcFiles.toArray(),
        localDb.pdfFiles.toArray(),
      ]);
      return {
        modelToBuilding: new Map(ifcs.map((f) => [f.id, f.buildingId] as const)),
        pdfToBuilding: new Map(pdfs.map((f) => [f.id, f.buildingId] as const)),
      } satisfies TaskBuildingIndex;
    }, []) ?? EMPTY_TASK_BUILDING_INDEX
  );
}

/**
 * Rows with their EFFECTIVE building filled in. Old tasks (created
 * before stamping, or from an entry point that did not stamp) carry no
 * `buildingId`; the Tasks table, detail and filters read the building
 * through this so they show the building the task is pinned in.
 */
export function withEffectiveBuilding<T extends BuildingScopedTask>(
  tasks: readonly T[],
  index: TaskBuildingIndex,
): T[] {
  return tasks.map((t) => {
    const eff = effectiveTaskBuildingId(t, index);
    return eff && t.buildingId !== eff ? { ...t, buildingId: eff } : t;
  });
}

/** Display name of the task's effective building, or null. */
export function taskBuildingLabel(
  task: BuildingScopedTask,
  index: TaskBuildingIndex,
  buildings: readonly { id: string; name: string }[] | undefined,
): string | null {
  const id = effectiveTaskBuildingId(task, index);
  return id ? (buildings?.find((b) => b.id === id)?.name ?? null) : null;
}

/**
 * The building a NEW task is stamped with: the user's explicit choice,
 * else the creation context (the active building of the viewer / rail
 * it was created from), else the building that owns where it is pinned.
 */
export function resolveCreateBuildingId(
  args: {
    explicit?: string | null;
    context?: string | null;
    location?: BuildingScopedTask["location"];
  },
  index: TaskBuildingIndex,
): string | null {
  if (args.explicit) return args.explicit;
  if (args.context) return args.context;
  return effectiveTaskBuildingId({ location: args.location ?? null }, index);
}
