// __tests__/picking/idPassInterop.test.ts
//
// Wave 25 — the TOE-interop boundary seam. Two things are pinned here:
//
//   1. Runtime shape detection: `detectIdPassInterop` returns `batched`
//      only when every private FastModelPicker id-pass internal is
//      present, and `unavailable` (never throwing) when any of them is
//      missing — so a TOE upgrade that renames `_renderTarget` /
//      `applyIdMaterial` / `readPixelAt` silently returns the caller to
//      the per-probe `getItemAt` fallback.
//   2. The batched read renders ONCE (the render counter) and decodes
//      each probe from that single target, resolving `itemId → localId`
//      the same way `getItemAt` does.

import { describe, expect, it, vi } from "vitest";

import {
  detectIdPassInterop,
  LOCAL_ID_BUDGET_MS,
} from "../../src/picking/idPassInterop";

// The internals shape is not exported; build the mock as `any`-free
// structural objects and cast once at the call site.
type AnyObject = Record<string, unknown>;

function makePickPixel(modelByte: number, low24: number): Uint8Array {
  return new Uint8Array([
    modelByte,
    (low24 >> 16) & 0xff,
    (low24 >> 8) & 0xff,
    low24 & 0xff,
  ]);
}

interface MockOpts {
  /** Omit a private member to simulate a TOE upgrade drift. */
  omit?: "renderTarget" | "renderTargetSize" | "idMaterial" | "applyIdMaterial" | "restore" | "readPixelAt" | "world" | "components";
  /** When true, `enabled` is false (TOE's own guard). */
  disabled?: boolean;
  /** Pixels `readPixelAt` returns for every probe. Default: void (all miss). */
  pixels?: Uint8Array;
  /** itemId → localId mapping for the mocked fragments model. */
  localIdOf?: (itemId: number) => number | null;
}

function makePicker(opts: MockOpts = {}): {
  picker: AnyObject;
  renders: { count: number };
  restores: { count: number };
} {
  const renders = { count: 0 };
  const restores = { count: 0 };
  const modelObject = { visible: true, isMesh: true };

  const renderer = {
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
    render: (_scene: unknown, _camera: unknown) => {
      renders.count += 1;
    },
  };
  const scene = {
    traverse: (cb: (c: unknown) => void) => {
      // No stray non-BIM children in this mock.
      void cb;
    },
  };
  const camera = { position: { x: 0, y: 0, z: 10 } };

  const fragments = {
    initialized: true,
    list: new Map<string, { object: unknown }>([["m-1", { object: modelObject }]]),
  };
  const components = {
    get: () => fragments,
  };

  const picker: AnyObject = {
    enabled: opts.disabled ? false : true,
    world: {
      renderer: { three: renderer },
      scene: { three: scene },
      camera: { three: camera },
    },
    components,
    _renderTarget: { width: 100, height: 50 },
    _renderTargetSize: { x: 100, y: 50 },
    _idMaterial: {
      clipping: false,
      clippingPlanes: [],
      uniforms: { modelByte: { value: 0 } },
    },
    applyIdMaterial: () => new Map<number, string>([[1, "m-1"]]),
    restoreOriginalMaterials: () => {
      restores.count += 1;
    },
    // WAVE-25b LIVE CONTRACT: the real TOE readPixelAt dereferences
    // `this.world` — it crashed unbound calls on-device (every click)
    // while this suite stayed green, because a receiver-agnostic arrow
    // mock cannot express the bug. The mock now behaves like the real
    // private: an extracted, unbound call MUST throw. Regression guard.
    readPixelAt(this: AnyObject, _target: unknown, _ndc?: unknown) {
      if (!this || !this.world) {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'world')",
        );
      }
      return opts.pixels ?? makePickPixel(0, 0);
    },
  };

  if (opts.omit === "renderTarget") delete picker._renderTarget;
  if (opts.omit === "renderTargetSize") delete picker._renderTargetSize;
  if (opts.omit === "idMaterial") delete picker._idMaterial;
  if (opts.omit === "applyIdMaterial") delete picker.applyIdMaterial;
  if (opts.omit === "restore") delete picker.restoreOriginalMaterials;
  if (opts.omit === "readPixelAt") delete picker.readPixelAt;
  if (opts.omit === "world") delete picker.world;
  if (opts.omit === "components") delete picker.components;

  return { picker, renders, restores };
}

