// __tests__/picking/pickBackend.test.ts
//
// Wave 14 — focused tests for the picking backend seam. Two clusters:
//
//   1. Pick-path selection logic: `chooseBackend` (which backend is
//      chosen; fallback on init failure). Pure, no engine imports.
//   2. Seam behavior: the adapters (`pickWorldPointFast`,
//      `pickWorldPointRaycast`, `mapFullPick`) produce the same
//      plain result shapes the handle consumers already rely on —
//      `{x, y, z} | null` for the point pick and
//      `{ modelId, expressId, point } | null` for the selection
//      shape — so a stubbed picker behaves identically to Raycasters.

import { describe, expect, it } from "vitest";

import { chooseBackend } from "../../src/picking/chooseBackend";
import {
  percentile,
  computePickStats,
  formatPickStats,
} from "../../src/picking/pickBench";
import {
  toWorldPoint,
  pickWorldPointFast,
  pickWorldPointRaycast,
  pickElementFast,
  mapFullPick,
  normalizePickHit,
  resolveNearestHit,
  pickElementFastTolerant,
  pickElementIdFastTolerant,
  idPassProbes,
} from "../../src/picking/pickSeam";
import type {
  FastPointPicker,
  FastElementPicker,
  WorldPointCaster,
} from "../../src/picking/pickSeam";
import type {
  BatchedIdPassReader,
  IdItem,
} from "../../src/picking/idPassInterop";

// ── 1. Backend selection (pure) ────────────────────────────────

describe("chooseBackend", () => {
  it("prefers fast when FastModelPicker initialized cleanly", () => {
    expect(
      chooseBackend({
        fastAvailable: true,
        fastInitError: null,
        raycasterAvailable: true,
      }),
    ).toBe("fast");
  });

  it("falls back to raycaster when fast init threw", () => {
    expect(
      chooseBackend({
        fastAvailable: false,
        fastInitError: "A renderer is needed for the FastModelPicker to work!",
        raycasterAvailable: true,
      }),
    ).toBe("raycaster");
  });

  it("treats a present-but-errored fast picker as unavailable", () => {
    // Defensive: callers should never pass both fastAvailable=true and
    // a non-null init error together, but if they do, raycaster wins.
    expect(
      chooseBackend({
        fastAvailable: true,
        fastInitError: "boom",
        raycasterAvailable: true,
      }),
    ).toBe("raycaster");
  });

  it("falls back to raycaster when fast is unavailable", () => {
    expect(
      chooseBackend({
        fastAvailable: false,
        fastInitError: null,
        raycasterAvailable: true,
      }),
    ).toBe("raycaster");
  });

  it("returns raycaster as the safe default even when everything is missing", () => {
    expect(
      chooseBackend({
        fastAvailable: false,
        fastInitError: null,
        raycasterAvailable: false,
      }),
    ).toBe("raycaster");
  });
});

// ── 2. Bench (pure) ────────────────────────────────────────────

describe("pickBench", () => {
  it("percentile uses nearest-rank over a sorted array", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
  });

  it("percentile returns 0 for empty input", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("percentile clamps to the last element for q=1.0", () => {
    expect(percentile([0.1, 0.2, 0.3], 1.0)).toBe(0.3);
  });

  it("computePickStats sorts internally and reports counts", () => {
    const stats = computePickStats([5, 1, 4, 2, 3], "fast");
    expect(stats.backendId).toBe("fast");
    expect(stats.samples).toBe(5);
    expect(stats.p50Ms).toBe(3);
    expect(stats.p95Ms).toBe(5);
  });

  it("formatPickStats renders a single-line summary", () => {
    const stats = computePickStats([1, 2, 3], "raycaster");
    expect(formatPickStats(stats)).toMatch(/p50=/);
    expect(formatPickStats(stats)).toContain("backend=raycaster");
  });
});

// ── 3. Seam adapters (result shapes) ───────────────────────────

