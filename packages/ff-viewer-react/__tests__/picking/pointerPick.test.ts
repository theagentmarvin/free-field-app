import { describe, expect, it, vi } from "vitest";
import {
  MOUSE_TAP_SLOP_PX,
  TOUCH_TAP_SLOP_PX,
  clientToNdc,
  createTapTracker,
  feedEngineMouse,
  ndcToBufferPixel,
  tapSlopPx,
} from "../../src/picking/pointerPick";

const rect = { left: 10, top: 20, width: 412, height: 800 };

describe("clientToNdc (CSS px -> NDC)", () => {
  it("maps the rect corners and centre", () => {
    expect(clientToNdc(rect, 10, 20)).toEqual({ x: -1, y: 1 });
    expect(clientToNdc(rect, 422, 820)).toEqual({ x: 1, y: -1 });
    const c = clientToNdc(rect, 216, 420)!;
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(0, 12);
  });

  it("is independent of the device / renderer pixel ratio", () => {
    // The same tap must give the same NDC whatever ratio the host set: the
    // rect is in CSS px and the event is in CSS px, a ratio never enters.
    const tap = { x: 120.5, y: 333.25 };
    const base = clientToNdc(rect, tap.x, tap.y)!;
    for (const ratio of [0.75, 1, 1.5, 2, 3]) {
      // A host that (wrongly) reported buffer pixels would scale the rect AND
      // the event together: NDC is still identical.
      const scaledRect = {
        left: rect.left * ratio,
        top: rect.top * ratio,
        width: rect.width * ratio,
        height: rect.height * ratio,
      };
      const n = clientToNdc(scaledRect, tap.x * ratio, tap.y * ratio)!;
      expect(n.x).toBeCloseTo(base.x, 10);
      expect(n.y).toBeCloseTo(base.y, 10);
    }
  });

  it("rejects degenerate input", () => {
    expect(clientToNdc({ ...rect, width: 0 }, 1, 1)).toBeNull();
    expect(clientToNdc(rect, Number.NaN, 1)).toBeNull();
  });
});

describe("ndcToBufferPixel", () => {
  it("lands on the same CSS point at every buffer ratio (to within one buffer pixel)", () => {
    const tapCss = { x: 100, y: 300 };
    const ndc = clientToNdc(rect, tapCss.x, tapCss.y)!;
    for (const ratio of [0.75, 1, 1.5, 2]) {
      const w = Math.round(rect.width * ratio);
      const h = Math.round(rect.height * ratio);
      const px = ndcToBufferPixel(ndc, w, h)!;
      // buffer pixel back to CSS px (bottom-up y)
      const backX = px.x / ratio;
      const backY = rect.height - px.y / ratio;
      expect(Math.abs(backX - (tapCss.x - rect.left))).toBeLessThanOrEqual(1 / ratio + 1e-9);
      expect(Math.abs(backY - (tapCss.y - rect.top))).toBeLessThanOrEqual(1 / ratio + 1e-9);
    }
  });

  it("clamps and rejects bad sizes", () => {
    expect(ndcToBufferPixel({ x: 5, y: -5 }, 100, 50)).toEqual({ x: 99, y: 0 });
    expect(ndcToBufferPixel({ x: 0, y: 0 }, 0, 50)).toBeNull();
    expect(ndcToBufferPixel({ x: Number.NaN, y: 0 }, 10, 10)).toBeNull();
  });
});

