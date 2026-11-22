// __tests__/level/LevelPlanController.camera.test.ts
//
// Wave 63: closing a level plan returns the camera to the 3D pose the
// user had when the plan opened (it used to jump to a fixed
// (10,10,10) → origin pose). Switching storey keeps that pose, and a
// failed open does not leave the camera stuck in ortho/Plan.

import { beforeEach, describe, expect, it, vi } from "vitest";

const classes = vi.hoisted(() => ({
  TechnicalDrawings: class {},
  EdgeProjector: class {},
  BoundingBoxer: class {},
}));

vi.mock("@thatopen/components", () => ({
  ...classes,
  Event: class {},
  BaseAnnotationStyle: class {},
  DrawingSystemDescriptor: class {},
  TechnicalDrawing: class {},
  AnnotationSystem: class {},
}));

import { createLevelPlanController } from "@ff/viewer";

interface StoreyMeta {
  name: string;
  elevation: number;
  height: number | null;
}

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  clone(): Vec {
    return new Vec(this.x, this.y, this.z);
  }
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

function setup(opts: { items?: boolean } = {}) {
  const lookAts: number[][] = [];
  const target = new Vec(1, 2, 3);
  const camPos = new Vec(40, 30, 20);
  const projection = {
    current: "Perspective",
    set: vi.fn(async (p: string) => {
      projection.current = p;
    }),
  };
  const camera = {
    three: { position: camPos },
    controls: {
      setLookAt: vi.fn((...a: number[]) => {
        lookAts.push(a.slice(0, 6));
        camPos.set(a[0]!, a[1]!, a[2]!);
        target.set(a[3]!, a[4]!, a[5]!);
      }),
      getTarget: (out: Vec) => out.set(target.x, target.y, target.z),
    },
    projection,
    mode: { id: "Orbit" },
    set: vi.fn(),
  };
  const drawing = {
    three: { position: new Vec(), visible: false },
    orientTo: vi.fn(),
    far: 0,
    layers: { create: vi.fn(), setColor: vi.fn() },
    addProjectionFromItems: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
  const measureSys = { sendMachineEvent: vi.fn(), disposeLabels: vi.fn() };
  const registry = new Map<unknown, unknown>([
    [classes.TechnicalDrawings, { use: () => measureSys, create: () => drawing }],
    [classes.EdgeProjector, {}],
    [
      classes.BoundingBoxer,
      {
        list: { clear: vi.fn() },
        addFromModelIdMap: vi.fn(async () => undefined),
        get: () => ({ min: new Vec(0, 0, 0), max: new Vec(10, 3, 10) }),
      },
    ],
  ]);
  const components = { get: (c: unknown) => registry.get(c) };
  const model = {
    modelId: "m",
    getItemsOfCategories: async () => (opts.items === false ? {} : { IFCWALL: [1] }),
  };
  const fragments = { core: { models: { list: new Map([["m", model]]) } } };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Like the engine's World: the `camera` getter THROWS once disposed.
  const dead = { value: false };
  const world = {
    get camera() {
      if (dead.value) throw new Error("No camera initialized!");
      return camera;
    },
  };
  const ctrl = createLevelPlanController(
    world as never,
    fragments as never,
    components as never,
  );
  const storeys: StoreyMeta[] = [
    { name: "L1", elevation: 0, height: 3 },
    { name: "L2", elevation: 3, height: 3 },
  ];
  (ctrl as unknown as { _setStoreys: (s: StoreyMeta[]) => void })._setStoreys(storeys);
  return { ctrl, lookAts, camera, projection, dead };
}

describe("LevelPlanController camera pose (wave 63)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("close() restores the pose saved on open, not (10,10,10)", async () => {
    const { ctrl, lookAts, projection } = setup();
    expect(await ctrl.open("L1")).toBe(true);
    expect(projection.current).toBe("Orthographic");
    ctrl.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(lookAts.at(-1)).toEqual([40, 30, 20, 1, 2, 3]);
    expect(projection.current).toBe("Perspective");
    expect(ctrl.activeStoreyName).toBeNull();
  });

  it("switching storey keeps the ORIGINAL 3D pose for close()", async () => {
    const { ctrl, lookAts } = setup();
    await ctrl.open("L1");
    await ctrl.open("L2");
    expect(ctrl.activeStoreyName).toBe("L2");
    ctrl.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(lookAts.at(-1)).toEqual([40, 30, 20, 1, 2, 3]);
  });

  it("a failed open restores the 3D pose (camera not stuck in ortho)", async () => {
    const { ctrl, lookAts, projection } = setup({ items: false });
    expect(await ctrl.open("L1")).toBe(false);
    await Promise.resolve();
    expect(projection.current).toBe("Perspective");
    expect(lookAts.at(-1)).toEqual([40, 30, 20, 1, 2, 3]);
  });

  it("close() without a saved pose falls back to the initial pose", () => {
    const { ctrl, lookAts } = setup();
    ctrl.close();
    expect(lookAts.at(-1)).toEqual([10, 10, 10, 0, 0, 0]);
  });

  it("wave 73: dispose() leaves the camera alone and nothing runs after the world is gone", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const { ctrl, lookAts, camera, projection, dead } = setup();
    expect(await ctrl.open("L1")).toBe(true);
    const callsBefore = lookAts.length;
    const setCallsBefore = projection.set.mock.calls.length;
    // The viewer's unmount: dispose the controller, then the engine drops the camera.
    ctrl.dispose();
    dead.value = true;
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(lookAts.length).toBe(callsBefore); // no pose restore on teardown
    expect(projection.set.mock.calls.length).toBe(setCallsBefore);
    expect(camera.set).not.toHaveBeenCalledWith("Orbit");
    expect(unhandled).toEqual([]);
    expect(() => ctrl.dispose()).not.toThrow(); // idempotent
    process.off("unhandledRejection", onUnhandled);
  });

  it("wave 73: a deferred pose re-apply that outlives the world is swallowed, not thrown", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const { ctrl, projection, dead } = setup();
    await ctrl.open("L1");
    let release: () => void = () => undefined;
    projection.set.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    ctrl.close(); // schedules apply() behind the projection switch
    dead.value = true; // the world is disposed before the switch resolves
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
  });
});