describe("pickSeam adapters", () => {
  describe("toWorldPoint", () => {
    it("copies a vector-like into a plain object", () => {
      expect(toWorldPoint({ x: 1, y: 2, z: 3 })).toEqual({
        x: 1,
        y: 2,
        z: 3,
      });
    });

    it("returns null for null/undefined", () => {
      expect(toWorldPoint(null)).toBeNull();
      expect(toWorldPoint(undefined)).toBeNull();
    });
  });

  describe("pickWorldPointFast", () => {
    it("returns {x,y,z} from a stubbed FastModelPicker hit", async () => {
      const picker: FastPointPicker = {
        getPointAt: async (position) => {
          expect(position).toEqual({ x: 0.5, y: -0.25 });
          return { x: 10, y: 20, z: 30 };
        },
      };
      const result = await pickWorldPointFast(picker, { x: 0.5, y: -0.25 });
      expect(result).toEqual({ x: 10, y: 20, z: 30 });
    });

    it("returns null on empty-space (picker returns null)", async () => {
      const picker: FastPointPicker = {
        getPointAt: async () => null,
      };
      expect(await pickWorldPointFast(picker, { x: 0, y: 0 })).toBeNull();
    });

    it("returns null when the picker is unavailable", async () => {
      expect(await pickWorldPointFast(null, { x: 0, y: 0 })).toBeNull();
    });
  });

  describe("pickWorldPointRaycast", () => {
    it("returns {x,y,z} from a stubbed caster hit", async () => {
      const caster: WorldPointCaster = {
        castRay: async (data) => {
          expect(data).toEqual({ position: { x: 0.5, y: -0.25 } });
          return { point: { x: 1, y: 2, z: 3 } };
        },
      };
      const result = await pickWorldPointRaycast(caster, {
        x: 0.5,
        y: -0.25,
      });
      expect(result).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("returns null on miss (no point)", async () => {
      const caster: WorldPointCaster = {
        castRay: async () => null,
      };
      expect(await pickWorldPointRaycast(caster, { x: 0, y: 0 })).toBeNull();
    });

    it("returns null when the caster is unavailable", async () => {
      expect(await pickWorldPointRaycast(null, { x: 0, y: 0 })).toBeNull();
    });

    it("produces the same shape as pickWorldPointFast for the same hit", async () => {
      const fast: FastPointPicker = {
        getPointAt: async () => ({ x: 7, y: 8, z: 9 }),
      };
      const ray: WorldPointCaster = {
        castRay: async () => ({ point: { x: 7, y: 8, z: 9 } }),
      };
      const ndc = { x: 0.1, y: 0.2 };
      const fastRes = await pickWorldPointFast(fast, ndc);
      const rayRes = await pickWorldPointRaycast(ray, ndc);
      expect(fastRes).toEqual(rayRes);
      expect(fastRes).toEqual({ x: 7, y: 8, z: 9 });
    });
  });

  describe("mapFullPick (selection result shape)", () => {
    it("maps getFullPick localId → expressId and carries the point", () => {
      const result = mapFullPick({
        modelId: "m-1",
        localId: 42,
        point: { x: 1, y: 2, z: 3 },
      });
      expect(result).toEqual({
        modelId: "m-1",
        expressId: 42,
        point: { x: 1, y: 2, z: 3 },
      });
    });

    it("returns null for empty-space picks", () => {
      expect(mapFullPick(null)).toBeNull();
    });

    it("fills a zero point when the picker omitted it", () => {
      const result = mapFullPick({ modelId: "m-1", localId: 7 });
      expect(result).toEqual({
        modelId: "m-1",
        expressId: 7,
        point: { x: 0, y: 0, z: 0 },
      });
    });

    it("carries the surface normal through (Wave 48)", () => {
      const result = mapFullPick({
        modelId: "m-1",
        localId: 42,
        point: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 0, z: 1 },
      });
      expect(result).toEqual({
        modelId: "m-1",
        expressId: 42,
        point: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 0, z: 1 },
      });
    });

    it("omits the normal key when the pick has no normal (backward-compatible)", () => {
      const result = mapFullPick({
        modelId: "m-1",
        localId: 5,
        point: { x: 0, y: 0, z: 0 },
      });
      expect("normal" in result).toBe(false);
    });
  });

  describe("pickElementFast (viewer click pipeline)", () => {
    it("maps getFullPick localId → expressId and carries a real point", async () => {
      const picker: FastElementPicker = {
        getPointAt: async () => ({ x: 1, y: 2, z: 3 }),
        getFullPick: async (position) => {
          expect(position).toEqual({ x: 0.5, y: -0.25 });
          return { modelId: "m-2", localId: 99, point: { x: 4, y: 5, z: 6 } };
        },
      };
      const result = await pickElementFast(picker, { x: 0.5, y: -0.25 });
      expect(result).toEqual({
        modelId: "m-2",
        expressId: 99,
        point: { x: 4, y: 5, z: 6 },
      });
    });

    it("returns null on empty space (getFullPick returns null)", async () => {
      const picker: FastElementPicker = {
        getPointAt: async () => null,
        getFullPick: async () => null,
      };
      expect(await pickElementFast(picker, { x: 0, y: 0 })).toBeNull();
    });

    it("returns null when the picker is unavailable", async () => {
      expect(await pickElementFast(null, { x: 0, y: 0 })).toBeNull();
    });

    it("resolves the nearest hit across two models with real distances", async () => {
      // Simulate getFullPick results from TWO registered models for the
      // same click: the model #2 hit is nearer and must win.
      const fastA: FastElementPicker = {
        getPointAt: async () => ({ x: 0, y: 0, z: 0 }),
        getFullPick: async () => null, // model #1 missed this ray
      };
      const fastB: FastElementPicker = {
        getPointAt: async () => ({ x: 0, y: 0, z: 0 }),
        getFullPick: async () => ({
          modelId: "m-2",
          localId: 22,
          point: { x: 1, y: 2, z: 3 },
        }),
      };
      const pickA = mapFullPick(await fastA.getFullPick());
      const pickB = mapFullPick(await fastB.getFullPick());
      const resolved = resolveNearestHit([
        pickA
          ? { modelId: pickA.modelId, localId: pickA.expressId, distance: 40 }
          : null,
        pickB
          ? {
              modelId: pickB.modelId,
              localId: pickB.expressId,
              distance: 9,
              point: pickB.point,
            }
          : null,
      ]);
      expect(resolved).toEqual({
        modelId: "m-2",
        expressId: 22,
        point: { x: 1, y: 2, z: 3 },
      });
    });
  });

  describe("multi-model resolution (Wave 15)", () => {
    it("normalizePickHit maps a FastModelPicker hit (modelId top-level)", () => {
      expect(
        normalizePickHit({
          modelId: "m-2",
          localId: 99,
          point: { x: 1, y: 2, z: 3 },
        }),
      ).toEqual({
        modelId: "m-2",
        localId: 99,
        distance: undefined,
        point: { x: 1, y: 2, z: 3 },
      });
    });

    it("normalizePickHit maps a Raycasters hit (fragments.modelId)", () => {
      expect(
        normalizePickHit({
          localId: 5,
          fragments: { modelId: "m-1" },
          distance: 12.5,
          point: { x: 0, y: 0, z: 8 },
        }),
      ).toEqual({
        modelId: "m-1",
        localId: 5,
        distance: 12.5,
        point: { x: 0, y: 0, z: 8 },
      });
    });

    it("normalizePickHit returns null for empty-space (no localId)", () => {
      expect(normalizePickHit({ fragments: { modelId: "m-1" } })).toBeNull();
      expect(normalizePickHit(null)).toBeNull();
      expect(normalizePickHit(undefined)).toBeNull();
    });

    it("resolveNearestHit picks the nearest hit across two models", () => {
      // Given hits from both backends for the same click on model #2
      // (the second IFC): the raycaster fallback reports a farther
      // hit on model #1 while the fast picker reports the model #2
      // hit — the model #2 id must win.
      const resolved = resolveNearestHit([
        { modelId: "m-1", localId: 11, distance: 40 },
        { modelId: "m-2", localId: 22, distance: 9 },
      ]);
      expect(resolved).toEqual({
        modelId: "m-2",
        expressId: 22,
        point: { x: 0, y: 0, z: 0 },
      });
    });

    it("resolveNearestHit ignores a null backend hit and returns the other", () => {
      const resolved = resolveNearestHit([
        null,
        { modelId: "m-2", localId: 33 },
      ]);
      expect(resolved).toEqual({
        modelId: "m-2",
        expressId: 33,
        point: { x: 0, y: 0, z: 0 },
      });
    });

    it("resolveNearestHit returns null when every candidate misses", () => {
      expect(resolveNearestHit([null, undefined])).toBeNull();
      expect(resolveNearestHit([])).toBeNull();
      expect(
        resolveNearestHit([{ modelId: "", localId: 1 }]),
      ).toBeNull();
    });

    it("resolveNearestHit keeps input order on distance ties (backend agreement)", () => {
      // Both backends agree the hit is model #1's element 7; the first
      // candidate (fast picker) must win unchanged.
      const resolved = resolveNearestHit([
        { modelId: "m-1", localId: 7 },
        { modelId: "m-1", localId: 7, distance: 5 },
      ]);
      expect(resolved).toEqual({
        modelId: "m-1",
        expressId: 7,
        point: { x: 0, y: 0, z: 0 },
      });
    });
  });
});

