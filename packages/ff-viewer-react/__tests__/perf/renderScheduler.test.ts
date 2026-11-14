import { describe, expect, it, vi } from "vitest";
import {
  RenderScheduler,
  diffSignature,
  type ViewSignature,
} from "../../src/perf/renderScheduler";

function clock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RenderScheduler", () => {
  it("skips frames when nothing invalidated", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 0 });
    expect(s.frame()).toBeNull();
    expect(s.frame()).toBeNull();
    expect(s.stats.skipped).toBe(2);
    expect(s.stats.frames).toBe(2);
  });

  it("renders the frame after an invalidation and reports its reason", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 0 });
    s.invalidate("resize");
    expect(s.frame()).toBe("resize");
    expect(s.frame()).toBeNull();
    expect(s.stats.byReason.resize).toBe(1);
  });

  it("keeps rendering through the keep-alive window, then stops", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 300, keepAliveFrames: 0 });
    s.invalidate("highlight");
    expect(s.frame()).toBe("highlight");
    c.advance(16);
    expect(s.frame()).toBe("keepalive");
    c.advance(280);
    expect(s.frame()).toBe("keepalive");
    c.advance(10);
    expect(s.frame()).toBeNull();
  });

  it("keeps at least keepAliveFrames frames even when one frame outlasts the window", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 300, keepAliveFrames: 3 });
    s.invalidate("section");
    expect(s.frame()).toBe("section");
    c.advance(900); // e.g. a shader-compile frame for a new clipping plane
    expect(s.frame()).toBe("keepalive");
    expect(s.frame()).toBe("keepalive");
    expect(s.frame()).toBe("keepalive");
    expect(s.frame()).toBeNull();
  });

  it("a per-call keep-alive of 0 renders exactly one frame", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 300 });
    s.invalidate("camera-update", 0);
    expect(s.frame()).toBe("camera-update");
    c.advance(1);
    expect(s.frame()).toBeNull();
  });

  it("a shorter invalidation never shortens a longer open window", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 300 });
    s.invalidate("a");
    s.invalidate("b", 0);
    s.frame();
    c.advance(200);
    expect(s.frame()).toBe("keepalive");
  });

  it("renders continuously while a continuous source is active", () => {
    const c = clock();
    let reason: string | null = "moving";
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 0, continuous: () => reason });
    expect(s.frame()).toBe("moving");
    expect(s.frame()).toBe("moving");
    reason = null;
    expect(s.frame()).toBeNull();
  });

  it("fails safe (renders) when the continuous probe throws", () => {
    const s = new RenderScheduler({
      keepAliveMs: 0,
      continuous: () => {
        throw new Error("boom");
      },
    });
    expect(s.frame()).toBe("continuous-error");
  });

  it("calls onInvalidate synchronously (same-frame invalidation)", () => {
    const onInvalidate = vi.fn();
    const s = new RenderScheduler({ onInvalidate });
    s.invalidate("x");
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it("stale-frame guard: renders and reports a signature change nobody invalidated", () => {
    const c = clock();
    let sig: ViewSignature = { camera: 1, scene: 1 };
    const onStale = vi.fn();
    const s = new RenderScheduler({
      now: c.now,
      keepAliveMs: 0,
      signature: () => sig,
      onStale,
    });
    s.invalidate("install");
    expect(s.frame()).toBe("install");
    s.rendered(); // records {camera:1, scene:1}
    expect(s.frame()).toBeNull();
    sig = { camera: 1, scene: 2 }; // e.g. a mesh added without a requestRender
    expect(s.frame()).toBe("stale");
    expect(onStale).toHaveBeenCalledWith({ changed: ["scene"], count: 1 });
    s.rendered();
    expect(s.frame()).toBeNull();
    expect(s.stats.staleFrames).toBe(1);
  });

  it("does not report stale frames for changes that were invalidated", () => {
    const c = clock();
    let sig: ViewSignature = { camera: 1 };
    const onStale = vi.fn();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 0, signature: () => sig, onStale });
    s.invalidate("a");
    s.frame();
    s.rendered();
    sig = { camera: 2 };
    s.invalidate("camera-update", 0);
    expect(s.frame()).toBe("camera-update");
    s.rendered();
    expect(s.frame()).toBeNull();
    expect(onStale).not.toHaveBeenCalled();
  });

  it("heartbeat renders at most every heartbeatMs while idle", () => {
    const c = clock();
    const s = new RenderScheduler({ now: c.now, keepAliveMs: 0, heartbeatMs: 1000 });
    s.invalidate("a");
    s.frame();
    s.rendered();
    c.advance(500);
    expect(s.frame()).toBeNull();
    c.advance(500);
    expect(s.frame()).toBe("heartbeat");
    s.rendered();
    c.advance(10);
    expect(s.frame()).toBeNull();
  });

  it('"always" mode renders every frame (escape hatch)', () => {
    const s = new RenderScheduler({ mode: "always" });
    expect(s.frame()).toBe("always");
    expect(s.frame()).toBe("always");
    s.mode = "on-demand";
    expect(s.frame()).toBe("mode"); // switching invalidates once
  });

  it("counts renders", () => {
    const s = new RenderScheduler();
    s.rendered();
    s.rendered();
    expect(s.stats.renders).toBe(2);
  });
});

describe("diffSignature", () => {
  it("lists changed, added and removed parts", () => {
    expect(diffSignature({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 1 }).sort()).toEqual(["b", "c", "d"]);
  });
});