// localId resolver override is applied by re-assigning components.get
// per-test — see the hit test below.

describe("detectIdPassInterop (runtime shape detection)", () => {
  it("returns unavailable (no throw) for null/undefined pickers", () => {
    expect(detectIdPassInterop(null)).toEqual({
      mode: "unavailable",
      reader: null,
    });
    expect(detectIdPassInterop(undefined)).toEqual({
      mode: "unavailable",
      reader: null,
    });
  });

  it("returns unavailable for an empty object", () => {
    expect(detectIdPassInterop({}).mode).toBe("unavailable");
  });

  it("returns batched when every private internal is present", () => {
    const { picker } = makePicker();
    const interop = detectIdPassInterop(picker);
    expect(interop.mode).toBe("batched");
    expect(interop.reader).not.toBeNull();
  });

  it.each<MockOpts["omit"]>([
    "renderTarget",
    "renderTargetSize",
    "idMaterial",
    "applyIdMaterial",
    "restore",
    "readPixelAt",
    "world",
    "components",
  ])("degrades to unavailable when %s is missing", (omit) => {
    const { picker } = makePicker({ omit });
    expect(detectIdPassInterop(picker)).toEqual({
      mode: "unavailable",
      reader: null,
    });
  });
});

describe("BatchedIdPassReader", () => {
  it("a full miss renders exactly once and returns all-nulls", async () => {
    const { picker, renders, restores } = makePicker();
    const interop = detectIdPassInterop(picker);
    expect(interop.reader).not.toBeNull();
    const reader = interop.reader!;

    const ndcs = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));
    const res = await reader.read(ndcs);

    expect(res.items).toHaveLength(33);
    expect(res.items.every((r) => r === null)).toBe(true);
    // Wave 28: an all-void scan is a CONFIRMED miss, never an unknown.
    expect(res.inconclusive).toBe(false);
    // The render counter: ONE read = ONE id pass, regardless of 33 probes.
    expect(reader.totalRenders).toBe(1);
    // The render loop renders once per model (mock has one model).
    expect(renders.count).toBe(1);
    // Materials are restored after the single render.
    expect(restores.count).toBe(1);
  });

  it("decodes a hit and resolves itemId → localId exactly once", async () => {
    const localIdOf = vi.fn((itemId: number) => itemId + 1000);
    const { picker } = makePicker({
      // modelByte = 1 (→ "m-1"), low24 = 8 → itemId = 7.
      pixels: makePickPixel(1, 8),
    });
    // Replace the fragments model's resolver.
    (picker.components as AnyObject).get = () => ({
      initialized: true,
      list: new Map<string, { object: unknown; getLocalIdsFromItemIds: unknown }>([
        [
          "m-1",
          {
            object: { visible: true, isMesh: true },
            getLocalIdsFromItemIds: async (ids: Iterable<number>) =>
              [...ids].map((id) => localIdOf(id)),
          },
        ],
      ]),
    });

    const interop = detectIdPassInterop(picker);
    const reader = interop.reader!;
    const res = await reader.read([{ x: 0, y: 0 }]);

    expect(res.items).toEqual([{ modelId: "m-1", localId: 1007 }]);
    expect(res.inconclusive).toBe(false);
    expect(reader.totalRenders).toBe(1);
    expect(localIdOf).toHaveBeenCalledTimes(1);
    expect(localIdOf).toHaveBeenCalledWith(7);
  });

  it("misses silently when the picker is disabled (TOE guard)", async () => {
    const { picker } = makePicker({ disabled: true });
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read([{ x: 0, y: 0 }]);
    expect(res.items).toEqual([null]);
    expect(reader.totalRenders).toBe(0); // no render was attempted
  });
});

