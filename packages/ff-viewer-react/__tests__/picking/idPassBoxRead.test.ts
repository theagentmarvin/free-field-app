// __tests__/picking/idPassBoxRead.test.ts
//
// Wave 28 — the single bounding-box readback. One `gl.readPixels` over
// the probe area replaces 33 individual 1×1 sync-stalling reads, so the
// pixel math is now load-bearing: if the box lands one pixel off, the
// wrong element gets picked and a task anchor gets persisted to
// Firestore at the wrong place. Two things are pinned here:
//
//   1. Equivalence — the box path and the per-probe path must decode the
//      IDENTICAL hit for the SAME synthetic id buffer, including probes
//      clamped at the viewport edges and probes on opposite sides of it.
//   2. The self-check — when the two paths disagree (a future TOE whose
//      private readback uses a different coordinate space), the reader
//      must fall back to per-probe reads and stay correct, not pick
//      whatever the box happened to contain.

import { describe, expect, it } from "vitest";

import { detectIdPassInterop } from "../../src/picking/idPassInterop";
import { idPassProbes } from "../../src/picking/pickSeam";

const SIZE = { x: 100, y: 50 };

/** Encode a pick pixel: model byte in R, low-24 of (itemId+1) in GBA. */
function pixel(modelByte: number, itemId: number): Uint8Array {
  const encoded = itemId + 1;
  return new Uint8Array([
    modelByte,
    (encoded >> 16) & 0xff,
    (encoded >> 8) & 0xff,
    encoded & 0xff,
  ]);
}

/** TOE's own readPixelAt math (`components/dist/index.mjs:13036–13053`). */
function toePixel(ndc: { x: number; y: number }): { x: number; y: number } {
  const x = Math.floor((ndc.x + 1) * 0.5 * SIZE.x);
  const y = Math.floor((ndc.y + 1) * 0.5 * (SIZE.y - 1));
  return {
    x: Math.max(0, Math.min(SIZE.x - 1, x)),
    y: Math.max(0, Math.min(SIZE.y - 1, y)),
  };
}

interface SyntheticScene {
  /** pixel coords → model byte, 0 = void. */
  modelAt: (x: number, y: number) => number;
  /** pixel coords → item id encoded in the buffer. */
  itemAt: (x: number, y: number) => number;
}

/**
 * Build a picker whose renderer serves the id buffer from `scene`.
 * `boxCapability: false` models a TOE whose renderer does not expose the
 * region readback, which must degrade to per-probe `readPixelAt`.
 */
function makeSyntheticPicker(
  scene: SyntheticScene,
  opts: { boxCapability?: boolean; corruptBox?: boolean } = {},
) {
  const counts = { renders: 0, boxReads: 0, pixelReads: 0 };
  const readRegion = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    buf: Uint8Array,
  ) => {
    counts.boxReads += 1;
    for (let row = 0; row < h; row += 1) {
      for (let col = 0; col < w; col += 1) {
        const o = (row * w + col) * 4;
        // `corruptBox` simulates a coordinate-space drift: the region
        // read returns the buffer SHIFTED by one pixel, so it can no
        // longer agree with readPixelAt.
        const sx = opts.corruptBox ? x0 + col + 1 : x0 + col;
        buf[o] = scene.modelAt(sx, y0 + row);
        const item = scene.itemAt(sx, y0 + row);
        buf[o + 1] = (item + 1) >> 16;
        buf[o + 2] = ((item + 1) >> 8) & 0xff;
        buf[o + 3] = (item + 1) & 0xff;
      }
    }
  };

  const renderer: Record<string, unknown> = {
    clippingPlanes: [],
    getRenderTarget: () => ({}),
    autoClear: true,
    getClearColor: (c: unknown) => c,
    getClearAlpha: () => 1,
    getScissorTest: () => false,
    getScissor: (v: unknown) => v,
    setRenderTarget: () => undefined,
    setClearColor: () => undefined,
    clear: () => undefined,
    setScissorTest: () => undefined,
    setScissor: () => undefined,
    render: () => {
      counts.renders += 1;
    },
  };
  if (opts.boxCapability !== false) {
    renderer.readRenderTargetPixels = (
      _t: unknown,
      x: number,
      y: number,
      w: number,
      h: number,
      buf: Uint8Array,
    ) => readRegion(x, y, w, h, buf);
  }

  const modelObject = { visible: true, isMesh: true };
  const fragments = {
    initialized: true,
    list: new Map<string, unknown>([
      [
        "m-1",
        {
          object: modelObject,
          getLocalIdsFromItemIds: async (ids: Iterable<number>) =>
            [...ids].map((id) => id + 5000),
        },
      ],
    ]),
  };

  const picker = {
    enabled: true,
    world: {
      renderer: { three: renderer },
      scene: { three: { traverse: () => undefined } },
      camera: { three: {} },
    },
    components: { get: () => fragments },
    _renderTarget: { width: SIZE.x, height: SIZE.y },
    _renderTargetSize: { ...SIZE },
    _idMaterial: { uniforms: { modelByte: { value: 0 } } },
    applyIdMaterial: () => new Map<number, string>([[1, "m-1"]]),
    restoreOriginalMaterials: () => undefined,
    readPixelAt(this: Record<string, unknown>, _target: unknown, ndc?: { x: number; y: number }) {
      if (!this || !this.world) {
        throw new TypeError("Cannot read properties of undefined (reading 'world')");
      }
      counts.pixelReads += 1;
      const p = toePixel(ndc ?? { x: 0, y: 0 });
      const model = scene.modelAt(p.x, p.y);
      if (model === 0) return new Uint8Array([0, 0, 0, 0]);
      return pixel(model, scene.itemAt(p.x, p.y));
    },
  } as unknown as Record<string, unknown>;

  return { picker, counts };
}