// ── Wave 19b: tolerant fast pick (GPU id-pass single-pixel misses) ──

// Wave 21: the id-pass-only tolerant pick that now drives the click
// pipeline — the depth/normal passes must NOT run inside it (that
// serialized 3-render chain was the click→highlight lag).
describe("pickElementIdFastTolerant", () => {
  const SIZE = { x: 1600, y: 800 };
  const probe = (
    over: Partial<{
      items: Record<string, { modelId: string; localId: number } | null>;
    }> = {},
  ) => {
    const key = (p?: { x: number; y: number }) =>
      p ? `${p.x.toFixed(6)},${p.y.toFixed(6)}` : "center";
    const counts = { fullCalls: 0, pointCalls: 0, itemCalls: 0 };
    return {
      counts,
      getFullPick: async () => {
        counts.fullCalls++;
        return null as never;
      },
      getItemAt: async (p?: { x: number; y: number }) => {
        counts.itemCalls++;
        return over.items?.[key(p)] ?? null;
      },
      getPointAt: async () => {
        counts.pointCalls++;
        return null;
      },
    };
  };

  it("exact-pixel hit resolves on the id pass alone", async () => {
    const picker = probe({
      items: { "0.000000,0.000000": { modelId: "m-1", localId: 7 } },
    });
    const res = await pickElementIdFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res).toEqual({ modelId: "m-1", expressId: 7, probeNdc: { x: 0, y: 0 } });
    expect(picker.counts.fullCalls).toBe(0);
    expect(picker.counts.pointCalls).toBe(0);
  });

  it("ring hit returns the WINNING probe ndc for the follow-up depth pass", async () => {
    const hitKey = "0.002500,0.000000"; // 2px right of centre
    const picker = probe({ items: { [hitKey]: { modelId: "m-2", localId: 465474 } } });
    const res = await pickElementIdFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res?.modelId).toBe("m-2");
    expect(res?.expressId).toBe(465474);
    expect(res?.probeNdc).toEqual({ x: 0.0025, y: 0 });
  });

  it("true empty space scans all rings, touches no depth pass", async () => {
    const picker = probe();
    const res = await pickElementIdFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res).toBeNull();
    expect(picker.counts.itemCalls).toBe(33); // exact + 4 rings × 8
    expect(picker.counts.pointCalls).toBe(0);
    expect(picker.counts.fullCalls).toBe(0);
  });

  // ── Wave 25: batched id-pass path (one render per click) ────
  describe("batched path (Wave 25)", () => {
    const makeReader = (items: Array<IdItem | null> = []) => {
      const ndcCalls: Array<Array<{ x: number; y: number }>> = [];
      let reads = 0;
      const reader: BatchedIdPassReader = {
        get totalRenders() {
          return reads;
        },
        // Wave-28 outcome shape: `{ items, inconclusive, stats }`.
        read: async (ndcs) => {
          reads += 1;
          ndcCalls.push(ndcs.map((n) => ({ ...n })));
          const resolved =
            items.length > 0 ? items : ndcs.map(() => null as IdItem | null);
          return {
            items: resolved,
            inconclusive: false,
            stats: {
              probes: ndcs.length,
              rawHits: resolved.filter((i) => i !== null).length,
              rpcs: resolved.some((i) => i !== null) ? 1 : 0,
              cacheHits: 0,
              readbacks: 1,
              boxRead: true,
              translateTimeouts: 0,
              ms: 1,
            },
          };
        },
      };
      return { reader, ndcCalls, getReads: () => reads };
    };

    it("true empty space ⇒ ONE render for all 33 probes (counter, not timer)", async () => {
      const picker = probe();
      const { reader, ndcCalls, getReads } = makeReader();
      const res = await pickElementIdFastTolerant(
        picker,
        { x: 0, y: 0 },
        SIZE,
        reader,
      );
      expect(res).toBeNull();
      // The core assertion: a full 33-probe tolerant miss collapses to
      // exactly ONE id render — never the legacy 33 per-probe renders.
      expect(getReads()).toBe(1);
      expect(ndcCalls).toHaveLength(1);
      expect(ndcCalls[0]).toHaveLength(33); // exact + 4 rings × 8, in order
      // And the per-probe getItemAt fallback was NOT touched.
      expect(picker.counts.itemCalls).toBe(0);
      expect(picker.counts.pointCalls).toBe(0);
    });

    it("hit-on-exact ⇒ ONE render and resolves via localId", async () => {
      const picker = probe();
      const items: Array<IdItem | null> = new Array(33).fill(null);
      items[0] = { modelId: "m-9", localId: 465474 };
      const { reader, getReads } = makeReader(items);
      const res = await pickElementIdFastTolerant(
        picker,
        { x: 0, y: 0 },
        SIZE,
        reader,
      );
      expect(res).toEqual({
        modelId: "m-9",
        expressId: 465474,
        probeNdc: { x: 0, y: 0 },
      });
      expect(getReads()).toBe(1);
      expect(picker.counts.itemCalls).toBe(0);
    });

    it("ring hit returns the winning probe ndc (first-hit-wins order)", async () => {
      const picker = probe();
      // 2px right of centre is probe index 1 (radius 2, +x offset).
      const hitProbe = { x: 0.0025, y: 0 };
      const items: Array<IdItem | null> = new Array(33).fill(null);
      items[1] = { modelId: "m-2", localId: 7 };
      const { reader } = makeReader(items);
      const res = await pickElementIdFastTolerant(
        picker,
        { x: 0, y: 0 },
        SIZE,
        reader,
      );
      expect(res).toEqual({
        modelId: "m-2",
        expressId: 7,
        probeNdc: hitProbe,
      });
    });

    it("matches the fallback scan order (idPassProbes is exact-then-rings)", () => {
      const probes = idPassProbes({ x: 0, y: 0 }, SIZE);
      expect(probes).toHaveLength(33);
      expect(probes[0]).toEqual({ x: 0, y: 0 });
      // radius 2, +x: dx = (2/1600)*2 = 0.0025
      expect(probes[1]).toEqual({ x: 0.0025, y: 0 });
      // radius 8, last offset is -dx,-dy: dy = (8/800)*2 = 0.02
      expect(probes[32]).toEqual({ x: -0.01, y: -0.02 });
    });

    it("batched read rejects ⇒ degrades to the legacy per-probe loop (wave-25b)", async () => {
      const picker = probe();
      const reader: BatchedIdPassReader = {
        totalRenders: 0,
        read: async () => {
          throw new TypeError(
            "Cannot read properties of undefined (reading 'world')",
          );
        },
      };
      const res = await pickElementIdFastTolerant(
        picker,
        { x: 0, y: 0 },
        SIZE,
        reader,
      );
      expect(res).toBeNull();
      // The click SURVIVES via the exact pre-wave-25 scan: exact pixel
      // plus all 32 ring probes — never a swallowed click.
      expect(picker.counts.itemCalls).toBe(33);
    });

    it("read reject + element under the ring ⇒ fallback still selects it", async () => {
      const picker = probe({
        items: { "0.002500,0.000000": { modelId: "m-3", localId: 21 } },
      });
      const reader: BatchedIdPassReader = {
        totalRenders: 0,
        read: async () => {
          throw new Error("internals drifted");
        },
      };
      const res = await pickElementIdFastTolerant(
        picker,
        { x: 0, y: 0 },
        SIZE,
        reader,
      );
      expect(res).toEqual({
        modelId: "m-3",
        expressId: 21,
        probeNdc: { x: 0.0025, y: 0 },
      });
      // exact pixel (void) then the winning ring probe — first-hit-wins
      expect(picker.counts.itemCalls).toBe(2);
    });
  });
});