// ── Wave 28: the per-click cost collapse ─────────────────────────
// One click on an element that fills its tolerance neighbourhood used
// to pay 33 fragments-worker round-trips (one per probe, all but the
// first thrown away) plus 33 synchronous `gl.readPixels` stalls. These
// are the counters that must never regress: the field complaint is
// "click → highlight lands too slowly", and both numbers are pure
// per-click latency on the device profile that matters (Intel HD 620,
// 4 cores → the fragments pool floors at 2 workers, so an RPC's cost is
// its position in a busy queue, not the lookup itself).

describe("BatchedIdPassReader — wave 28 cost contract", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * A picker whose id buffer reads the SAME element at every pixel.
   *
   * The fragments object is built ONCE, deliberately: the reader's cache
   * invalidation keys on model INSTANCE identity (a same-id reload must
   // not serve a stale express id), so a mock whose `components.get()`
   * returned a fresh object per call would never hit the cache and the
   * test would be measuring the mock, not the code.
   */
  function solidPicker(
    rpcMs: number,
    localIdOf = vi.fn((itemId: number) => itemId + 1000),
  ) {
    const made = makePicker({ pixels: makePickPixel(1, 8) });
    const model = {
      object: { visible: true, isMesh: true },
      getLocalIdsFromItemIds: async (ids: Iterable<number>) => {
        if (rpcMs) await sleep(rpcMs);
        return [...ids].map((id) => localIdOf(id));
      },
    };
    const fragments = {
      initialized: true,
      list: new Map<string, unknown>([["m-1", model]]),
    };
    (made.picker.components as AnyObject).get = () => fragments;
    return { ...made, localIdOf, model, fragments };
  }

  const PROBES = Array.from({ length: 33 }, () => ({ x: 0, y: 0 }));

  // `makePickPixel(1, 8)` ⇒ modelByte 1 ("m-1"), encoded 8 ⇒ itemId 7,
  // and the mock resolver maps 7 → 1007.

  it("a solid-element 33-probe click pays ONE worker round-trip", async () => {
    const { picker, localIdOf } = solidPicker(15);
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read(PROBES);

    expect(localIdOf).toHaveBeenCalledTimes(1);
    expect(res.stats.rpcs).toBe(1);
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
    // Everything after the first resolved probe is deliberately unresolved.
    expect(res.items.slice(1).every((i) => i === null)).toBe(true);
    expect(res.stats.rawHits).toBe(33);
    expect(res.inconclusive).toBe(false);
  });

  it("the second identical click pays ZERO round-trips (cache)", async () => {
    const { picker, localIdOf } = solidPicker(15);
    const reader = detectIdPassInterop(picker).reader!;

    await reader.read(PROBES);
    const again = await reader.read(PROBES);

    expect(localIdOf).toHaveBeenCalledTimes(1); // still, from the first read
    expect(again.stats.rpcs).toBe(0);
    expect(again.stats.cacheHits).toBe(1);
    expect(again.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
  });

  it("a reload under the same modelId never serves a cached express id", async () => {
    // The bucket is tagged with the model instance it was learned from:
    // presence in `FragmentsManager.list` is NOT enough, or a reload
    // with a changed layout would tint one element and anchor a task at
    // another.
    const { picker, fragments } = solidPicker(0);
    const reader = detectIdPassInterop(picker).reader!;
    await reader.read(PROBES);

    const reloaded = {
      object: { visible: true, isMesh: true },
      getLocalIdsFromItemIds: vi.fn(async (ids: Iterable<number>) =>
        [...ids].map((id) => id + 2000),
      ),
    };
    fragments.list.set("m-1", reloaded);

    const res = await reader.read(PROBES);
    expect(reloaded.getLocalIdsFromItemIds).toHaveBeenCalledTimes(1);
    expect(res.stats.cacheHits).toBe(0);
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 2007 });
  });

  it("a 15 ms worker no longer means a ~500 ms click", async () => {
    const { picker } = solidPicker(15);
    const reader = detectIdPassInterop(picker).reader!;
    const t0 = performance.now();
    await reader.read(PROBES);
    const ms = performance.now() - t0;
    // Pre-wave-28 this was 33 serialized round-trips ≈ 495 ms (measured
    // 506 ms in the wave-28 diagnostic). One round-trip is ~15 ms.
    expect(ms).toBeLessThan(100);
  });

  it("a wedged worker yields INCONCLUSIVE inside the budget, not forever", async () => {
    // `threads.invoke` has no timeout and nothing rejects it on
    // terminate/dispose, so an unsettled translation must never be
    // reported as empty space — that would clear a real selection.
    vi.useFakeTimers();
    try {
      const { picker, fragments } = solidPicker(0);
      fragments.list.set("m-1", {
        object: { visible: true },
        getLocalIdsFromItemIds: () => new Promise(() => undefined),
      });
      const reader = detectIdPassInterop(picker).reader!;
      const pending = reader.read(PROBES);
      await vi.advanceTimersByTimeAsync(LOCAL_ID_BUDGET_MS + 50);
      const res = await pending;

      expect(res.inconclusive).toBe(true);
      expect(res.items.every((i) => i === null)).toBe(true);
      expect(res.stats.translateTimeouts).toBe(1);
      expect(res.stats.rawHits).toBe(33); // it DID hit an element
    } finally {
      vi.useRealTimers();
    }
  });

  it("a REJECTED translation is UNKNOWN, never empty space", async () => {
    // Not theoretical: `ConnectionHandlers.newHandler` rejects the
    // moment the worker returns `errorInfo` (an alive-but-erroring
    // decoder), which is strictly more likely than a wedge. Treating it
    // as a miss would clear a real selection.
    const { picker, fragments } = solidPicker(0);
    fragments.list.set("m-1", {
      object: { visible: true },
      getLocalIdsFromItemIds: () => Promise.reject(new Error("web-ifc blew up")),
    });
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read(PROBES);

    expect(res.inconclusive).toBe(true);
    expect(res.items.every((i) => i === null)).toBe(true);
  });

  it("a live model answering “no express id for this item” is a real miss", async () => {
    // The one translation failure allowed to end as empty space — LOD
    // filler geometry, wave-25 parity.
    const { picker, fragments } = solidPicker(0);
    fragments.list.set("m-1", {
      object: { visible: true },
      getLocalIdsFromItemIds: async () => [],
    });
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read(PROBES);

    expect(res.inconclusive).toBe(false);
    expect(res.items.every((i) => i === null)).toBe(true);
    expect(res.stats.rpcs).toBe(33); // every probe asked, all answered no-id
  });

  it("scans past an untranslatable hit to the next probe (wave-25 parity)", async () => {
    const made = solidPicker(0);
    const { picker, fragments } = made;
    let calls = 0;
    fragments.list.set("m-1", {
      object: { visible: true },
      getLocalIdsFromItemIds: async (ids: Iterable<number>) => {
        calls += 1;
        // First hit is LOD filler with no express id; the next resolves.
        return calls === 1 ? [] : [...ids].map((id) => id + 1000);
      },
    });
    const reader = detectIdPassInterop(picker).reader!;
    const res = await reader.read([
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.2, y: 0 },
    ]);

    expect(calls).toBe(2);
    expect(res.inconclusive).toBe(false);
    expect(res.items[0]).toBeNull();
    expect(res.items[1]).toEqual({ modelId: "m-1", localId: 1007 });
  });

  it("a late reply from an abandoned RPC cannot serve a stale express id", async () => {
    // The budget deliberately leaves the engine call running. If the model
    // is reloaded under the SAME id while that call is still in flight, its
    // late answer must never become the mapping the next click reads: the
    // bucket is tagged with the model instance it was learned from, so the
    // stale write is discarded and the live model is re-asked.
    vi.useFakeTimers();
    try {
      let releaseLate: (v: number[]) => void = () => undefined;
      const lateModel = {
        object: { visible: true },
        getLocalIdsFromItemIds: vi.fn(
          () => new Promise<number[]>((res) => { releaseLate = res; }),
        ),
      };
      const made = solidPicker(0);
      const fragments = made.fragments;
      fragments.list.set("m-1", lateModel);
      const reader = detectIdPassInterop(made.picker).reader!;

      const first = reader.read(PROBES);
      await vi.advanceTimersByTimeAsync(LOCAL_ID_BUDGET_MS + 50);
      expect((await first).inconclusive).toBe(true);

      // same modelId, different instance, different mapping
      const freshModel = {
        object: { visible: true },
        getLocalIdsFromItemIds: vi.fn(async (ids: Iterable<number>) =>
          [...ids].map((id) => id + 9000),
        ),
      };
      fragments.list.set("m-1", freshModel);

      const second = await reader.read(PROBES);
      expect(second.items[0]).toEqual({ modelId: "m-1", localId: 9007 });

      // the abandoned call finally lands, claiming the OLD instance
      releaseLate([1007]);
      await vi.advanceTimersByTimeAsync(LOCAL_ID_BUDGET_MS + 100);

      const third = await reader.read(PROBES);
      expect(third.items[0]).toEqual({ modelId: "m-1", localId: 9007 });
      expect(third.inconclusive).toBe(false);
      expect(freshModel.getLocalIdsFromItemIds).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes stats even when the render throws (no stale re-report)", async () => {
    const { picker } = solidPicker(0);
    const reader = detectIdPassInterop(picker).reader!;
    // First click: a good read, so stats exist.
    await reader.read(PROBES);
    expect(reader.lastStats?.rpcs).toBe(1);
    // Second click: the render throws before any pixel is read — the
    // stats handed to the chain must describe THIS click, not the last
    // successful one.
    (picker.world as AnyObject).renderer = {
      three: {
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
          throw new Error("device lost");
        },
      },
    };
    let threw = false;
    try {
      await reader.read(PROBES);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("device lost");
    }
    expect(threw).toBe(true);
    expect(reader.lastStats?.readbacks ?? -1).toBe(0);
    expect(reader.lastStats?.rpcs ?? -1).toBe(0);
  });
});


