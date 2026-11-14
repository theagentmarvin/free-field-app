// __tests__/picking/debugTools.test.ts
//
// Wave 19d — the opt-in debug gate. Two clusters:
//
//   1. `resolveDebugToolsEnabled` — the pure param/stored decision
//      (param wins, `0` disarms, otherwise follow the tab flag).
//   2. `buildDebugToolsSurface.pickAt` — client-pixel → NDC math and
//      pass-through of the picker results, with the no-picker /
//      no-canvas error shapes. Stubs only; no WebGL.

import { describe, expect, it } from "vitest";

import {
  resolveDebugToolsEnabled,
  resolveScissorOverride,
  buildDebugToolsSurface,
} from "../../src/picking/debugTools";
import type { DebugToolsContext } from "../../src/picking/debugTools";

describe("resolveDebugToolsEnabled", () => {
  it("?ffdebug=1 arms regardless of the stored flag", () => {
    expect(resolveDebugToolsEnabled("1", null)).toBe(true);
    expect(resolveDebugToolsEnabled("1", "0")).toBe(true);
  });

  it("?ffdebug=0 disarms regardless of the stored flag", () => {
    expect(resolveDebugToolsEnabled("0", "1")).toBe(false);
    expect(resolveDebugToolsEnabled("0", null)).toBe(false);
  });

  it("no param follows the persisted tab flag", () => {
    expect(resolveDebugToolsEnabled(null, "1")).toBe(true);
    expect(resolveDebugToolsEnabled(null, null)).toBe(false);
    expect(resolveDebugToolsEnabled(null, "0")).toBe(false);
  });
});

describe("buildDebugToolsSurface.pickAt", () => {
  const canvasStub = () => ({
    getBoundingClientRect: () => ({ x: 10, y: 20, left: 10, top: 20, width: 200, height: 100 }),
  });

  const ctxWith = (
    picker: DebugToolsContext["picker"],
  ): DebugToolsContext => ({
    picker,
    world: {},
    fragments: {},
    backend: "fast",
    getCanvas: () => canvasStub() as unknown as HTMLCanvasElement,
  });

  it("maps a client pixel to NDC (y-up) and passes results through", async () => {
    const calls: Array<{ x: number; y: number }> = [];
    const picker = {
      getFullPick: async (p?: { x: number; y: number }) => {
        calls.push(p!);
        return { modelId: "m-1", localId: 42, point: { x: 1, y: 2, z: 3 } };
      },
      getItemAt: async () => ({ modelId: "m-1", localId: 42 }),
      getPointAt: async () => ({ x: 1, y: 2, z: 3 }),
    };
    const surface = buildDebugToolsSurface(ctxWith(picker as never));
    // client (110, 45) inside a canvas at (10,20,200x100)
    // → ndc x = ((110-10)/200)*2-1 = 0 ; y = -(((45-20)/100)*2-1) = 0.5
    // (an off-centre point: the exact centre would produce -0 for y,
    // which toEqual distinguishes from +0)
    const res = await surface.pickAt(110, 45);
    expect(res.ndc).toEqual({ x: 0, y: 0.5 });
    expect(res.full).toEqual({ modelId: "m-1", localId: 42 });
    expect(res.item).toEqual({ modelId: "m-1", localId: 42 });
    expect(res.point).toEqual({ x: 1, y: 2, z: 3 });
    expect(calls).toEqual([{ x: 0, y: 0.5 }]);
  });

  it("reports no-fast-picker when the surface has no picker", async () => {
    const surface = buildDebugToolsSurface(ctxWith(null));
    const res = await surface.pickAt(0, 0);
    expect(res.error).toBe("no fast picker");
    expect(res.item).toBeNull();
  });

  it("backend() reflects the mount-time choice", () => {
    const surface = buildDebugToolsSurface(ctxWith(null));
    expect(surface.backend()).toBe("fast");
  });
});

// Wave 22 — the degradation-hunt stats surface. Structural reads of
// TOE internals (selection maps, material-swap bookkeeping) plus the
// viewer's chain counters; every unavailable piece must come back
// null, never throw.
describe("buildDebugToolsSurface.stats", () => {
  const baseCtx = (): DebugToolsContext => ({
    picker: null,
    world: {},
    fragments: {},
    backend: "fast",
    getCanvas: () => null,
  });

  it("sums highlighter selection ids per group and passes chain counters through", () => {
    const ctx = baseCtx();
    ctx.getHighlighter = () => ({
      selection: {
        select: { "m-1": new Set([1, 2, 3]), "m-2": new Set([9]) },
        hover: { "m-1": new Set([4]) },
      },
      styles: { list: { size: 2 } },
      eventManager: { list: { length: 6 } },
    });
    ctx.getChainStats = () => ({
      clicks: 7,
      applied: 5,
      superseded: 1,
      emptyClicks: 1,
      lastClickToSelectionMs: 142,
      lastClickToPointMs: 201,
      recentClickToSelectionMs: [120, 131, 142],
      lastHighlightMs: 210,
      highlightInFlight: 1,
      highlightInFlightPeak: 2,
      highlightCoalesced: 3,
      idPassRenders: 33,
      lastClickRenders: 1,
    });
    const stats = buildDebugToolsSurface(ctx).stats();
    expect(stats.highlighter).toEqual({
      selectionGroups: { select: 4, hover: 1 },
      styles: 2,
      eventSubscribers: 6,
    });
    expect(stats.chain?.clicks).toBe(7);
    expect(stats.chain?.recentClickToSelectionMs).toEqual([120, 131, 142]);
  });

  it("reads picker material bookkeeping when present", () => {
    const ctx = baseCtx();
    ctx.picker = {
      getFullPick: async () => null,
      getItemAt: async () => null,
      getPointAt: async () => null,
      _originalMaterials: new Map([[{}, {}], [{}, {}]]),
      _hiddenLods: [{}, {}, {}, {}],
    } as unknown as DebugToolsContext["picker"];
    const stats = buildDebugToolsSurface(ctx).stats();
    expect(stats.picker).toEqual({ originalMaterials: 2, hiddenLods: 4 });
  });

  it("never throws on missing/garbage internals", () => {
    const ctx = baseCtx();
    ctx.getHighlighter = () => ({ selection: null, styles: 42 });
    ctx.getChainStats = () => null;
    expect(() => buildDebugToolsSurface(ctx).stats()).not.toThrow();
    const stats = buildDebugToolsSurface(ctx).stats();
    expect(stats.chain).toBeNull();
    expect(stats.backend).toBe("fast");
  });
});

describe("resolveScissorOverride (wave 28 W1 device A/B)", () => {
  it("defaults to ON — no param means the optimization is allowed", () => {
    expect(resolveScissorOverride(null)).toBe(true);
  });
  it("respects an explicit ?ffscissor=0", () => {
    expect(resolveScissorOverride("0")).toBe(false);
  });
  it("respects an explicit ?ffscissor=1", () => {
    expect(resolveScissorOverride("1")).toBe(true);
  });
  it("ignores junk values rather than disabling the fast path", () => {
    expect(resolveScissorOverride("maybe")).toBe(true);
    expect(resolveScissorOverride("")).toBe(true);
  });
});
