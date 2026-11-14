// packages/ff-viewer-react/src/perf/splitTileBuild.ts
//
// Wave 62 — split one big model's tile building across workers.
//
// The fragments engine runs one model on one worker. After a big model
// loads, that worker spends seconds building tile geometry at 100% CPU
// while the other cores idle. The local engine patch
// (patches/@thatopen__fragments@3.6.0.patch, `SplitTileBuild`) lets the
// owner worker spawn helper workers that hold a read-only copy of the
// model bytes and build tiles for it. The owner keeps every piece of
// state; the main thread still sees one model on one worker (same model
// id, local ids, tile ids), so selection, visibility, highlight,
// properties, levels, LinkView, etc. are untouched.
//
// This module only decides the engine option passed per `core.load`
// (`virtualModelConfig.splitTileBuild`). Off = the engine behaves exactly
// as before.

/** Engine option `virtualModelConfig.splitTileBuild` (see the patch). */
export interface EngineSplitTileBuild {
  /** Helper workers per big model. */
  helpers: number;
  /** Only models with at least this many (raw .frag) bytes are split. */
  minBytes: number;
  /** Tile builds in flight per helper (default 2). */
  inflight?: number;
  /** Helper geometry-cache budget in bytes (engine default: 100 MB x deviceMemory). */
  cacheBytes?: number;
}

/** IfcViewer `splitTileBuild` prop tuning. */
export interface SplitTileBuildConfig {
  /** Helper workers per big model (default: cores - 2, at most 3). */
  helpers?: number;
  /** Minimum model size in bytes (default {@link SPLIT_TILE_BUILD_MIN_BYTES}). */
  minBytes?: number;
  /** Tile builds in flight per helper (default 2). */
  inflight?: number;
  /** Helper geometry-cache budget in bytes (default {@link SPLIT_TILE_BUILD_CACHE_BYTES}). */
  cacheBytes?: number;
}

/** Models below this size build fast enough on one worker (same bar as the big-model load gate). */
export const SPLIT_TILE_BUILD_MIN_BYTES = 48 * 1024 * 1024;

/** Most helpers per model: past this the main thread's tile upload is the limit. */
export const SPLIT_TILE_BUILD_MAX_HELPERS = 3;

/** Each helper holds a full copy of the model: skip below this much device memory (GB). */
export const SPLIT_TILE_BUILD_MIN_DEVICE_MEMORY_GB = 4;

/** Helper geometry cache. Helpers only build each tile once per load, so a small cache is enough. */
export const SPLIT_TILE_BUILD_CACHE_BYTES = 256 * 1024 * 1024;

export interface SplitTileBuildEnv {
  /** `navigator.hardwareConcurrency` (0 / undefined = unknown). */
  cores?: number;
  /** `navigator.deviceMemory` in GB (undefined = unknown). */
  deviceMemoryGb?: number;
}

/**
 * Resolve the engine option from the IfcViewer prop and the device.
 * `undefined` = do not split (prop `false`, too few cores, too little
 * memory, or 0 helpers).
 */
export function resolveSplitTileBuild(
  prop: SplitTileBuildConfig | boolean | undefined,
  env: SplitTileBuildEnv,
): EngineSplitTileBuild | undefined {
  if (prop === false) return undefined;
  const cfg: SplitTileBuildConfig = typeof prop === "object" && prop ? prop : {};
  const cores = Number.isFinite(env.cores) ? Math.floor(env.cores as number) : 0;
  const mem = env.deviceMemoryGb;
  if (typeof mem === "number" && Number.isFinite(mem) && mem < SPLIT_TILE_BUILD_MIN_DEVICE_MEMORY_GB) {
    return undefined;
  }
  // The owner worker + helpers + the main thread (which uploads the
  // tiles) should fit the cores: helpers = cores - 2, capped.
  const auto = Math.min(SPLIT_TILE_BUILD_MAX_HELPERS, cores - 2);
  const helpers = Math.floor(cfg.helpers ?? auto);
  if (!(helpers >= 1)) return undefined;
  const out: EngineSplitTileBuild = {
    helpers,
    minBytes: Math.max(0, cfg.minBytes ?? SPLIT_TILE_BUILD_MIN_BYTES),
    cacheBytes: cfg.cacheBytes ?? SPLIT_TILE_BUILD_CACHE_BYTES,
  };
  if (cfg.inflight !== undefined && cfg.inflight >= 1) out.inflight = Math.floor(cfg.inflight);
  return out;
}

/** Read the device for {@link resolveSplitTileBuild}. */
export function readSplitTileBuildEnv(): SplitTileBuildEnv {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { cores: nav.hardwareConcurrency, deviceMemoryGb: nav.deviceMemory };
}
