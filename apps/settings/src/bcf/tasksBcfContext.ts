// src/bcf/tasksBcfContext.ts
//
// Host half of the Tasks BCF export (@ff/tasks-react `TasksBcfContext`):
// base-model shift and IFC GlobalIds for a task's linked elements. The
// tasks package must not import the viewer or the settings data layer, so
// this module owns that lookup. All side effects are injected
// (`BcfContextDeps`) so the resolution order is unit-testable.
//
// Base shift (must equal the viewer's base for the building; world =
// (ifcX, ifcZ, -ifcY) + shift), first hit wins:
//   1. building.metadata.bundleBaseShift (written by the bundle import)
//   2. the base IFC's stored .frag `getCoordinates()` (pickBaseIfcFile)
//   3. the live shared viewer's `getBaseCoordinates()`, only when the
//      viewer has one of this building's models loaded
//   4. null (the export then writes no camera, snapshot only)
//
// GlobalIds: the live viewer's `getGlobalIds` when the model is loaded,
// otherwise the model's stored .frag. Validated as 22 chars [0-9A-Za-z_$].

import { getBuilding } from "@ff/data/db/tables/buildings";
import { getIfcFile, listIfcFiles } from "@ff/data/db/tables/ifcFiles";
import type { TasksBcfContext } from "@ff/tasks-react";

import { readVersionShift } from "../bundle/fragCoordinates";
import { BASE_SHIFT_KEY, pickBaseIfcFile } from "../bundle/importBundle";
import { readVersionGuids } from "./fragGuids";

export type Shift = [number, number, number];

export interface BcfFileRef {
  id: string;
  name: string;
  currentVersionId: string;
}

/** The slice of the shared viewer handle this module uses. */
export interface BcfViewerLike {
  readonly loadedModelIds: ReadonlySet<string>;
  getBaseCoordinates?(): [number, number, number] | null;
  getGlobalIds?(modelId: string, expressIds: number[]): Promise<Array<string | null> | null>;
}

export interface BcfContextDeps {
  getBuildingMetadata(buildingId: string): Promise<Record<string, unknown> | undefined>;
  listFiles(buildingId: string): Promise<BcfFileRef[]>;
  getFile(modelId: string): Promise<BcfFileRef | undefined>;
  readVersionShift(versionId: string): Promise<readonly [number, number, number]>;
  readVersionGuids(versionId: string, ids: number[]): Promise<Array<string | null>>;
  getViewer(): BcfViewerLike | null;
}

const GUID_RE = /^[0-9A-Za-z_$]{22}$/;

export function isIfcGuid(v: unknown): v is string {
  return typeof v === "string" && GUID_RE.test(v);
}