describe("pickElementFastTolerant", () => {
  const SIZE = { x: 1600, y: 800 };
  const probe = (
    over: Partial<{
      full: unknown;
      items: Record<string, { modelId: string; localId: number } | null>;
      points: Record<string, { x: number; y: number; z: number } | null>;
    }> = {},
  ) => {
    const key = (p?: { x: number; y: number }) =>
      p ? `${p.x.toFixed(6)},${p.y.toFixed(6)}` : "center";
    return {
      getFullPick: async () => (over.full ?? null) as never,
      getItemAt: async (p?: { x: number; y: number }) =>
        over.items?.[key(p)] ?? null,
      getPointAt: async (p?: { x: number; y: number }) =>
        over.points?.[key(p)] ?? null,
    };
  };

  it("exact-pixel hit short-circuits (no ring probes)", async () => {
    let itemCalls = 0;
    const picker = probe({ full: { modelId: "m-1", localId: 7, point: { x: 1, y: 2, z: 3 } } });
    const origGetItem = picker.getItemAt;
    const wrapped = {
      ...picker,
      getItemAt: async (p?: { x: number; y: number }) => {
        itemCalls++;
        return origGetItem(p);
      },
    };
    const res = await pickElementFastTolerant(wrapped, { x: 0, y: 0 }, SIZE);
    expect(res).toEqual({
      modelId: "m-1",
      expressId: 7,
      point: { x: 1, y: 2, z: 3 },
    });
    expect(itemCalls).toBe(0);
  });

  it("resolves on the first ring when the exact pixel reads void", async () => {
    // 2px right of center in NDC: dx = (2/1600)*2 = 0.0025
    const hitKey = "0.002500,0.000000";
    const picker = probe({
      items: { [hitKey]: { modelId: "m-2", localId: 465474 } },
      points: { [hitKey]: { x: 6.5, y: 10.2, z: -4 } },
    });
    const res = await pickElementFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res).toEqual({
      modelId: "m-2",
      expressId: 465474,
      point: { x: 6.5, y: 10.2, z: -4 },
    });
  });

  it("id hit + depth miss still resolves (zero-vector point)", async () => {
    const hitKey = "0.000000,-0.005000"; // 2px below center: dy = (2/800)*2
    const picker = probe({
      items: { [hitKey]: { modelId: "m-1", localId: 5 } },
      points: { [hitKey]: null },
    });
    const res = await pickElementFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res).toEqual({
      modelId: "m-1",
      expressId: 5,
      point: { x: 0, y: 0, z: 0 },
    });
  });

  it("true empty space scans all rings and returns null", async () => {
    let itemCalls = 0;
    const base = probe();
    const picker = {
      ...base,
      getItemAt: async (p?: { x: number; y: number }) => {
        itemCalls++;
        return base.getItemAt(p);
      },
    };
    const res = await pickElementFastTolerant(picker, { x: 0, y: 0 }, SIZE);
    expect(res).toBeNull();
    // 4 radii x 8 offsets = 32 ring probes, no more.
    expect(itemCalls).toBe(32);
  });

  it("degrades to null without a picker or with a zero-size canvas", async () => {
    expect(await pickElementFastTolerant(null, { x: 0, y: 0 }, SIZE)).toBeNull();
    const picker = probe();
    expect(
      await pickElementFastTolerant(picker, { x: 0, y: 0 }, { x: 0, y: 100 }),
    ).toBeNull();
  });
});