// ─── Wave 32: an empty scene is not a confirmed miss ──────────────────
//
// Measured on a 38 MB MEP model whose tiles had not streamed: 8,201 items
// known to the worker, 0 tile meshes in the scene, `applyIdMaterial()`
// returning an EMPTY map. Reporting "no hits" from that is a lie about the
// scene, and the caller acts on a confirmed miss by CLEARING the live
// selection — the field report: "click MEP, the highlight breaks".

describe("batched id pass — empty scene reads as inconclusive (wave 32)", () => {
  it("does not claim empty space when no model is registered", async () => {
    const { picker } = makePicker();
    // No streamed tiles => no model bytes to assign.
    picker.applyIdMaterial = () => new Map<number, string>();
    const reader = detectIdPassInterop(picker).reader!;

    const res = await reader.read([{ x: 0.1, y: 0.2 }]);

    expect(res.items).toEqual([null]);
    expect(res.inconclusive).toBe(true);
    expect(res.stats.sceneEmpty).toBe(true);
  });

  it("still calls a real miss a miss when models ARE registered", async () => {
    const { picker } = makePicker(); // default byte map holds one model
    const reader = detectIdPassInterop(picker).reader!;

    const res = await reader.read([{ x: 0.1, y: 0.2 }]);

    expect(res.stats.sceneEmpty).toBe(false);
    expect(res.inconclusive).toBe(false);
  });
});
