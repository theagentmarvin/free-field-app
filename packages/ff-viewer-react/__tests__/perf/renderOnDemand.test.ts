import { describe, expect, it, vi } from "vitest";
import {
  installRenderOnDemand,
  wrapHandleForInvalidation,
  type RodModel,
} from "../../src/perf/renderOnDemand";

function fakeEvent() {
  const hs = new Set<(d: unknown) => void>();
  return {
    hs,
    add: (h: (d: unknown) => void) => void hs.add(h),
    remove: (h: (d: unknown) => void) => void hs.delete(h),
    trigger: (d?: unknown) => hs.forEach((h) => h(d)),
  };
}

function fakeControls() {
  const l: Record<string, Array<() => void>> = {};
  return {
    l,
    addEventListener(type: string, cb: () => void) {
      (l[type] ??= []).push(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      const a = l[type];
      if (a) a.splice(a.indexOf(cb), 1);
    },
    emit(type: string) {
      for (const cb of [...(l[type] ?? [])]) cb();
    },
  };
}

/** Engine-shaped world: a frame = onBeforeUpdate, camera.update, renderer.update. */
function setup(
  opts: {
    models?: RodModel[];
    continuous?: () => string | null;
    mode?: "on-demand" | "always";
    streamRenderIntervalMs?: number;
    streamThrottle?: () => boolean;
  } = {},
) {
  let t = 0;
  const now = () => t;
  const frameEvent = fakeEvent();
  const renderer = {
    mode: 1,
    needsUpdate: false,
    enabled: true,
    onAfterUpdate: fakeEvent(),
    onResize: fakeEvent(),
    onClippingPlanesUpdated: fakeEvent(),
    three: { domElement: document.createElement("canvas") },
  };
  const controls = fakeControls();
  const scene = new EventTarget() as EventTarget & { children: { visible?: boolean }[] };
  scene.children = [];
  const container = document.createElement("div");
  const camera = { position: { x: 0, y: 0, z: 10 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
  const models = opts.models ?? [];
  const onStale = vi.fn();
  let renders = 0;
  const rod = installRenderOnDemand({
    renderer,
    frameEvent,
    controls,
    getCamera: () => camera,
    getScene: () => scene,
    inputTarget: container,
    getModels: () => models,
    continuous: opts.continuous,
    mode: opts.mode,
    manualMode: 0,
    autoMode: 1,
    keepAliveMs: 100,
    now,
    onStale,
    streamRenderIntervalMs: opts.streamRenderIntervalMs,
    streamThrottle: opts.streamThrottle,
  });
  // One animation frame of the OBC loop (SimpleWorld.update order).
  const frame = (cameraStep?: () => void): boolean => {
    t += 16;
    frameEvent.trigger();
    cameraStep?.();
    if (!renderer.enabled) return false;
    if (renderer.mode === 0 && !renderer.needsUpdate) return false;
    renderer.needsUpdate = false;
    renders++;
    renderer.onAfterUpdate.trigger();
    return true;
  };
  const settle = (n = 20) => {
    for (let i = 0; i < n; i++) frame();
  };
  return {
    rod,
    renderer,
    controls,
    scene,
    container,
    camera,
    frame,
    settle,
    onStale,
    advance: (ms: number) => {
      t += ms;
    },
    get renders() {
      return renders;
    },
  };
}

describe("installRenderOnDemand", () => {
  it("puts the renderer in MANUAL mode and stops rendering once idle", () => {
    const s = setup();
    expect(s.renderer.mode).toBe(0);
    s.settle();
    const before = s.renders;
    s.settle(30);
    expect(s.renders).toBe(before);
  });

  it("camera 'update' renders in the SAME frame it was emitted", () => {
    const s = setup();
    s.settle();
    const rendered = s.frame(() => {
      s.camera.position.x = 1;
      s.controls.emit("update");
    });
    expect(rendered).toBe(true);
  });

  it("damping tail: renders every frame the camera keeps updating, then stops", () => {
    const s = setup();
    s.settle();
    for (let i = 0; i < 10; i++) {
      expect(
        s.frame(() => {
          s.camera.position.x += 0.1;
          s.controls.emit("update");
        }),
      ).toBe(true);
    }
    s.frame(() => s.controls.emit("rest"));
    s.settle();
    const n = s.renders;
    s.settle(10);
    expect(s.renders).toBe(n);
  });

  it.each([
    ["resize", (s: ReturnType<typeof setup>) => s.renderer.onResize.trigger()],
    ["clipping", (s: ReturnType<typeof setup>) => s.renderer.onClippingPlanesUpdated.trigger()],
    ["scene child", (s: ReturnType<typeof setup>) => s.scene.dispatchEvent(new Event("childadded"))],
    ["pointer input", (s: ReturnType<typeof setup>) => s.container.dispatchEvent(new Event("pointermove"))],
    ["wheel", (s: ReturnType<typeof setup>) => s.container.dispatchEvent(new Event("wheel"))],
    ["context restore", (s: ReturnType<typeof setup>) =>
      s.renderer.three.domElement.dispatchEvent(new Event("webglcontextrestored"))],
    ["external", (s: ReturnType<typeof setup>) => s.rod.invalidate("test")],
  ])("invalidates on %s", (_name, fire) => {
    const s = setup();
    s.settle();
    const n = s.renders;
    fire(s);
    expect(s.frame()).toBe(true);
    expect(s.renders).toBe(n + 1);
  });

  it("keeps rendering for the keep-alive window after an invalidation", () => {
    const s = setup();
    s.settle();
    s.rod.invalidate("x");
    let count = 0;
    for (let i = 0; i < 20; i++) if (s.frame()) count++;
    // 100 ms window at 16 ms frames ≈ 6-7 frames, then idle.
    expect(count).toBeGreaterThanOrEqual(6);
    expect(count).toBeLessThanOrEqual(8);
  });

  it("renders continuously while a viewer continuous source is active", () => {
    let moving: string | null = "moving";
    const s = setup({ continuous: () => moving });
    for (let i = 0; i < 10; i++) expect(s.frame()).toBe(true);
    moving = null;
    s.settle();
    const n = s.renders;
    s.settle(5);
    expect(s.renders).toBe(n);
  });

  it("renders while a model is busy, plus a burst after it settles", () => {
    const model: RodModel = { isBusy: true, tiles: { size: 0 } };
    const s = setup({ models: [model] });
    for (let i = 0; i < 10; i++) expect(s.frame()).toBe(true);
    model.isBusy = false;
    s.frame();
    expect(s.frame()).toBe(true); // busy-end invalidation
    s.settle();
    const n = s.renders;
    s.settle(5);
    expect(s.renders).toBe(n);
  });

  it("fragments: every applied tile request invalidates (MeshManager seam)", () => {
    const s = setup();
    const onUpdate = vi.fn();
    const core = {
      onModelLoaded: fakeEvent(),
      models: { _onUpdate: onUpdate, list: new Map() },
    };
    const list = { onItemSet: fakeEvent(), onItemDeleted: fakeEvent() };
    s.rod.watchFragments({ core, list });
    s.settle();
    const n = s.renders;
    (core.models._onUpdate as () => void)();
    expect(onUpdate).toHaveBeenCalledTimes(1); // original still runs
    expect(s.frame()).toBe(true);
    s.settle();
    const m = s.renders;
    list.onItemDeleted.trigger("model-a");
    expect(s.frame()).toBe(true);
    s.settle();
    core.onModelLoaded.trigger();
    expect(s.frame()).toBe(true);
    expect(s.renders).toBeGreaterThan(m);
    expect(n).toBeGreaterThan(0);
  });

  describe("stream throttle (wave 61)", () => {
    const fragsWith = (onUpdate: () => void, models: RodModel[]) => ({
      core: { onModelLoaded: fakeEvent(), models: { _onUpdate: onUpdate, list: new Map() } },
      list: { onItemSet: fakeEvent(), onItemDeleted: fakeEvent() },
      models,
    });

    it("while a load streams and nobody interacts, tile-driven renders run at most once per interval", () => {
      const model: RodModel = { isBusy: true, tiles: { size: 0 } };
      let streaming = true;
      const s = setup({ models: [model], streamRenderIntervalMs: 100, streamThrottle: () => streaming });
      const f = fragsWith(() => undefined, [model]);
      s.rod.watchFragments(f);
      s.advance(2000); // past the input grace window
      s.settle(3);
      const n0 = s.renders;
      // 30 frames of 16 ms (~480 ms), a tile applied before every frame.
      for (let i = 0; i < 30; i++) {
        model.tiles!.size! += 1;
        (f.core.models._onUpdate as () => void)();
        s.frame();
      }
      const throttled = s.renders - n0;
      expect(throttled).toBeGreaterThanOrEqual(4);
      expect(throttled).toBeLessThanOrEqual(6);
      // The deferred tiles are not reported as a missed invalidation.
      expect(s.onStale).not.toHaveBeenCalled();
      // Streaming over: back to a render per applied tile.
      streaming = false;
      const n1 = s.renders;
      for (let i = 0; i < 10; i++) {
        (f.core.models._onUpdate as () => void)();
        s.frame();
      }
      expect(s.renders - n1).toBe(10);
    });

    it("user input lifts the throttle at once (clicks / hover tints render immediately)", () => {
      const model: RodModel = { isBusy: true, tiles: { size: 0 } };
      const s = setup({ models: [model], streamRenderIntervalMs: 100, streamThrottle: () => true });
      const f = fragsWith(() => undefined, [model]);
      s.rod.watchFragments(f);
      s.advance(2000);
      s.settle(3);
      s.container.dispatchEvent(new Event("pointerdown"));
      const n = s.renders;
      for (let i = 0; i < 10; i++) {
        (f.core.models._onUpdate as () => void)();
        s.frame();
      }
      expect(s.renders - n).toBe(10);
    });

    it("an owed render is never dropped", () => {
      const model: RodModel = { isBusy: false, tiles: { size: 0 } };
      const s = setup({ models: [model], streamRenderIntervalMs: 100, streamThrottle: () => true });
      const f = fragsWith(() => undefined, [model]);
      s.rod.watchFragments(f);
      s.advance(2000);
      s.settle(10);
      model.tiles!.size = 5;
      (f.core.models._onUpdate as () => void)(); // last tile of the stream
      const n = s.renders;
      s.settle(10); // 160 ms > interval
      expect(s.renders - n).toBeGreaterThanOrEqual(1);
      expect(s.onStale).not.toHaveBeenCalled();
    });

    it("off by default (no interval): every applied tile renders", () => {
      const model: RodModel = { isBusy: true, tiles: { size: 0 } };
      const s = setup({ models: [model], streamThrottle: () => true });
      const f = fragsWith(() => undefined, [model]);
      s.rod.watchFragments(f);
      s.advance(2000);
      s.settle(3);
      const n = s.renders;
      for (let i = 0; i < 10; i++) {
        (f.core.models._onUpdate as () => void)();
        s.frame();
      }
      expect(s.renders - n).toBe(10);
    });
  });

  it("busy stall cap: a model stuck busy with no tile activity stops pinning the loop", () => {
    const model: RodModel = { isBusy: true };
    const s = setup({ models: [model] });
    s.rod.watchFragments({ core: { models: { _onUpdate: () => undefined } } });
    for (let i = 0; i < 5; i++) expect(s.frame()).toBe(true);
    s.advance(5000); // > busyStallMs (2000) without any tile applied
    s.settle();
    const n = s.renders;
    s.settle(10);
    expect(s.renders).toBe(n);
  });

  it("stale-frame guard: renders and reports a camera change nobody announced", () => {
    const s = setup();
    s.settle();
    s.camera.position.z = 42; // moved behind our back
    expect(s.frame()).toBe(true);
    expect(s.onStale).toHaveBeenCalledWith(
      expect.objectContaining({ changed: ["camera"] }),
    );
  });

  it("paused renderer: no decisions, and resume via invalidate draws again", () => {
    const s = setup();
    s.settle();
    s.renderer.enabled = false;
    s.camera.position.z = 5;
    s.settle(5);
    expect(s.onStale).not.toHaveBeenCalled();
    s.renderer.enabled = true;
    s.rod.invalidate("resume");
    expect(s.frame()).toBe(true);
  });

  it('"always" mode leaves the renderer in AUTO', () => {
    const s = setup({ mode: "always" });
    expect(s.renderer.mode).toBe(1);
    s.rod.setMode("on-demand");
    expect(s.renderer.mode).toBe(0);
  });

  it("dispose detaches every source and restores AUTO", () => {
    const s = setup();
    const onUpdate = vi.fn();
    const core = { models: { _onUpdate: onUpdate } };
    s.rod.watchFragments({ core });
    s.rod.dispose();
    expect(s.renderer.mode).toBe(1);
    expect(core.models._onUpdate).toBe(onUpdate);
    expect(Object.values(s.controls.l).every((a) => a.length === 0)).toBe(true);
    expect(s.renderer.onResize.hs.size).toBe(0);
  });
});

describe("wrapHandleForInvalidation", () => {
  it("invalidates around mutating methods and on async settle; leaves readers alone", async () => {
    const inv = vi.fn();
    let resolve!: () => void;
    const handle = {
      get loadedModelIds() {
        return new Set(["a"]);
      },
      setElementVisibility: vi.fn(),
      openLevel: vi.fn(() => new Promise<void>((r) => (resolve = r))),
      getViewportRevision: vi.fn(() => 1),
      worldToScreen: vi.fn(),
      isMeasureInProgress: vi.fn(() => false),
      onSelectionChange: vi.fn(),
      pickWorldPoint: vi.fn(),
      setOnElementPick: vi.fn(),
    };
    const w = wrapHandleForInvalidation(handle, inv);
    expect(w.loadedModelIds.has("a")).toBe(true);
    w.getViewportRevision();
    w.worldToScreen();
    w.isMeasureInProgress();
    w.onSelectionChange();
    w.pickWorldPoint();
    w.setOnElementPick();
    expect(inv).not.toHaveBeenCalled();
    w.setElementVisibility();
    expect(handle.setElementVisibility).toHaveBeenCalled();
    expect(inv).toHaveBeenCalledWith("handle:setElementVisibility");
    inv.mockClear();
    const p = w.openLevel();
    expect(inv).toHaveBeenCalledTimes(2);
    resolve();
    await p;
    await Promise.resolve();
    expect(inv).toHaveBeenCalledTimes(3);
  });

  it("still invalidates when the wrapped method throws", () => {
    const inv = vi.fn();
    const w = wrapHandleForInvalidation(
      {
        boom: () => {
          throw new Error("x");
        },
      },
      inv,
    );
    expect(() => w.boom()).toThrow("x");
    expect(inv).toHaveBeenCalledTimes(2);
  });
});