describe("tap tracker (drag vs tap)", () => {
  it("uses a wider slop for touch than for the mouse", () => {
    expect(tapSlopPx("mouse")).toBe(MOUSE_TAP_SLOP_PX);
    expect(tapSlopPx("touch")).toBe(TOUCH_TAP_SLOP_PX);
    expect(tapSlopPx("pen")).toBe(TOUCH_TAP_SLOP_PX);
    expect(TOUCH_TAP_SLOP_PX).toBeGreaterThan(MOUSE_TAP_SLOP_PX);
  });

  it("a jittery finger tap (8 px of travel) is still a tap; the mouse is not", () => {
    const t = createTapTracker();
    t.down({ pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    t.move({ pointerId: 1, pointerType: "touch", clientX: 106, clientY: 105 });
    t.up({ pointerId: 1, clientX: 106, clientY: 105 });
    expect(t.wasDrag()).toBe(false);

    t.down({ pointerId: 2, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    t.move({ pointerId: 2, pointerType: "mouse", clientX: 106, clientY: 105 });
    t.up({ pointerId: 2, clientX: 106, clientY: 105 });
    expect(t.wasDrag()).toBe(true);
  });

  it("a real touch drag past the slop is a drag, and consuming it resets", () => {
    const t = createTapTracker();
    t.down({ pointerId: 1, pointerType: "touch", button: 0, clientX: 0, clientY: 0 });
    t.move({ pointerId: 1, pointerType: "touch", clientX: 40, clientY: 0 });
    t.up({ pointerId: 1, clientX: 40, clientY: 0 });
    expect(t.wasDrag()).toBe(true);
    expect(t.wasDrag()).toBe(false);
  });

  it("a second finger (pinch) and pointercancel are never taps", () => {
    const t = createTapTracker();
    t.down({ pointerId: 1, pointerType: "touch", button: 0, clientX: 0, clientY: 0 });
    t.down({ pointerId: 2, pointerType: "touch", button: 0, clientX: 50, clientY: 0 });
    t.up({ pointerId: 2, clientX: 50, clientY: 0 });
    t.up({ pointerId: 1, clientX: 0, clientY: 0 });
    expect(t.wasDrag()).toBe(true);

    t.down({ pointerId: 3, pointerType: "touch", button: 0, clientX: 0, clientY: 0 });
    t.cancel();
    expect(t.wasDrag()).toBe(true);
    // and the next clean tap is a tap again
    t.down({ pointerId: 4, pointerType: "touch", button: 0, clientX: 0, clientY: 0 });
    t.up({ pointerId: 4, clientX: 0, clientY: 0 });
    expect(t.wasDrag()).toBe(false);
  });

  it("ignores non-primary buttons", () => {
    const t = createTapTracker();
    t.down({ pointerId: 1, pointerType: "mouse", button: 2, clientX: 0, clientY: 0 });
    t.move({ pointerId: 1, pointerType: "mouse", clientX: 99, clientY: 99 });
    expect(t.wasDrag()).toBe(false);
  });
});

describe("feedEngineMouse", () => {
  it("feeds every target's Mouse and survives drift / throws", () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error("boom");
    });
    const ev = new Event("pointerdown");
    expect(() =>
      feedEngineMouse(
        [{ mouse: { updateMouseInfo: a } }, { mouse: { updateMouseInfo: b } }, null, {}, { mouse: null }],
        ev,
      ),
    ).not.toThrow();
    expect(a).toHaveBeenCalledWith(ev);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

import { TOUCH_RAYCAST_RING_PX, touchProbeOffsets, withTouchTolerance } from "../../src/picking/pointerPick";

describe("touch raycast tolerance", () => {
  const vec = (x: number, y: number) => ({ x, y, clone: () => vec(x, y) });

  it("probes 8 points on a ring around the tap", () => {
    const o = touchProbeOffsets();
    expect(o).toHaveLength(8);
    for (const { dx, dy } of o) expect(Math.hypot(dx, dy)).toBeCloseTo(TOUCH_RAYCAST_RING_PX, 9);
  });

  it("returns an exact-point hit without probing", async () => {
    const raycast = vi.fn(async () => ({ localId: 1 }));
    const r = await withTouchTolerance({ raycast }).raycast({ mouse: vec(100, 100) });
    expect(r).toEqual({ localId: 1 });
    expect(raycast).toHaveBeenCalledTimes(1);
  });

  it("retries a miss around the tap and takes the first ring hit in priority order", async () => {
    const raycast = vi.fn(async (d: unknown) => {
      const m = (d as { mouse: { x: number; y: number } }).mouse;
      // geometry 10 px to the right and 10 px below of the tap only
      if (Math.abs(m.x - 110) < 1e-6 && Math.abs(m.y - 100) < 1e-6) return { localId: 7 };
      if (Math.abs(m.x - 100) < 1e-6 && Math.abs(m.y - 110) < 1e-6) return { localId: 8 };
      return null;
    });
    const r = await withTouchTolerance({ raycast }).raycast({ mouse: vec(100, 100), camera: "c" });
    expect(r).toEqual({ localId: 7 }); // +x probe has priority over +y
    expect(raycast).toHaveBeenCalledTimes(9);
  });

  it("stays a miss when nothing is near, and passes data without a mouse through", async () => {
    const raycast = vi.fn(async () => null);
    expect(await withTouchTolerance({ raycast }).raycast({ mouse: vec(1, 1) })).toBeNull();
    raycast.mockClear();
    expect(await withTouchTolerance({ raycast }).raycast({})).toBeNull();
    expect(raycast).toHaveBeenCalledTimes(1);
  });

  it("a rejection propagates (it is a fallback signal, never a miss)", async () => {
    const raycast = vi.fn(async () => {
      throw new Error("worker wedged");
    });
    await expect(withTouchTolerance({ raycast }).raycast({ mouse: vec(1, 1) })).rejects.toThrow("worker wedged");
  });
});
