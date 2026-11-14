// __tests__/picking/idPassScissor.test.ts
//
// Wave 28 W1 — the scissored id render.
//
// A mock renderer that HONOURS the scissor is the only honest way to test
// this: the failure mode is "the box landed somewhere else", and a mock
// that ignores the scissor can never observe it. So `makeGl` below keeps a
// real pixel buffer, clears and draws only inside the scissor that three
// would apply for a BOUND target — the target's own `scissor`/`scissorTest`
// (three.module.js:18424, applied at :18452) — and serves
// readRenderTargetPixels out of that buffer. A drifted box therefore reads
// STALE PIXELS exactly like a mis-scissored GL framebuffer does. It also
// counts `renderer.setScissor` calls, which the seam must not rely on.
//
// Pinned properties:
//   1. the scissor is proven against a full-frame control before it is
//      trusted, and the proof is only accepted on real geometry;
//   2. a scissor that MISSES geometry (decodes void) never ships void —
//      the control's answer does, and the scissor is off permanently;
//   3. one render per click once trusted;
//   4. a resize re-arms probation;
//   5. at fractional device pixel ratios the rounded box still contains
//      every probe pixel (the padding is not decoration).

import { describe, expect, it } from "vitest";

import { detectIdPassInterop } from "../../src/picking/idPassInterop";
import { idPassProbes } from "../../src/picking/pickSeam";

const W = 120;
const H = 80;

interface GlOpts {
  dpr?: number;
  /** shift the effective scissor by N device px — a coordinate bug, simulated */
  scissorDrift?: number;
  /** device-pixel rect that holds geometry: (gx, gy) is the element */
  geometryAt?: { x: number; y: number };
}

function makeGl(opts: GlOpts = {}) {
  const dpr = opts.dpr ?? 1;
  const drift = opts.scissorDrift ?? 0;
  const buf = new Uint8Array(W * H * 4);
  const calls = {
    renders: 0,
    clears: 0,
    reads: 0,
    /** every box written through the TARGET's scissor (the only one three honours) */
    boxes: [] as Array<{ x: number; y: number; w: number; h: number }>,
    /** renderer.setScissor calls — recorded so a regression to them is visible */
    rendererScissorCalls: 0,
  };

  // The render target owns the scissor three applies while it is bound
  // (three.module.js:18424 copies `renderTarget.scissor` / `.scissorTest`
  // into GL state; `renderer.setScissor()` only reaches the DEFAULT
  // framebuffer). The mock reproduces exactly that, so a wrong box behaves
  // like a wrong box on a real GPU instead of silently doing nothing.
  const target = {
    width: W,
    height: H,
    scissorTest: false,
    scissor: {
      x: 0,
      y: 0,
      z: W,
      w: H,
      set(x: number, y: number, w: number, h: number) {
        this.x = x;
        this.y = y;
        this.z = w;
        this.w = h;
      },
    },
  };

  const activeBox = () => {
    if (!target.scissorTest) return { x: 0, y: 0, w: W, h: H };
    const s = target.scissor;
    return { x: s.x + drift, y: s.y + drift, w: s.z, h: s.w };
  };

  const writePixel = (x: number, y: number, bytes: number[]) => {
    const o = (y * W + x) * 4;
    for (let i = 0; i < 4; i += 1) buf[o + i] = bytes[i];
  };
  const geo = opts.geometryAt ?? { x: 60, y: 40 };
  const inBox = (x: number, y: number) => {
    const b = activeBox();
    return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
  };

  const renderer = {
    clippingPlanes: [],
    getPixelRatio: () => dpr,
    getRenderTarget: () => target,
    autoClear: true,
    getClearColor: (c: unknown) => c,
    getClearAlpha: () => 1,
    getScissorTest: () => false,
    getScissor: (v: unknown) => v,
    setRenderTarget: () => undefined,
    setClearColor: () => undefined,
    setScissorTest: () => {
      // three ignores this while a target is bound — so must the code, and
      // so must the mock: writing it does nothing here.
      calls.rendererScissorCalls += 1;
    },
    setScissor: () => {
      calls.rendererScissorCalls += 1;
    },
    clear: () => {
      calls.clears += 1;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          if (inBox(x, y)) writePixel(x, y, [0, 0, 0, 0]);
        }
      }
    },
    render: () => {
      calls.renders += 1;
      calls.boxes.push(activeBox());
      // The id material writes model byte 1 / itemId+1 = 8 where the
      // element is; nowhere else.
      if (inBox(geo.x, geo.y)) writePixel(geo.x, geo.y, [1, 0, 0, 8]);
    },
    readRenderTargetPixels: (
      _t: unknown,
      x: number,
      y: number,
      w: number,
      h: number,
      out: Uint8Array,
    ) => {
      calls.reads += 1;
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const sx = x + col;
          const sy = y + row;
          const o = (sy * W + sx) * 4;
          const d = (row * w + col) * 4;
          for (let i = 0; i < 4; i += 1) out[d + i] = buf[o + i] ?? 0;
        }
      }
    },
  };

  return { renderer, calls, target, geo };
}

