// @vitest-environment node
//
// Wave 62 — the engine side of split tile building (local patch of
// @thatopen/fragments, `SplitTileBuild` / `TileBuildHost` in the worker).
//
//   1. Scheduling: queue, hand-out to helpers (bounded in flight), owner
//      builds within its tick budget, FINISH held while builds are out,
//      helper failure falls back to the owner, dispose.
//   2. Correctness: a tile built by a helper from its descriptor is
//      bit-identical to the owner's own build (positions, normals,
//      indices, item ids, local ids, location, memory); face ids are
//      random per face by design, so their grouping is compared.

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

beforeAll(async () => {
  W = await import(/* @vite-ignore */ workerUrl);
}, 60_000);

function fakeWorker() {
  const sent: Any[] = [];
  return {
    sent,
    terminated: false,
    onmessage: null as null | ((e: { data: Any }) => void),
    onerror: null as null | ((e: Any) => void),
    postMessage(msg: Any) {
      sent.push(msg);
    },
    terminate() {
      this.terminated = true;
    },
  };
}

function fakeTiles(ids: number[]) {
  const tiles = new Map<number, Any>(ids.map((id) => [id, { id, pending: false }]));
  const ownerBuilt: number[] = [];
  const applied: number[] = [];
  return {
    _tiles: tiles,
    _params: { updateTime: 1e9 },
    ownerBuilt,
    applied,
    tileBuildDescriptor: (tile: Any) => ({ id: tile.id }),
    buildNewVirtualTileNow(tile: Any, id: number) {
      tile.pending = false;
      ownerBuilt.push(id);
    },
    applyDetachedBuild(id: number, tile: Any) {
      tile.pending = false;
      applied.push(id);
    },
  };
}

function setup(nTiles: number, nHelpers: number, options: Any = {}) {
  const workers = Array.from({ length: nHelpers }, fakeWorker);
  const split = new W.SplitTileBuild("m", workers, options);
  const ids = Array.from({ length: nTiles }, (_, i) => 100 + i);
  const tiles = fakeTiles(ids);
  split.attach(tiles);
  for (const id of ids) expect(split.enqueue(tiles._tiles.get(id), id)).toBe(true);
  return { split, workers, tiles, ids };
}

const reply = (w: Any, job: number, extra: Any = { result: {} }) =>
  w.onmessage({ data: { ffTileHelper: "built", job, ...extra } });

describe("SplitTileBuild scheduling", () => {
  it("is not created without options, helpers or a big enough model", () => {
    const data = new Uint8Array(1000);
    expect(W.SplitTileBuild.create("m", data, undefined)).toBeNull();
    expect(W.SplitTileBuild.create("m", data, { helpers: 0 })).toBeNull();
    expect(W.SplitTileBuild.create("m", data, { helpers: 2, minBytes: 1001 })).toBeNull();
    // No nested-worker support in this environment -> null, not a throw.
    expect(W.SplitTileBuild.create("m", data, { helpers: 2, minBytes: 10 })).toBeNull();
  });

  it("hands out at most `inflight` builds per helper, the owner builds the rest", () => {
    const { split, workers, tiles } = setup(10, 2, { inflight: 2 });
    expect(split.busy).toBe(true);
    split.dispatch();
    expect(workers.map((w) => w.sent.length)).toEqual([2, 2]);
    // Biggest-first order is kept: the first four go out, in order.
    expect(workers.flatMap((w) => w.sent.map((m: Any) => m.desc.id)).sort()).toEqual([100, 101, 102, 103]);
    split.pump(performance.now());
    expect(tiles.ownerBuilt).toEqual([104, 105, 106, 107, 108, 109]);
    expect(split.busy).toBe(true); // 4 still out on helpers
    for (const w of workers) for (const m of w.sent) reply(w, m.job);
    expect(tiles.applied.sort()).toEqual([100, 101, 102, 103]);
    expect(split.busy).toBe(false);
  });

  it("refills a helper as soon as its build lands", () => {
    const { split, workers } = setup(5, 1, { inflight: 1 });
    split.dispatch();
    expect(workers[0].sent).toHaveLength(1);
    reply(workers[0], workers[0].sent[0].job);
    expect(workers[0].sent).toHaveLength(2);
    expect(workers[0].sent[1].desc.id).toBe(101);
  });

  it("owner builds only within its tick budget", () => {
    const { split, tiles } = setup(3, 1, { inflight: 1 });
    tiles._params.updateTime = 0;
    split.pump(performance.now());
    expect(tiles.ownerBuilt).toEqual([]);
    expect(split.busy).toBe(true);
  });

  it("a failed helper build falls back to the owner and retires the helper", () => {
    const { split, workers, tiles } = setup(4, 2, { inflight: 2 });
    split.dispatch();
    const [a, b] = workers;
    const failed = a.sent[0];
    reply(a, failed.job, { error: "boom" });
    expect(a.terminated).toBe(true);
    // The failed tile and the dead helper's other job are built on the owner.
    expect(tiles.ownerBuilt).toContain(failed.desc.id);
    split.pump(performance.now());
    expect(tiles.ownerBuilt.sort()).toEqual(a.sent.map((m: Any) => m.desc.id).sort());
    for (const m of b.sent) reply(b, m.job);
    expect(split.busy).toBe(false);
  });

  it("a crashed helper's jobs go back to the front of the queue", () => {
    const { split, workers, tiles } = setup(6, 2, { inflight: 1 });
    split.dispatch();
    workers[0].onerror!({ message: "crash" });
    expect(workers[0].terminated).toBe(true);
    tiles._params.updateTime = 1e9;
    split.pump(performance.now());
    expect(tiles.ownerBuilt[0]).toBe(workers[0].sent[0].desc.id);
  });

  it("stops after dispose (enqueue declines, late results are ignored)", () => {
    const { split, workers, tiles } = setup(2, 1, { inflight: 2 });
    split.dispatch();
    split.dispose();
    expect(workers[0].terminated).toBe(true);
    expect(split.enqueue({ pending: false }, 1)).toBe(false);
    reply(workers[0], workers[0].sent[0].job);
    expect(tiles.applied).toEqual([]);
  });
});

