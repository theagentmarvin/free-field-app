// @vitest-environment node
//
// Wave 62 — the engine side of the tile cache (local patch of
// @thatopen/fragments, `TileCache` in the worker): built tiles are stored
// in IndexedDB and a later load of the same model bytes restores them
// instead of rebuilding. Checked on a real model (the sample IFC):
//   - a warm load restores EVERY tile, bit-identical to the cold build
//     (positions, normals, indices, item ids, local ids, face ids, box,
//     location, memory);
//   - a different key, a changed layout or a missing store all fall back
//     to building; old models are evicted.

import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const fragsDist = path.dirname(require_.resolve("@thatopen/fragments"));
const workerUrl = pathToFileURL(path.join(fragsDist, "Worker", "worker.mjs")).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let W: Any;
let frag: Uint8Array;

beforeAll(async () => {
  W = await import(/* @vite-ignore */ workerUrl);
  // The suite's setup mocks @thatopen/fragments; the importer must be real.
  const FRAGS: Any = await vi.importActual("@thatopen/fragments");
  const importer = new FRAGS.IfcImporter();
  importer.wasm.path = path.dirname(require_.resolve("web-ifc")) + path.sep;
  importer.wasm.absolute = true;
  const ifc = path.resolve(__dirname, "../../../../apps/settings/public/samples/sample.ifc");
  frag = await importer.process({ bytes: new Uint8Array(fs.readFileSync(ifc)), raw: true });
}, 120_000);

const until = async (cond: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Captured {
  positions: number[];
  normals: number[] | null;
  indices: number[] | null;
  ids: number[] | null;
  faceIds: number[];
  localIds: number[];
  usedMemory: number;
  location: number[];
  box: number[];
}

const bytes = (a: Any): number[] | null =>
  a ? Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) : null;

/** A model with a tile cache; every loadTile (= what goes to the main thread) is captured. */
async function openModel(id: string, cache: Any) {
  const model = new W.VirtualFragmentsModel(id, frag.slice(), undefined, { tileCache: cache });
  await model.setupData(() => undefined, () => undefined);
  const tiles = model.tiles;
  const captured = new Map<number, Captured>();
  const loadTile = tiles.loadTile.bind(tiles);
  tiles.loadTile = (tileId: number, tile: Any, pre: Any) => {
    captured.set(tileId, {
      positions: bytes(tile.positionBuffer)!,
      normals: bytes(tile.normalBuffer),
      indices: bytes(tile.indexBuffer),
      ids: bytes(tile.ids),
      faceIds: bytes(pre ? pre.faceIds : tiles.getFaceIds(tile))!,
      localIds: Array.from(pre ? pre.localIds : tiles.getTileLocalIds(tile)),
      usedMemory: tile.usedMemory,
      location: tile.location.toArray(),
      box: [...tile.box.min.toArray(), ...tile.box.max.toArray()],
    });
    return loadTile(tileId, tile, pre);
  };
  const applied = vi.spyOn(tiles, "applyDetachedBuild");
  const built = vi.spyOn(tiles, "buildNewVirtualTileNow");
  return { model, tiles, captured, applied, built, cache: tiles._tileCache };
}

/** Request every tile, as the view sweep would, until none is left waiting. */
async function buildAll(m: Any) {
  for (const [tileId, tile] of m.tiles._tiles) m.tiles.buildNewVirtualTile(tile, tileId);
  await until(() => {
    m.cache.pump(performance.now());
    return !m.cache.busy;
  });
}

/** Mark the view drawn and let the cache write everything it queued. */
async function flushWrites(m: Any) {
  m.tiles.tilesUpdated = true;
  await until(() => {
    m.cache.pump(performance.now());
    return m.cache._writes.length === 0 && !m.cache._writing;
  });
}

describe("tile cache", () => {
  it("is off without a key, an IndexedDB or a big enough model", () => {
    expect(W.TileCache.create(frag, undefined)).toBeNull();
    expect(W.TileCache.create(frag, { key: "" })).toBeNull();
    expect(W.TileCache.create(frag, { key: "k", minBytes: frag.byteLength + 1 })).toBeNull();
    const idb = globalThis.indexedDB;
    try {
      // @ts-expect-error -- simulate a worker without IndexedDB
      delete globalThis.indexedDB;
      expect(W.TileCache.create(frag, { key: "k" })).toBeNull();
    } finally {
      globalThis.indexedDB = idb;
    }
  });

  it("fingerprints content, not just length", () => {
    const a = frag.slice();
    const b = frag.slice();
    b[b.length - 1] ^= 0xff;
    expect(W.TileCache.fingerprint(a)).toBe(W.TileCache.fingerprint(frag));
    expect(W.TileCache.fingerprint(b)).not.toBe(W.TileCache.fingerprint(a));
  });

  it("restores every tile on a warm load, identical to the cold build", async () => {
    const opts = { key: "file-1|v1", minBytes: 0, maxModels: 4 };
    const cold = await openModel("cold", opts);
    await until(() => cold.cache._state !== "meta");
    await buildAll(cold);
    const n = cold.tiles._tiles.size;
    expect(n).toBeGreaterThan(5);
    expect(cold.built).toHaveBeenCalledTimes(n);
    expect(cold.applied).not.toHaveBeenCalled();
    // Nothing is written before the view is drawn.
    expect(cold.cache._writes.length).toBe(n);
    await flushWrites(cold);
    cold.model.dispose();

    const warm = await openModel("warm", opts);
    // Tiles requested while the store is still being read wait for it.
    await buildAll(warm);
    expect(warm.built).not.toHaveBeenCalled();
    expect(warm.applied).toHaveBeenCalledTimes(n);
    expect([...warm.captured.keys()].sort()).toEqual([...cold.captured.keys()].sort());
    for (const [tileId, c] of cold.captured) {
      expect(warm.captured.get(tileId)).toEqual(c);
    }
    // Restored tiles are not written again.
    expect(warm.cache._writes.length).toBe(0);
    warm.model.dispose();
  }, 60_000);

  it("misses (and builds) on another key or a changed tile layout", async () => {
    const other = await openModel("other", { key: "file-1|v2", minBytes: 0 });
    await buildAll(other);
    expect(other.applied).not.toHaveBeenCalled();
    other.model.dispose();

    const warm = await openModel("warm2", { key: "file-1|v1", minBytes: 0 });
    await until(() => warm.cache._state === "ready");
    const [firstId, firstTile] = warm.tiles._tiles.entries().next().value;
    firstTile.positionCount += 3; // layout no longer matches the record
    warm.tiles.buildNewVirtualTile(firstTile, firstId);
    expect(warm.applied).not.toHaveBeenCalled();
    expect(warm.built).toHaveBeenCalledTimes(1);
    warm.model.dispose();
  }, 60_000);

  it("keeps only the most recently used models", async () => {
    const keep = await openModel("evict", { key: "file-2|v1", minBytes: 0, maxModels: 1 });
    await until(() => keep.cache._state === "ready");
    keep.model.dispose();
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open(W.TileCache.DB_NAME);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const count = (store: string): Promise<number> =>
      new Promise((res) => {
        const r = db.transaction(store).objectStore(store).count();
        r.onsuccess = () => res(r.result);
      });
    expect(await count("models")).toBe(0);
    expect(await count("tiles")).toBe(0);
    db.close();
  }, 60_000);
});
