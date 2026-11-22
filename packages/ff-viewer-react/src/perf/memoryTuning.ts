// packages/ff-viewer-react/src/perf/memoryTuning.ts
//
// Wave 78 — memory tuning for low-RAM devices (a 3.5 GB tablet running a
// 3-model federation). Everything here is opt-in through the IfcViewer
// `memoryTuning` prop: unset, the viewer behaves exactly as before.
//
// What the engine lets us shape (see the fragments patch):
//   - `graphicsQuality` (per model): lower = a coarser screen-size cull. The
//     engine maps it to a factor `q * -1.5 + 2` on its pixel thresholds, so
//     the default 0 gives 2x, and a NEGATIVE value culls even more (a value
//     of -1 gives 3.5x). Fewer visible tiles = less GPU and worker memory.
//   - LOD mode: ALL_GEOMETRY (the viewer's default) draws real geometry for
//     everything not culled; DEFAULT draws small/far items as line stand-ins,
//     which cost a fraction of the triangles.
//   - `graphicBudget` (bytes): cap of the cache of INVISIBLE tiles in each
//     worker (the engine otherwise sizes it from the screen, up to 1 GB).
//   - `meshCache` (bytes): cap of each worker's decoded-mesh LRU (the engine
//     otherwise uses 100 MB x navigator.deviceMemory).
//   - worker pool size.

export type MemoryLodMode = "all-geometry" | "default";
export type MemoryPressure = "none" | "low" | "critical";

export interface MemoryTuning {
  /** Per-model engine `graphicsQuality`. 0 is the engine default; negative values cull harder. */
  graphicsQuality?: number;
  /** Draw mode for small / far items (default "all-geometry", the web behaviour). */
  lodMode?: MemoryLodMode;
  /** Cap (bytes) of each worker's cache of invisible tiles. */
  graphicBudgetBytes?: number;
  /** Cap (bytes) of each worker's decoded-mesh cache. */
  meshCacheBytes?: number;
  /** Size of the fragments worker pool. */
  maxWorkers?: number;
  /**
   * Leaner tile buffers: no per-vertex face-id colours (12 bytes a vertex on the GPU, only the id-pass picker reads
   * them) and no second CPU copy of the index buffers (renderer memory). Tiles then draw through the group path, so
   * partial-visibility compaction is off. Do not use with the id-pass picker.
   */
  leanTiles?: boolean;
}

/** What the engine reads (see the patch): `globalThis.__ffFragmentsMemory`. */
export interface EngineMemoryBudget {
  graphicBudget?: number;
  meshCache?: number;
  leanTiles?: boolean;
}

export interface EffectiveMemory {
  graphicsQuality: number;
  graphicBudgetBytes: number | undefined;
  meshCacheBytes: number | undefined;
  leanTiles: boolean;
}

/** Quality steps taken off per pressure level, and the budget scale. */
const PRESSURE_QUALITY_DROP: Record<MemoryPressure, number> = { none: 0, low: 0.5, critical: 1.5 };
const PRESSURE_BUDGET_SCALE: Record<MemoryPressure, number> = { none: 1, low: 0.25, critical: 0 };
const PRESSURE_MESH_SCALE: Record<MemoryPressure, number> = { none: 1, low: 0.5, critical: 0.1 };

/** Tuning values under a pressure level (pure). */
export function effectiveMemory(t: MemoryTuning, pressure: MemoryPressure): EffectiveMemory {
  return {
    graphicsQuality: (t.graphicsQuality ?? 0) - PRESSURE_QUALITY_DROP[pressure],
    graphicBudgetBytes: t.graphicBudgetBytes === undefined ? (pressure === "none" ? undefined : 0) : Math.floor(t.graphicBudgetBytes * PRESSURE_BUDGET_SCALE[pressure]),
    meshCacheBytes: t.meshCacheBytes === undefined ? undefined : Math.max(1, Math.floor(t.meshCacheBytes * PRESSURE_MESH_SCALE[pressure])),
    leanTiles: t.leanTiles === true,
  };
}

/** Publish the budgets the (patched) engine reads on every view refresh. `undefined` removes the override. */
export function publishEngineBudget(e: EffectiveMemory, target: { __ffFragmentsMemory?: EngineMemoryBudget } = globalThis as never): void {
  const b: EngineMemoryBudget = {};
  if (e.graphicBudgetBytes !== undefined) b.graphicBudget = e.graphicBudgetBytes;
  if (e.meshCacheBytes !== undefined) b.meshCache = e.meshCacheBytes;
  if (e.leanTiles) b.leanTiles = true;
  if (Object.keys(b).length === 0) delete target.__ffFragmentsMemory;
  else target.__ffFragmentsMemory = b;
}

export function clearEngineBudget(target: { __ffFragmentsMemory?: EngineMemoryBudget } = globalThis as never): void {
  delete target.__ffFragmentsMemory;
}
