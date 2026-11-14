import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";
import { installNavigationSpeedups } from "../../src/perf/navigationSpeedups";

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

function fakeEvent() {
  const hs = new Set<(d: unknown) => void>();
  return {
    hs,
    add: (h: (d: unknown) => void) => hs.add(h),
    remove: (h: (d: unknown) => void) => hs.delete(h),
    trigger: () => hs.forEach((h) => h(undefined)),
  };
}

/** A model with a `frozen` setter that records transitions, like FragmentsModel. */
function fakeModel(tiles: number) {
  const object = new THREE.Group();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < tiles; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    m.position.set(0, 0, -i);
    object.add(m);
  }
  object.updateMatrixWorld(true);
  const log: boolean[] = [];
  let frozen = false;
  return {
    object,
    log,
    get frozen() {
      return frozen;
    },
    set frozen(v: boolean) {
      frozen = v;
      log.push(v);
    },
  };
}

function setup(models: ReturnType<typeof fakeModel>[]) {
  const ctl = fakeControls();
  const before = fakeEvent();
  const after = fakeEvent();
  let ratio = 2;
  const three = {
    getPixelRatio: () => ratio,
    setPixelRatio: vi.fn((r: number) => {
      ratio = r;
    }),
    clippingPlanes: [] as THREE.Plane[],
  };
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.updateMatrixWorld(true);
  const refresh = vi.fn();
  const sp = installNavigationSpeedups({
    controls: ctl,
    renderer: { onBeforeUpdate: before, onAfterUpdate: after, three },
    getCamera: () => cam,
    getModels: () => models,
    refresh,
    budget: { min: 2, max: 2, initial: 2 },
    settleDelayMs: 0,
  });
  const renderFrame = (check?: () => void) => {
    before.trigger();
    check?.();
    after.trigger();
  };
  return { ctl, three, refresh, sp, renderFrame, ratio: () => ratio, before, after };
}

describe("installNavigationSpeedups", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("freezes the view, halves the pixel ratio and budgets tiles while moving; restores at rest", () => {
    const model = fakeModel(5);
    const { ctl, refresh, renderFrame, ratio } = setup([model]);

    ctl.emit("control");
    expect(model.frozen).toBe(true);
    expect(ratio()).toBe(1);

    renderFrame(() => {
      const visible = model.object.children.filter((c) => c.visible).length;
      expect(visible).toBe(2);
    });
    // outside the main render every tile is visible again
    expect(model.object.children.every((c) => c.visible)).toBe(true);

    ctl.emit("rest");
    expect(model.frozen).toBe(false);
    expect(ratio()).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);

    // at rest the main render draws everything
    renderFrame(() => {
      expect(model.object.children.every((c) => c.visible)).toBe(true);
    });
  });

  it("never unfreezes a model it did not freeze (loader-owned freeze)", () => {
    const loading = fakeModel(1);
    loading.frozen = true; // the engine freezes a model while it loads
    loading.log.length = 0;
    const { ctl } = setup([loading]);
    ctl.emit("control");
    ctl.emit("rest");
    expect(loading.log).toEqual([]);
    expect(loading.frozen).toBe(true);
  });

  it("freezes a model that finished loading mid-gesture, and unfreezes it at rest", () => {
    const a = fakeModel(1);
    const late = fakeModel(1);
    const models = [a];
    const { ctl, renderFrame } = setup(models);
    ctl.emit("control");
    models.push(late);
    renderFrame();
    expect(late.frozen).toBe(true);
    ctl.emit("rest");
    expect(late.frozen).toBe(false);
  });

  it("does not touch a model disposed during the gesture", () => {
    const a = fakeModel(1);
    const models = [a];
    const { ctl } = setup(models);
    ctl.emit("control");
    models.length = 0;
    a.log.length = 0;
    ctl.emit("rest");
    expect(a.log).toEqual([]);
  });

  it("a missed rest is recovered by the safety timer", () => {
    const model = fakeModel(3);
    const { ctl, ratio, refresh } = setup([model]);
    ctl.emit("control");
    vi.advanceTimersByTime(1000);
    expect(model.frozen).toBe(false);
    expect(ratio()).toBe(2);
    expect(refresh).toHaveBeenCalled();
  });

  it("forceRest() gives a full-quality frame immediately (snapshots)", () => {
    const model = fakeModel(5);
    const { ctl, sp, ratio, renderFrame } = setup([model]);
    ctl.emit("control");
    sp.forceRest();
    expect(ratio()).toBe(2);
    renderFrame(() => {
      expect(model.object.children.every((c) => c.visible)).toBe(true);
    });
  });

  it("dispose() restores state and unhooks the renderer events", () => {
    const model = fakeModel(5);
    const { ctl, sp, ratio, before, after } = setup([model]);
    ctl.emit("control");
    sp.dispose();
    expect(ratio()).toBe(2);
    expect(model.frozen).toBe(false);
    expect(before.hs.size).toBe(0);
    expect(after.hs.size).toBe(0);
    expect(Object.values(ctl.l).every((a) => a.length === 0)).toBe(true);
  });
});