function isShift(v: unknown): v is Shift {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Caches are per building / model and expire so a replaced model is re-read. */
export const BCF_CACHE_TTL_MS = 60_000;

export function createTasksBcfContext(deps: BcfContextDeps, now: () => number = Date.now): TasksBcfContext {
  const shiftCache = new Map<string, { at: number; value: Shift }>();
  // modelId -> expressId -> validated guid | null
  let guidCache = new Map<string, Map<number, string | null>>();
  let guidCacheAt = now();

  async function resolveBaseShift(buildingId: string | null): Promise<Shift | null> {
    if (!buildingId) return null;
    const hit = shiftCache.get(buildingId);
    if (hit && now() - hit.at < BCF_CACHE_TTL_MS) return hit.value;
    const found = await lookupShift(buildingId);
    if (found) shiftCache.set(buildingId, { at: now(), value: found });
    return found;
  }

  async function lookupShift(buildingId: string): Promise<Shift | null> {
    // 1. recorded at bundle import
    try {
      const stored = (await deps.getBuildingMetadata(buildingId))?.[BASE_SHIFT_KEY];
      if (isShift(stored)) return [stored[0], stored[1], stored[2]];
    } catch {
      /* fall through */
    }
    let files: BcfFileRef[] = [];
    try {
      files = await deps.listFiles(buildingId);
    } catch {
      /* fall through to the live viewer */
    }
    // 2. the base model's stored fragment
    try {
      const base = pickBaseIfcFile(files, (f) => !!f.currentVersionId);
      if (base) {
        const s = await deps.readVersionShift(base.currentVersionId);
        if (isShift(s)) return [s[0], s[1], s[2]];
      }
    } catch {
      /* fall through */
    }
    // 3. the live viewer, only when it holds a model of this building
    try {
      const viewer = deps.getViewer();
      if (viewer?.getBaseCoordinates && files.some((f) => viewer.loadedModelIds.has(f.id))) {
        const c = viewer.getBaseCoordinates();
        if (isShift(c)) return [c[0], c[1], c[2]];
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  async function guidsForModel(modelId: string, ids: number[]): Promise<void> {
    let cache = guidCache.get(modelId);
    if (!cache) {
      cache = new Map();
      guidCache.set(modelId, cache);
    }
    const missing = [...new Set(ids)].filter((id) => !cache!.has(id));
    if (missing.length === 0) return;
    let raw: Array<string | null> | null = null;
    const viewer = deps.getViewer();
    if (viewer?.getGlobalIds && viewer.loadedModelIds.has(modelId)) {
      try {
        raw = await viewer.getGlobalIds(modelId, missing);
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      try {
        const file = await deps.getFile(modelId);
        raw = file ? await deps.readVersionGuids(file.currentVersionId, missing) : null;
      } catch {
        raw = null;
      }
    }
    if (!raw) return; // not cached: a later export may succeed
    missing.forEach((id, i) => cache!.set(id, isIfcGuid(raw![i]) ? (raw![i] as string) : null));
  }

  async function resolveGlobalIds(
    _buildingId: string | null,
    elements: { modelId: string; expressId: number }[],
  ): Promise<Array<{ ifcGuid: string; originatingSystem?: string; authoringToolId?: string } | null>> {
    if (now() - guidCacheAt >= BCF_CACHE_TTL_MS) {
      guidCache = new Map();
      guidCacheAt = now();
    }
    const byModel = new Map<string, number[]>();
    for (const e of elements) {
      const list = byModel.get(e.modelId) ?? [];
      list.push(e.expressId);
      byModel.set(e.modelId, list);
    }
    const names = new Map<string, string | undefined>();
    for (const [modelId, ids] of byModel) {
      await guidsForModel(modelId, ids);
      try {
        names.set(modelId, (await deps.getFile(modelId))?.name);
      } catch {
        names.set(modelId, undefined);
      }
    }
    return elements.map((e) => {
      const guid = guidCache.get(e.modelId)?.get(e.expressId) ?? null;
      if (!guid) return null;
      return { ifcGuid: guid, originatingSystem: names.get(e.modelId), authoringToolId: `${e.modelId}:${e.expressId}` };
    });
  }

  // No deep-link route for a task exists in the app (task open intents are
  // in-memory only), so `taskUrl` is intentionally not provided.
  return { resolveBaseShift, resolveGlobalIds };
}

/** Production deps over the local Dexie data layer + the shared viewer ref. */
export function makeBcfContextDeps(getViewer: () => BcfViewerLike | null): BcfContextDeps {
  const toRef = (f: { id: string; name: string; currentVersionId: string }): BcfFileRef => ({
    id: f.id,
    name: f.name,
    currentVersionId: f.currentVersionId,
  });
  return {
    getBuildingMetadata: async (id) => (await getBuilding(id))?.metadata,
    listFiles: async (id) => (await listIfcFiles(id)).map(toRef),
    getFile: async (id) => {
      const f = await getIfcFile(id);
      return f ? toRef(f) : undefined;
    },
    readVersionShift,
    readVersionGuids,
    getViewer,
  };
}