/** Same faces grouped together (face ids are Math.random() per face). */
function sameFaces(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const f = new Map<string, string>();
  const g = new Map<string, string>();
  for (let i = 0; i < a.length; i += 3) {
    const ka = `${a[i]},${a[i + 1]},${a[i + 2]}`;
    const kb = `${b[i]},${b[i + 1]},${b[i + 2]}`;
    if ((f.get(ka) ?? kb) !== kb || (g.get(kb) ?? ka) !== ka) return false;
    f.set(ka, kb);
    g.set(kb, ka);
  }
  return true;
}

function bytesOf(a: Any): number[] | null {
  return a ? Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) : null;
}

describe("helper-built tiles are identical to owner-built tiles", () => {
  it("on the sample IFC (every tile, both LODs)", async () => {
    // The suite's setup mocks @thatopen/fragments; the importer must be real.
    const FRAGS: Any = await vi.importActual("@thatopen/fragments");
    const ifc = path.resolve(__dirname, "../../../../apps/settings/public/samples/sample.ifc");
    const importer = new FRAGS.IfcImporter();
    importer.wasm.path = path.dirname(require_.resolve("web-ifc")) + path.sep;
    importer.wasm.absolute = true;
    const frag: Uint8Array = await importer.process({ bytes: new Uint8Array(fs.readFileSync(ifc)), raw: true });

    const owner = new W.VirtualFragmentsModel("owner", frag.slice(), undefined, {});
    await owner.setupData(() => undefined, () => undefined);
    // A different model id = a separate geometry cache, as in a real helper.
    W.TileBuildHost.handle({ ffTileHelper: "init", modelId: "helper", data: frag.slice().buffer });
    const helper = W.TileBuildHost._models.get("helper");
    expect(helper).toBeInstanceOf(Object);

    let checked = 0;
    for (const [, tile] of owner.tiles._tiles) {
      const desc = structuredClone(owner.tiles.tileBuildDescriptor(tile));
      const r = helper.buildDetached(desc);
      owner.tiles.constructTile(tile);
      const faceIds = owner.tiles.getFaceIds(tile);
      const localIds = owner.tiles.getTileLocalIds(tile);
      expect(bytesOf(r.positions)).toEqual(bytesOf(tile.positionBuffer));
      expect(bytesOf(r.normals)).toEqual(bytesOf(tile.normalBuffer));
      expect(bytesOf(r.indices)).toEqual(bytesOf(tile.indexBuffer));
      expect(bytesOf(r.ids)).toEqual(bytesOf(tile.ids));
      expect(Array.from(r.localIds)).toEqual(Array.from(localIds));
      expect(r.usedMemory).toBe(tile.usedMemory);
      expect(r.location).toEqual(tile.location ? [tile.location.x, tile.location.y, tile.location.z] : null);
      expect(sameFaces(r.faceIds, faceIds)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  }, 120_000);
});