function makePicker(gl: ReturnType<typeof makeGl>) {
  const model = {
    object: { visible: true, isMesh: true },
    getLocalIdsFromItemIds: async (ids: Iterable<number>) =>
      [...ids].map((id) => id + 1000),
  };
  const fragments = { initialized: true, list: new Map<string, unknown>([["m-1", model]]) };
  const picker = {
    enabled: true,
    world: {
      renderer: { three: gl.renderer },
      scene: { three: { traverse: (cb: (c: unknown) => void) => { void cb; } } },
      camera: { three: {} },
    },
    components: { get: () => fragments },
    _renderTarget: gl.target,
    _renderTargetSize: { x: W, y: H },
    _idMaterial: { uniforms: { modelByte: { value: 0 } } },
    applyIdMaterial: () => new Map<number, string>([[1, "m-1"]]),
    restoreOriginalMaterials: () => undefined,
    readPixelAt(this: Record<string, unknown>, target: unknown, ndc?: { x: number; y: number }) {
      if (!this || !this.world) {
        throw new TypeError("Cannot read properties of undefined (reading 'world')");
      }
      const size = this._renderTargetSize as { x: number; y: number };
      const x = Math.max(0, Math.min(size.x - 1, Math.floor((ndc!.x + 1) * 0.5 * size.x)));
      const y = Math.max(0, Math.min(size.y - 1, Math.floor((ndc!.y + 1) * 0.5 * (size.y - 1))));
      const out = new Uint8Array(4);
      (this.world as { renderer: { three: typeof gl.renderer } }).renderer.three.readRenderTargetPixels(
        target,
        x,
        y,
        1,
        1,
        out,
      );
      return out;
    },
  } as unknown as Record<string, unknown>;
  return { picker, fragments };
}

// A click whose exact probe pixel is the element.
const CLICK = { x: 0, y: 0 }; // → device pixel (60, 39) with W=120,H=80
const clickPixel = {
  x: Math.floor((CLICK.x + 1) * 0.5 * W),
  y: Math.floor((CLICK.y + 1) * 0.5 * (H - 1)),
};

