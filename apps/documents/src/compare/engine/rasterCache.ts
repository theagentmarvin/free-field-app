// Small LRU of rendered rasters so a settings change (preset, margin, nudge,
// auto-align) re-runs only the diff, not the pdf rendering.
//
// The cache owns its buffers: callers always get a CLONE (`cloneRaster`) because
// the buffers handed to the diff worker are transferred (detached).

import type { RasterPage } from "../types";

export const RASTER_CACHE_MAX_ENTRIES = 4;
/** Total bytes (RGBA) kept; the oldest entries are evicted beyond this. */
export const RASTER_CACHE_MAX_BYTES = 200 * 1024 * 1024;

export function cloneRaster(r: RasterPage): RasterPage {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

export function rasterKey(versionId: string, page: number, scale: number, rotation = 0, frame = ""): string {
  return `${versionId}|p${page}|s${scale.toFixed(5)}|r${rotation}${frame ? `|${frame}` : ""}`;
}

export class RasterCache {
  private map = new Map<string, RasterPage>();
  private bytes = 0;

  constructor(
    readonly maxEntries = RASTER_CACHE_MAX_ENTRIES,
    readonly maxBytes = RASTER_CACHE_MAX_BYTES,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Returns a clone (and marks the entry most recently used), or undefined. */
  get(key: string): RasterPage | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return cloneRaster(hit);
  }

  /** Stores a private copy; evicts least recently used entries beyond the limits. */
  set(key: string, raster: RasterPage): void {
    const size = raster.data.byteLength;
    if (size > this.maxBytes) return;
    this.delete(key);
    this.map.set(key, cloneRaster(raster));
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.bytes -= e.data.byteLength;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

export const rasterCache = new RasterCache();

/** Page sizes (pt) per version+page, so a cache hit needs no pdf load at all. */
const sizes = new Map<string, { w: number; h: number }>();
const MAX_SIZES = 64;

export function getCachedSize(versionId: string, page: number): { w: number; h: number } | undefined {
  return sizes.get(`${versionId}|${page}`);
}

export function setCachedSize(versionId: string, page: number, size: { w: number; h: number }): void {
  if (sizes.size >= MAX_SIZES) sizes.delete(sizes.keys().next().value as string);
  sizes.set(`${versionId}|${page}`, size);
}

export function clearRasterCaches(): void {
  rasterCache.clear();
  sizes.clear();
}
