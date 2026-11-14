// __tests__/picking/anchorScissor.test.ts
//
// Wave 28 W1b — the depth pass clip. The mock picker records the target
// scissor that was in force DURING `getPointAt`, which is the only way to
// observe what three does with it (a bound target's own scissor is what
// reaches GL — `three.module.js:18424`), and drives the outcome from a
// "what the clip covers" predicate so a clip that excludes the anchor
// pixel behaves like a real mis-clipped render: it returns nothing.

import { describe, expect, it, vi } from "vitest";

import {
  anchorClipMode,
  pickAnchorClipped,
} from "../../src/picking/anchorScissor";

const SIZE = { x: 200, y: 100 };

interface MockOpts {
  /** world point the unclipped call would return */
  point?: { x: number; y: number; z: number } | null;
  /** the clip drops the anchor pixel entirely (a wrong box) */
  clipBreaks?: boolean;
  /** target exposes no scissor at all */
  noScissor?: boolean;
}

function makePicker(opts: MockOpts = {}) {
  const point = opts.point === undefined ? { x: 1, y: 2, z: 3 } : opts.point;
  const target: Record<string, unknown> = {
    width: SIZE.x,
    height: SIZE.y,
    scissorTest: false,
    scissor: opts.noScissor
      ? undefined
      : {
          x: 0,
          y: 0,
          z: SIZE.x,
          w: SIZE.y,
          set(x: number, y: number, w: number, h: number) {
            this.x = x;
            this.y = y;
            this.z = w;
            this.w = h;
          },
        },
  };
  const seen: Array<{ box: unknown; test: boolean }> = [];
  const getPointAt = vi.fn(async () => {
    const test = target.scissorTest === true;
    seen.push({ box: { ...(target.scissor as object) }, test });
    // A clip that is in force and does not cover the anchor pixel ⇒ the
    // rasterizer never touched it ⇒ nothing to decode.
    if (test && opts.clipBreaks) return null;
    return point;
  });
  const picker = {
    _renderTarget: target,
    _renderTargetSize: { ...SIZE },
    getPointAt,
  };
  return { picker, getPointAt, seen, target };
}

const CLICK = { x: 0, y: 0 }; // → pixel (100, 49)
const PIXEL = { x: 100, y: 49 };

const coversPixel = (box: { x: number; y: number; z: number; w: number }) =>
  PIXEL.x >= box.x &&
  PIXEL.x < box.x + box.z &&
  PIXEL.y >= box.y &&
  PIXEL.y < box.y + box.w;

describe("pickAnchorClipped (wave 28 W1b)", () => {
  it("clips to the anchor pixel and restores the target afterwards", async () => {
    const m = makePicker();
    const res = await pickAnchorClipped(m.picker as never, CLICK);

    expect(res.clipped).toBe(true);
    expect(res.point).toEqual({ x: 1, y: 2, z: 3 });
    const first = m.seen[0];
    expect(first.test).toBe(true);
    const box = first.box as { x: number; y: number; z: number; w: number };
    expect(coversPixel(box)).toBe(true);
    // tight: a handful of pixels, not the frame
    expect(box.z * box.w).toBeLessThan(SIZE.x * SIZE.y);

    // restored — a leak here would clip the app's own next render
    expect(m.target.scissorTest).toBe(false);
    expect((m.target.scissor as { z: number }).z).toBe(SIZE.x);
  });

  it("pays one control call, then trusts the clip", async () => {
    const m = makePicker();
    const a = await pickAnchorClipped(m.picker as never, CLICK);
    expect(a.verified).toBe(true);
    expect(m.getPointAt).toHaveBeenCalledTimes(2); // clipped + control

    const b = await pickAnchorClipped(m.picker as never, CLICK);
    expect(b.verified).toBe(false);
    expect(b.clipped).toBe(true);
    expect(m.getPointAt).toHaveBeenCalledTimes(3); // one call now
    expect(anchorClipMode(m.picker)).toBe("on");
  });

  it("a clip that drops the anchor pixel yields the UNCLIPPED point", async () => {
    // This is the whole reason the control exists: a clipped render that
    // misses the geometry returns null, and a null anchor silently sends
    // tap-to-create to the bbox centre — the wave-20 bug.
    const m = makePicker({ clipBreaks: true });
    const res = await pickAnchorClipped(m.picker as never, CLICK);

    expect(res.point).toEqual({ x: 1, y: 2, z: 3 }); // control's answer
    expect(res.clipped).toBe(false);
    expect(res.verified).toBe(true);
    expect(anchorClipMode(m.picker)).toBe("off");

    // and it stays off: no more clipping, no more control renders
    const before = m.getPointAt.mock.calls.length;
    const again = await pickAnchorClipped(m.picker as never, CLICK);
    expect(again.clipped).toBe(false);
    expect(again.point).toEqual({ x: 1, y: 2, z: 3 });
    expect(m.getPointAt.mock.calls.length - before).toBe(1);
    expect(m.seen[m.seen.length - 1].test).toBe(false);
  });

  it("two nulls prove nothing — probation continues", async () => {
    const m = makePicker({ point: null });
    const a = await pickAnchorClipped(m.picker as never, CLICK);
    expect(a.point).toBeNull();
    expect(anchorClipMode(m.picker)).toBe("pending");

    const b = await pickAnchorClipped(m.picker as never, CLICK);
    expect(b.verified).toBe(true); // still comparing
    expect(m.getPointAt).toHaveBeenCalledTimes(4);
  });

  it("a target with no scissor is not attempted", async () => {
    const m = makePicker({ noScissor: true });
    const res = await pickAnchorClipped(m.picker as never, CLICK);
    expect(res.clipped).toBe(false);
    expect(res.verified).toBe(false); // no wasted control render
    expect(res.point).toEqual({ x: 1, y: 2, z: 3 });
    expect(m.getPointAt).toHaveBeenCalledTimes(1);
    expect(anchorClipMode(m.picker)).toBe("off");
  });

  it("never throws on a missing picker or a malformed target", async () => {
    await expect(
      pickAnchorClipped(null, CLICK),
    ).resolves.toEqual({ point: null, clipped: false, verified: false });
    await expect(
      pickAnchorClipped({} as never, CLICK),
    ).resolves.toMatchObject({ point: null, clipped: false });
    await expect(
      pickAnchorClipped(
        { _renderTarget: {}, _renderTargetSize: {} } as never,
        CLICK,
      ),
    ).resolves.toMatchObject({ point: null, clipped: false });
  });

  it("each picker keeps its own verdict", async () => {
    const good = makePicker();
    const bad = makePicker({ clipBreaks: true });
    await pickAnchorClipped(good.picker as never, CLICK);
    await pickAnchorClipped(bad.picker as never, CLICK);
    expect(anchorClipMode(good.picker)).toBe("on");
    expect(anchorClipMode(bad.picker)).toBe("off");
  });
});