describe("scissored id render (wave 28 W1)", () => {
  it("is proven against a full-frame control before it is trusted", async () => {
    const gl = makeGl({ geometryAt: clickPixel });
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const first = await reader.read(probes);
    expect(first.stats.scissor).toBe(true);
    expect(first.stats.scissorVerify).toBe(true);
    // boxed + control
    expect(reader.totalRenders).toBe(2);
    // …and it was the TARGET's scissor that moved, never renderer.setScissor
    // (which three ignores while a target is bound).
    expect(gl.calls.rendererScissorCalls).toBe(0);
    expect(gl.calls.boxes.length).toBe(2);
    const [boxed, control] = gl.calls.boxes;
    expect(boxed.w * boxed.h).toBeLessThan(control.w * control.h);
    expect(first.items[0]).toEqual({ modelId: "m-1", localId: 1007 });

    // Trusted now: one render, no control, same answer.
    const second = await reader.read(probes);
    expect(second.stats.scissorVerify).toBe(false);
    expect(reader.totalRenders).toBe(3);
    expect(second.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
  });

  it("a scissor that misses geometry never ships its void — the control does", async () => {
    // Drift the box 40 device px: the element falls outside the rendered
    // region, so the scissored pass legitimately reads a clean empty
    // buffer. Without the control this is a confirmed "you clicked void".
    const gl = makeGl({ geometryAt: clickPixel, scissorDrift: 60 });
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const res = await reader.read(probes);
    expect(res.stats.scissorVerify).toBe(true);
    // The click still resolves the element — the control's answer shipped.
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
    expect(res.inconclusive).toBe(false);

    // …and the scissor is off from here on: no more boxed renders.
    const before = gl.calls.renders;
    const again = await reader.read(probes);
    expect(again.stats.scissor).toBe(false);
    expect(gl.calls.renders - before).toBe(1);
  });

  it("stays on probation while both scans are void", async () => {
    // No geometry under the probes: agreement proves nothing, so the next
    // click must still pay the control render.
    const gl = makeGl({ geometryAt: { x: 5, y: 5 } });
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const a = await reader.read(probes);
    expect(a.items.every((i) => i === null)).toBe(true);
    expect(a.stats.scissor).toBe(true);
    expect(a.stats.scissorVerify).toBe(true);
    const b = await reader.read(probes);
    expect(b.stats.scissorVerify).toBe(true); // still proving
    expect(reader.totalRenders).toBe(4);
  });

  it("re-arms probation when the target is resized", async () => {
    const gl = makeGl({ geometryAt: clickPixel });
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    await reader.read(probes); // prove
    const trusted = await reader.read(probes);
    expect(trusted.stats.scissorVerify).toBe(false);

    (picker._renderTargetSize as { x: number }).x = W + 40; // resize
    const afterResize = await reader.read(probes);
    expect(afterResize.stats.scissorVerify).toBe(true);
  });

  it("keeps every probe inside the box, at any device pixel ratio", async () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const gl = makeGl({ dpr, geometryAt: clickPixel });
      const { picker } = makePicker(gl);
      const reader = detectIdPassInterop(picker).reader!;
      const probes = idPassProbes(CLICK, { x: W, y: H });
      await reader.read(probes);

      const boxed = gl.calls.boxes[0];
      expect(boxed, `dpr ${dpr}`).toBeTruthy();
      const { x: dx, y: dy, w: dw, h: dh } = boxed!;
      // A bound target's scissor is applied unscaled, so the box must not
      // move with the pixel ratio at all.
      expect(dx, `dpr ${dpr}`).toBeLessThanOrEqual(clickPixel.x - 1);
      for (const ndc of probes) {
        const px = Math.max(0, Math.min(W - 1, Math.floor((ndc.x + 1) * 0.5 * W)));
        const py = Math.max(0, Math.min(H - 1, Math.floor((ndc.y + 1) * 0.5 * (H - 1))));
        expect(
          px >= dx && px < dx + dw && py >= dy && py < dy + dh,
          `dpr ${dpr}: probe (${px},${py}) outside scissor (${dx},${dy},${dw},${dh})`,
        ).toBe(true);
      }
    }
  });

  it("does not attempt a scissor the target cannot honour", async () => {
    // A target with no `scissor` to write is the case where a "scissored"
    // render would silently be a full-frame one. Attempting it would buy
    // nothing and would still cost the control render on every probation
    // pass, so the seam must not try — and must not burn the proof either.
    const gl = makeGl({ geometryAt: clickPixel });
    delete (gl.target as { scissor?: unknown }).scissor;
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const res = await reader.read(probes);
    expect(res.stats.scissor).toBe(false);
    expect(res.stats.scissorVerify).toBe(false); // no pointless control render
    expect(reader.totalRenders).toBe(1);
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
  });

  it("?ffscissor=0 turns the optimization off at the seam", async () => {
    // The device A/B switch must be able to disable it completely — that is
    // how the win gets measured on real hardware instead of argued about.
    const gl = makeGl({ geometryAt: clickPixel });
    const { picker } = makePicker(gl);
    const reader = detectIdPassInterop(picker, { scissor: false }).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const res = await reader.read(probes);
    expect(res.stats.scissor).toBe(false);
    expect(res.stats.scissorVerify).toBe(false);
    expect(reader.totalRenders).toBe(1);
    expect(res.items[0]).toEqual({ modelId: "m-1", localId: 1007 });
  });

  it("an unprovable scissor is not taken at all — one scan, not two (wave 31b)", async () => {
    // Proving the scissor costs a second, unclipped scan. That is cheap
    // when ONE bounding-box readback covers all probes, but when the box
    // path is unavailable each scan costs one GPU readback PER PROBE, so
    // probation silently doubled the fan-out this seam exists to remove
    // (measured 68 readbacks per click on a 38 MB model, on every click
    // until probation happened to end). With no affordable proof the
    // answer is not "pay double" — it is "don't use an unproven clip":
    // one authoritative full-frame scan, correct result, half the cost.
    const gl = makeGl({ geometryAt: clickPixel });
    const { picker } = makePicker(gl);
    // Make the probe region fall outside the render target's own
    // dimensions: exactly the case `readProbeBox` refuses (three.js
    // silently no-ops an out-of-range read and leaves the buffer zeroed,
    // which would decode as "you clicked void" on real geometry).
    gl.target.width = 4;
    gl.target.height = 4;
    const reader = detectIdPassInterop(picker).reader!;
    const probes = idPassProbes(CLICK, { x: W, y: H });

    const res = await reader.read(probes);

    expect(String(res.stats.boxDecline).startsWith("region-out-of-target")).toBe(true);
    // …so neither the boxed pass nor a control pair: exactly one render.
    expect(reader.totalRenders).toBe(1);
    expect(res.stats.scissor).toBe(false);
    expect(res.stats.scissorVerify).toBeFalsy();
    // the probes were still read authoritatively, once
    expect(gl.calls.reads).toBeGreaterThan(0);
    expect(gl.calls.boxes.length).toBe(1);
  });
});