describe("bounding-box readback ≡ per-probe readback", () => {
  it("decodes the same hit from a one-pixel target", async () => {
    // Only ONE pixel of the whole frame belongs to an element: the exact
    // click. Anything that reads the wrong box lands on void.
    const spot = toePixel({ x: 0.34, y: -0.21 });
    const scene: SyntheticScene = {
      modelAt: (x, y) => (x === spot.x && y === spot.y ? 1 : 0),
      itemAt: () => 77,
    };
    const probes = idPassProbes({ x: 0.34, y: -0.21 }, SIZE);

    const boxed = makeSyntheticPicker(scene);
    const boxedReader = detectIdPassInterop(boxed.picker).reader!;
    const perProbe = makeSyntheticPicker(scene, { boxCapability: false });
    const perProbeReader = detectIdPassInterop(perProbe.picker).reader!;

    const a = await boxedReader.read(probes);
    const b = await perProbeReader.read(probes);

    expect(a.items).toEqual(b.items);
    expect(a.items[0]).toEqual({ modelId: "m-1", localId: 5077 });
    expect(a.inconclusive).toBe(false);
    // The whole point of the wave: one readback, not 33.
    expect(boxed.counts.boxReads).toBe(1);
    expect(a.stats.readbacks).toBe(2); // box + the one-time verification
    expect(a.stats.boxRead).toBe(true);
    expect(perProbe.counts.boxReads).toBe(0);
    expect(perProbe.counts.pixelReads).toBe(33);
    expect(perProbeReader.lastStats?.boxRead).toBe(false);
  });

  it("keeps first-probe-wins order when two probes hit different items", async () => {
    const probes = idPassProbes({ x: 0, y: 0 }, SIZE);
    const p0 = toePixel(probes[0]);
    const p5 = toePixel(probes[5]);
    const scene: SyntheticScene = {
      modelAt: (x, y) =>
        (x === p0.x && y === p0.y) || (x === p5.x && y === p5.y) ? 1 : 0,
      itemAt: (x, y) => (x === p5.x && y === p5.y ? 200 : 100),
    };
    const boxed = makeSyntheticPicker(scene);
    const res = await detectIdPassInterop(boxed.picker).reader!.read(probes);

    // Scan order decides, and only the winner is translated.
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 5100 });
    expect(res.items.slice(1).every((i) => i === null)).toBe(true);
    expect(res.stats.rpcs).toBe(1);
  });

  it("reads the union box when probes sit on opposite sides of the frame", async () => {
    // Extreme NDC ⇒ clamped pixels at both edges: the region must span
    // them and still index each probe correctly.
    const probes = [
      { x: -2, y: -2 }, // clamps to (0,0)
      { x: 2, y: 2 }, // clamps to (size-1, size-1)
      { x: 0, y: 0 },
    ];
    const mid = toePixel(probes[2]);
    const scene: SyntheticScene = {
      modelAt: (x, y) => (x === mid.x && y === mid.y ? 1 : 0),
      itemAt: () => 42,
    };
    const { picker, counts } = makeSyntheticPicker(scene);
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read(probes);

    expect(res.items[2]).toEqual({ modelId: "m-1", localId: 5042 });
    expect(res.items[0]).toBeNull();
    expect(res.items[1]).toBeNull();
    expect(counts.boxReads).toBe(1);
    // One region read for three probes scattered across the frame, plus
    // the one-time verification against TOE's own readback.
    expect(reader.lastStats?.probes).toBe(3);
    expect(reader.lastStats?.readbacks).toBe(2);
    expect(reader.lastStats?.boxRead).toBe(true);
  });

  it("falls back to per-probe reads when the box disagrees — and stays correct", async () => {
    const spot = toePixel({ x: -0.4, y: 0.25 });
    const scene: SyntheticScene = {
      modelAt: (x, y) => (x === spot.x && y === spot.y ? 1 : 0),
      itemAt: () => 9,
    };
    const { picker } = makeSyntheticPicker(scene, { corruptBox: true });
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes({ x: -0.4, y: 0.25 }, SIZE);

    const res = await reader.read(probes);
    // The drifted box must never decide the selection: the verified
    // per-probe path still finds the element at the exact click.
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 5009 });
    expect(res.stats.boxRead).toBe(false);

    // …and the box path is now disabled for good (one readback per read,
    // never two).
    const again = await reader.read(probes);
    expect(again.stats.boxRead).toBe(false);
    expect(again.items[0]).toEqual({ modelId: "m-1", localId: 5009 });
  });

  it("an unverified box is never believed when it claims empty space", async () => {
    // The silent-corruption case the wave-28 review caught: a box that
    // lands a pixel off reads VOID where an element is. An empty result
    // reported as confirmed empty space would clear a live selection,
    // and there would be no hit to compare against — so nothing would
    // ever prove the mapping wrong. While the box is on probation an
    // empty scan is therefore re-read authoritatively.
    const scene: SyntheticScene = { modelAt: () => 0, itemAt: () => 0 };
    const { picker, counts } = makeSyntheticPicker(scene);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes({ x: 0.1, y: 0.1 }, SIZE);

    const empty = await reader.read(probes);
    expect(empty.items.every((i) => i === null)).toBe(true);
    expect(empty.inconclusive).toBe(false);
    // Probation costs the old read count on a void click…
    expect(empty.stats.boxRead).toBe(false);
    expect(counts.boxReads).toBe(1);
    expect(counts.pixelReads).toBe(33);
  });

  it("stays on probation while every compared pixel is void", async () => {
    // Wave-28 review M2: agreement on void proves nothing (cleared memory
    // equals cleared memory), so the box must never be promoted to
    // trusted without a HIT comparison. Click into empty space forever
    // and every read keeps paying the authoritative per-probe scan.
    const spot = toePixel({ x: 0.9, y: 0.9 });
    const scene: SyntheticScene = {
      modelAt: (x, y) => (x === spot.x && y === spot.y ? 1 : 0),
      itemAt: () => 5,
    };
    const probes = idPassProbes({ x: -0.9, y: -0.9 }, SIZE);
    const { picker, counts } = makeSyntheticPicker(scene);
    const reader = detectIdPassInterop(picker).reader!;

    for (let i = 0; i < 3; i += 1) {
      const res = await reader.read(probes);
      expect(res.items.every((it) => it === null)).toBe(true);
      expect(res.inconclusive).toBe(false);
      expect(res.stats.boxRead).toBe(false); // never promoted on void
    }
    expect(counts.boxReads).toBe(3);
    expect(counts.pixelReads).toBe(99); // 3 × 33 authoritative reads
  });

  it("pays ONE readback per click once the box is verified", async () => {
    const spotX = toePixel({ x: 0.1, y: 0.1 }).x;
    const hit: SyntheticScene = {
      modelAt: (x) => (x === spotX ? 1 : 0),
      itemAt: () => 3,
    };
    const { picker, counts } = makeSyntheticPicker(hit);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes({ x: 0.1, y: 0.1 }, SIZE);

    // Read 1: box + the verification on a pixel that decoded a hit.
    const first = await reader.read(probes);
    expect(first.stats.boxRead).toBe(true);
    expect(first.stats.readbacks).toBe(2);
    expect(first.items[0]).toEqual({ modelId: "m-1", localId: 5003 });

    // Read 2 onward: the mapping is proven — one readback, period.
    const second = await reader.read(probes);
    expect(second.stats.readbacks).toBe(1);
    expect(second.stats.rpcs).toBe(0); // and the cache covers the RPC too
    expect(counts.boxReads).toBe(2);
    expect(counts.pixelReads).toBe(1); // verification, once, ever

    // A resize re-arms probation: the mapping proven at the old size is
    // not the mapping at the new one.
    (picker._renderTargetSize as AnyObject).x = 120;
    const afterResize = await reader.read(probes);
    expect(afterResize.stats.readbacks).toBeGreaterThan(1);
  });
});
