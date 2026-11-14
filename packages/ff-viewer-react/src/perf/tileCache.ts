// packages/ff-viewer-react/src/perf/tileCache.ts
//
// Wave 62 — skip rebuilding tile geometry on repeat visits.
//
// The fragments worker turns a model into tile geometry on every load
// (seconds of CPU for a big model). The local engine patch
// (patches/@thatopen__fragments@3.6.0.patch, `TileCache`) stores the
// built tiles in IndexedDB ("ff-fragments-tile-cache") and restores them
// on the next load of the same model bytes. This module only builds the
// per-load engine option (`virtualModelConfig.tileCache`).
//
// The engine keys records by FORMAT | byte length | content fingerprint |
// our key, and validates each record against the tile layout before use,
// so a stale entry can only miss (rebuild), never draw wrong geometry.

/** Engine option `virtualModelConfig.tileCache` (see the patch). */
export interface EngineTileCache {
  /** Must change whenever the model bytes change. */
  key: string;
  /** Only models with at least this many bytes are cached. */
  minBytes: number;
  /** Models kept in the store (least recently used beyond this are dropped). */
  maxModels: number;
  /** Longest a tile waits for the store before it is built normally (ms). */
  waitMs: number;
}

/** IfcViewer `tileCache` prop tuning. */
export interface TileCacheConfig {
  /** Minimum model size in bytes (default {@link TILE_CACHE_MIN_BYTES}). */
  minBytes?: number;
  /** Models kept (default {@link TILE_CACHE_MAX_MODELS}). */
  maxModels?: number;
  /** Store wait cap in ms (default {@link TILE_CACHE_WAIT_MS}). */
  waitMs?: number;
}

/** Small models rebuild in well under a second: not worth the disk. */
export const TILE_CACHE_MIN_BYTES = 16 * 1024 * 1024;
/** Tile data is ~5-8x the .frag size, so keep only a few models. */
export const TILE_CACHE_MAX_MODELS = 6;
export const TILE_CACHE_WAIT_MS = 4000;

export interface TileCacheModel {
  /** FreeField file id. */
  fileId: string;
  /** Version blob key (`<fileId>__v<n>`), or the version id. */
  versionKey: string;
}

/** The engine option for one load, or undefined when the cache is off. */
export function resolveTileCache(
  prop: TileCacheConfig | boolean | undefined,
  model: TileCacheModel,
): EngineTileCache | undefined {
  if (prop === false || prop === undefined) return undefined;
  if (!model.fileId || !model.versionKey) return undefined;
  const cfg: TileCacheConfig = typeof prop === "object" && prop ? prop : {};
  return {
    key: `${model.fileId}|${model.versionKey}`,
    minBytes: Math.max(0, cfg.minBytes ?? TILE_CACHE_MIN_BYTES),
    maxModels: Math.max(1, Math.floor(cfg.maxModels ?? TILE_CACHE_MAX_MODELS)),
    waitMs: Math.max(0, cfg.waitMs ?? TILE_CACHE_WAIT_MS),
  };
}
