// __tests__/viewer/IfcViewer.test.tsx
//
// Minimal smoke tests for the IfcViewerHandle shape. The full
// TechnicalDrawings + EdgeProjector lifecycle needs a real WebGL
// canvas; that's a hand-test in the smoke plan, not a unit test.
// What we CAN test in jsdom is the handle's defensive no-op paths:
// the viewer mounted but no IFC loaded.
//
// We mock the heavy OBC components stack so the IfcViewer's
// mount effect runs without touching the network or instantiating
// a WebGL renderer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef, StrictMode } from "react";
import { resetFragmentsWorkerCache } from "../src/worker/fragmentsWorkerUrl";
// Wave 56-demo: the full-screen loading overlay is once-per-session;
// re-arm it before every loading-gate test so prior mounts in this
// file don't suppress the overlay under test.
import { __resetViewerSessionLoadedFlag } from "../src/IfcViewer";
import { ensureViewerTelemetry } from "../src/telemetry/viewerTelemetry";
import { fireEvent, render, waitFor } from "@testing-library/react";
// Wave 33: pin the full-geometry LOD call by importing the same (stubbed)
// enum the viewer imports at module scope. The real @thatopen/fragments
// bundle is stubbed in __tests__/setup.ts to keep jsdom hermetic.
import { LodMode } from "@thatopen/fragments";

const h = vi.hoisted(() => {
  const eventStub = () => ({
    add: () => undefined,
    delete: () => undefined,
  });

  const worldMock = {
    name: "",
    scene: {
      setup: () => undefined,
      three: { add: () => undefined, remove: () => undefined },
    },
    renderer: {
      onBeforeUpdate: eventStub(),
      onAfterUpdate: eventStub(),
      three: { setClearColor: () => undefined },
    },
    camera: {
      controls: {
        setLookAt: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        // Task 18's setActiveTool toggles these on the
        // camera-controls instance; the mock must define them
        // or the cast to `{ mouseButtons: { ... } }` throws at
        // runtime in the closeLevel / openLevel paths.
        enabled: false,
        mouseButtons: { left: 1, middle: 2, right: 0, wheel: 4 },
      },
      three: { position: { x: 0, y: 0, z: 0, constructor: Object } },
    },
    _components: undefined as unknown,
  };

  const fragmentsMock = {
    init: () => undefined,
    dispose: async () => undefined,
    // Wave 24: manager-level targeted coloring ops (fast backend
    // bypasses the Highlighter and calls these directly).
    highlight: vi.fn(async () => undefined),
    resetHighlight: vi.fn(async () => undefined),
    // Wave 45: worker virtual raycast. ABSENT by default (`undefined`)
    // so the legacy id-pass pick tests stay authoritative; the wave-45
    // tests assign a mock impl to drive the raycast-primary path.
    raycast: undefined as unknown,
    core: {
      // Wave 31: spies, so the version hot-swap tests can assert that
      // a replace disposes the old model and re-loads the new bytes.
      // Wave 33: each loaded model carries a `setLodMode` spy so the
      // full-geometry-per-model tests can assert the LOD call lands per
      // load (and per version-swap re-load).
      load: vi.fn(async () => ({
        object: {},
        setLodMode: vi.fn(async () => undefined),
      })),
      update: vi.fn(async () => undefined),
      disposeModel: vi.fn(async () => undefined),
      // Task 24: the model registry. The real
      // `fragments.core.models.list` is a DataMap (a Map), so the
      // mock mirrors that shape — `resetCameraToDefault` walks it
      // to compute the combined bounding box of the loaded
      // models.
      models: {
        list: new Map<
          string,
          {
            box?: {
              min: { x: number; y: number; z: number };
              max: { x: number; y: number; z: number };
            };
          }
        >(),
      },
    },
  };

  const worldsMock = { create: () => worldMock };

  class ComponentsMock {
    // Wave 15: memoized Clipper singleton (engine caches by uuid).
    clipper: unknown = null;
    get(_cls: unknown): unknown {
      if (_cls === (WorldsClass as unknown)) return worldsMock;
      if (_cls === (FragmentsManagerClass as unknown)) return fragmentsMock;
      if (_cls === (TechnicalDrawingsClass as unknown)) return techDrawingsMock;
      if (_cls === (EdgeProjectorClass as unknown)) return edgeProjectorMock;
      if (_cls === (ClassifierClass as unknown)) return {};
      if (_cls === (BoundingBoxerClass as unknown)) return {};
      if (_cls === (SimpleSceneClass as unknown)) return worldMock.scene;
      if (_cls === (SimpleCameraClass as unknown)) return worldMock.camera;
      if (_cls === (SimpleRendererClass as unknown)) return worldMock.renderer;
      if (_cls === (RaycastersClass as unknown)) {
        return new (RaycastersClass as unknown as new () => unknown)();
      }
      // Wave 14: the pick seam resolves `OBC.FastModelPickers` at
      // mount. Matching by class reference, same as Raycasters.
      if (_cls === (FastModelPickersClass as unknown)) {
        return new (FastModelPickersClass as unknown as new () => unknown)();
      }
      // Wave 15: memoize the Clipper singleton (engine caches by
      // uuid) — addSectionPlane + clearSectionPlanes / flipLast must
      // share the same `list`, or the clear regression test would lie.
      if (_cls === (ClipperClass as unknown)) {
        if (this.clipper === null) {
          this.clipper = new (ClipperClass as unknown as new () => unknown)();
        }
        return this.clipper;
      }
      // Wave 13: ClipStyler (components-front). Fresh instance is fine
      // — the source caches `clipStylerRef` after the first get.
      if (_cls === (ClipStylerClass as unknown)) {
        return new (ClipStylerClass as unknown as new () => unknown)();
      }
      if (_cls === (HiderClass as unknown)) {
        return new (HiderClass as unknown as new () => unknown)();
      }
      // Wave 12: the OBCF measurement components + the core
      // SnapResolvers. Matched by class reference (source resolves
      // via `OBCF.LengthMeasurement` etc. and `OBC.SnapResolvers`).
      if (_cls === (LengthMeasurementClass as unknown)) {
        return new (LengthMeasurementClass as unknown as new () => unknown)();
      }
      if (_cls === (AreaMeasurementClass as unknown)) {
        return new (AreaMeasurementClass as unknown as new () => unknown)();
      }
      if (_cls === (AngleMeasurementClass as unknown)) {
        return new (AngleMeasurementClass as unknown as new () => unknown)();
      }
      if (_cls === (VolumeMeasurementClass as unknown)) {
        return new (VolumeMeasurementClass as unknown as new () => unknown)();
      }
      if (_cls === (SnapResolversClass as unknown)) {
        return new (SnapResolversClass as unknown as new () => unknown)();
      }
      // Task 21: OBCF.Highlighter instance. Constructed via
      // `new h.HighlighterClass()` so the spies (`setup`,
      // `highlightByID`, `clear`, `dispose`) live on the
      // instance — IfcViewer mutates `multiple` and reads
      // `events` on the same instance. We return a fresh
      // instance per get() call because Components caches by
      // class uuid, but the IfcViewer test path doesn't depend
      // on identity continuity.
      if (_cls === (HighlighterClass as unknown)) {
        return new (HighlighterClass as unknown as new () => unknown)();
      }
      return {};
    }
    init() {
      worldMock._components = this;
      return undefined;
    }
    dispose() {
      return undefined;
    }
  }

  // Task 16: TechnicalDrawings + EdgeProjector mocks
  const techDrawingsMock = {
    list: { onItemSet: eventStub(), onItemDeleted: eventStub() },
    create: vi.fn(() => ({
      uuid: "draw-1",
      three: {
        position: { set: () => undefined, constructor: Object },
        visible: true,
        children: [],
        add: () => undefined,
        remove: () => undefined,
      },
      dispose: vi.fn(),
      orientTo: vi.fn(),
      far: 10,
      layers: {
        create: vi.fn(),
        setColor: vi.fn(),
        get: () => ({ material: undefined }),
        assign: vi.fn(),
      },
      addProjectionFromItems: vi.fn(async () => undefined),
      addProjectionLines: vi.fn(),
      viewports: { create: vi.fn() },
    })),
  };
  const edgeProjectorMock = { enabled: true };

  class WorldsClass {
    static uuid = "mock-worlds";
  }
  class FragmentsManagerClass {
    static uuid = "mock-fragments";
  }
  class TechnicalDrawingsClass {
    static uuid = "mock-tech-drawings";
  }
  class EdgeProjectorClass {
    static uuid = "mock-edge-projector";
  }
  // Task 21: OBCF Highlighter. The class itself is exported as
  // `OBCF.Highlighter` from the @thatopen/components-front mock,
  // AND `components.get(HighlighterClass)` returns an instance
  // from the @thatopen/components mock — both must reference the
  // SAME class (components matches by class reference). This
  // declaration is the single source of truth.
  class HighlighterClass {
    static uuid = "mock-obcf-highlighter";
    multiple: "none" | "shiftKey" | "ctrlKey" = "none";
    isSetup = false;
    events: {
      select: {
        onHighlight: { add: (...args: unknown[]) => void; remove: (...args: unknown[]) => void; __fns: Array<(map: Record<string, Set<number>>) => void> };
        onClear: { add: (...args: unknown[]) => void; remove: (...args: unknown[]) => void; __fns: Array<(map: Record<string, Set<number>>) => void> };
      };
    };
    setup!: (cfg?: unknown) => void;
    highlightByID!: (
      name: string,
      modelIdMap: Record<string, Set<number>>,
      removePrevious?: boolean,
      zoomToSelection?: boolean,
      exclude?: unknown,
    ) => Promise<void>;
    highlight!: (name: string, removePrevious?: boolean, zoomToSelection?: boolean, exclude?: unknown) => Promise<void>;
    clear!: (name?: string) => Promise<void>;
    dispose!: () => Promise<void>;
    constructor() {
      // Wave 21: `add` used to swallow the mirror handlers — tests
      // now drive `events.select.onClear.__fns` to replay the
      // Highlighter's async replace sequence (the stale clear that
      // wiped the wave-20 click-point stash).
      const eventList = () => {
        const fns: Array<(map: Record<string, Set<number>>) => void> = [];
        return {
          __fns: fns,
          add: (fn: unknown) => {
            fns.push(fn as (map: Record<string, Set<number>>) => void);
          },
          remove: (fn: unknown) => {
            const i = fns.indexOf(fn as (map: Record<string, Set<number>>) => void);
            if (i >= 0) fns.splice(i, 1);
          },
        };
      };
      this.events = {
        select: {
          onHighlight: eventList(),
          onClear: eventList(),
        },
      };
      this.setup = vi.fn((_cfg?: unknown) => {
        this.isSetup = true;
      });
      this.highlightByID = vi.fn(
        async (
          _name: string,
          _modelIdMap: Record<string, Set<number>>,
          _removePrevious?: boolean,
          _zoomToSelection?: boolean,
          _exclude?: unknown,
        ) => undefined,
      );
      this.highlight = vi.fn(async () => undefined);
      this.clear = vi.fn(async (_name?: string) => undefined);
      this.dispose = vi.fn(async () => undefined);
      highlighterInstances.push(this);
    }
  }
  // Wave 21: registry so tests can reach the instance the mount
  // wired its mirror handlers onto (same pattern as cameraInstances).
  const highlighterInstances: HighlighterClass[] = [];
  class ClassifierClass {
    static uuid = "mock-classifier";
  }
  class BoundingBoxerClass {
    static uuid = "mock-bounding-boxer";
  }
  class SimpleSceneClass {
    static uuid = "mock-scene";
    setup() {
      return undefined;
    }
    three = { add: () => undefined, remove: () => undefined };
  }
  class SimpleCameraClass {
    static uuid = "mock-camera";
    controls = {
      setLookAt: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    three = { position: { x: 0, y: 0, z: 0, constructor: Object } };
  }
  // Task 24: the mount effect builds the camera with
  // `new OBC.OrthoPerspectiveCamera(components)`. We keep a
  // registry of the created instances so the tests can inspect
  // (and spy on) the camera-controls surface — `setLookAt` and
  // the mouse-button bindings.
  const cameraInstances: OrthoPerspectiveCameraClass[] = [];

  // Wave 32: camera event handlers the mock records, keyed by event type.
  const cameraControlListeners: Record<string, Array<() => void>> = {};

  // OrthoPerspectiveCamera extends SimpleCamera — same controls +
  // three, plus a projection manager and a navigation mode registry.
  // Task 16b uses it for the level view's flat ortho plan rendering.
  class OrthoPerspectiveCameraClass {
    static uuid = "mock-ortho-perspective-camera";
    // Tasks-module pose tests: `getTarget(out)` fills the scratch
    // vector from this state, mirroring camera-controls' surface.
    lookTarget = { x: 0, y: 0, z: 0 };
    controls = {
      // The `setLookAt` mock takes the camera-controls argument
      // list so the Task 24 tests can assert on the eye/target
      // the viewer asked for.
      // Wave 31: a vi.fn so the FIRST load's framing call is recorded
      // even when the test only starts looking after the mount.
      setLookAt: vi.fn((..._args: number[]) => undefined),
      // Mirrors camera-controls 3.1.2: only a real `Vector3`
      // (`isVector3`) receives the target; anything else is ignored.
      getTarget: (out: { x: number; y: number; z: number; isVector3?: boolean }) => {
        if (!out?.isVector3) return out;
        out.x = this.lookTarget.x;
        out.y = this.lookTarget.y;
        out.z = this.lookTarget.z;
      },
      // Wave 32: record camera handlers in a closure-side table so a test
      // can fire camera events and assert the fragments view refresh is
      // wired to them. (This is the *real* `world.camera.controls` the
      // component reads, not the `worldMock.camera.controls` sibling.)
      addEventListener: (type: string, cb: () => void) => {
        const list = cameraControlListeners[type] ?? [];
        list.push(cb);
        cameraControlListeners[type] = list;
      },
      removeEventListener: (type: string, cb: () => void) => {
        const list = cameraControlListeners[type];
        if (!list) return;
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      },
      // Task 18's setActiveTool toggles these on the
      // camera-controls instance; the IfcViewer assigns
      // `world.camera = new OBC.OrthoPerspectiveCamera(...)`
      // so this is the *real* `world.camera.controls` the
      // component reads, NOT the `worldMock.camera.controls`
      // sibling.
      enabled: false,
      mouseButtons: { left: 1, middle: 2, right: 0, wheel: 4 },
    };
    three = {
      position: { x: 0, y: 0, z: 0, constructor: Object },
      fov: 45,
      type: "PerspectiveCamera",
      updateProjectionMatrix: () => undefined,
    };
    threeOrtho = { left: 0, right: 0, top: 0, bottom: 0, updateProjectionMatrix: () => undefined };
    threePersp = {};
    // Navigation speedups: the viewer subscribes to projection changes
    // (camera.three swap) to re-point the fragments models' camera.
    projectionHandlers = new Set<(c: unknown) => void>();
    projection = {
      current: "Perspective",
      set: async () => undefined,
      onChanged: {
        add: (fn: (c: unknown) => void) => this.projectionHandlers.add(fn),
        remove: (fn: (c: unknown) => void) => this.projectionHandlers.delete(fn),
      },
    };
    mode = { id: "Orbit" };
    set(_mode: string) {
      return undefined;
    }
    async fit(_meshes: Iterable<unknown>, _offset?: number) {
      return undefined;
    }
    setUserInput(_active: boolean) {
      return undefined;
    }
    constructor() {
      cameraInstances.push(this);
    }
  }
  // Wave 19: the canvas surface the viewer-owned click pipeline
  // attaches to. jsdom has no real WebGL canvas here, so this double
  // stores registered listeners in a Map — tests retrieve and invoke
  // the click handler to simulate a pick on model #2.
  const canvasListeners = new Map<string, Array<(ev: unknown) => void>>();
  const rendererDomElement = {
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = canvasListeners.get(type);
      if (list) list.push(fn);
      else canvasListeners.set(type, [fn]);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const list = canvasListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      };
    },
    style: {},
  };
    // Wave 30: registry of renderer doubles so tests can reach
  // `world.renderer.three` (the object `canvasCssBox` asks for `getSize`).
  const rendererInstances: SimpleRendererClass[] = [];

  class SimpleRendererClass {
    static uuid = "mock-renderer";
    onBeforeUpdate = eventStub();
    onAfterUpdate = eventStub();
    // The IfcViewer mount effect overrides the renderer's clear
    // color (`world.renderer.three.setClearColor(...)`) right
    // after components.init(). Without a `three` member the
    // mount effect throws and the whole suite fails.
    //
    // Wave 19: `domElement` gives the viewer-owned click pipeline a
    // canvas to attach to (store-the-listener test double).
    three = { setClearColor: () => undefined, domElement: rendererDomElement };
    constructor() {
      rendererInstances.push(this);
    }
  }
  // Wave 67: RendererWith2D = SimpleRenderer + a CSS2DRenderer layer.
  class RendererWith2DClass extends SimpleRendererClass {
    three2D = { render: () => undefined, domElement: { classList: { add: () => undefined } } };
  }
  // Task 21: the mount effect pre-warms the raycaster with
  // `components.get(OBC.Raycasters).get(world)` before the
  // Highlighter is set up. Without a `get()` member on the
  // instance the mount IIFE throws and the LevelPlanController
  // is never created.
  //
  // Wave 14: the returned caster now carries a `castRay` stub so the
  // fallback pick path (`pickWorldPointRaycast`) has a deterministic
  // `null` result in jsdom (no WebGL → no real raycast).
  class RaycastersClass {
    static uuid = "mock-raycasters";
    get(_world: unknown): {
      castRay: () => Promise<{ point?: { x: number; y: number; z: number } } | null>;
    } {
      return { castRay: async () => null };
    }
  }
  // ── Wave 14: FastModelPicker backmocks ───────────────────────
  // `fastPickerState.failInit` forces the fallback path (FastModelPickers
  // constructor throws); `fastPickerState.point` is the seeded world-space
  // point `getPointAt` returns so the fast path has a deterministic
  // `{x, y, z}` result shape in jsdom.
  const fastPickerState = {
    failInit: false,
    point: null as { x: number; y: number; z: number } | null,
    normal: null as { x: number; y: number; z: number } | null,
  };
  const fastPickerInstance = {
    getPointAt: vi.fn(
      async (_position?: { x: number; y: number }) => fastPickerState.point,
    ),
    getNormalAt: vi.fn(
      async (_position?: { x: number; y: number }) => fastPickerState.normal,
    ),
    getItemAt: vi.fn(async () => null),
    getFullPick: vi.fn(async () => null),
    dispose: vi.fn(),
  };
  class FastModelPickerClass {
    static uuid = "mock-fast-model-picker";
  }
  class FastModelPickersClass {
    static uuid = "mock-fast-model-pickers";
    get(_world: unknown) {
      if (fastPickerState.failInit) {
        throw new Error("mock: FastModelPicker init failed (no renderer)");
      }
      return fastPickerInstance;
    }
  }
  // Task 23.1 + Wave 15: the Clipper drives both the floor clip plane
  // and the 3D section planes. The mock models the REAL engine
  // contract so the Wave 15 regression test is honest:
  //   - `createFromNormalAndCoplanarPoint` returns an id and registers
  //     a plane object in `list` (keyed by id) with `type: undefined`
  //     (this creation path never assigns a `type`).
  //   - `deleteAll(types)` filters by `plane.type` (NOT by id) — the
  //     exact behavior that made the old id-based `deleteAll` a silent
  //     no-op.
  //   - `list.delete(id)` removes by id — the canonical path the fix
  //     now uses (the engine's onBeforeDelete cascade runs off it).
  // The engine caches the Clipper by uuid, so `components.get` must
  // return a SHARED instance within a mount — otherwise an add + clear
  // would hit two different `list`s and the test would lie.
  const clipperInstances: Array<Record<string, any>> = [];
  class ClipperClass {
    static uuid = "mock-clipper";
    enabled = false;
    config = { color: null as unknown, opacity: 0 };
    list = new Map<
      string,
      { type?: string; three: { normal: { x: number; y: number; z: number } } }
    >();
    private _id = 0;
    createFromNormalAndCoplanarPoint(
      _world: unknown,
      normal: { x: number; y: number; z: number },
      _point: { x: number; y: number; z: number },
    ): string {
      const id = `plane-${++this._id}`;
      this.list.set(id, { type: undefined, three: { normal: { ...normal } } });
      return id;
    }
    deleteAll(types?: Set<string>): void {
      for (const [id, plane] of Array.from(this.list.entries())) {
        if (!types || types.has(plane.type as string)) {
          this.list.delete(id);
        }
      }
    }
    setEnabled(_enabled: boolean): void {}
    clear(): void {}
    constructor() {
      clipperInstances.push(this);
    }
  }
  // Wave 13: ClipStyler resolved lazily via
  // `components.get(OBCF.ClipStyler)` when the first section plane is
  // styled. Needs a settable `world`, a `styles` Map (so
  // `ensureSectionStyle` registers the default fill once), and a
  // `createFromClipping` (the source calls it but ignores the return).
  const clipStylerInstances: Array<Record<string, any>> = [];
  class ClipStylerClass {
    static uuid = "mock-clip-styler";
    world: unknown = null;
    styles = new Map<string, unknown>();
    createFromClipping = vi.fn(() => ({ visible: true }));
    constructor() {
      clipStylerInstances.push(this);
    }
  }
  // Task 19: per-element visibility goes through
  // `components.get(OBC.Hider).set(visible, {...})`.
  class HiderClass {
    static uuid = "mock-hider";
    set(_visible: boolean, _ids: Record<string, unknown>): void {}
  }

  // ── Wave 12: 3D measurement mocks ────────────────────────────
  // Each measurement component is a class (matched by reference in
  // ComponentsMock.get()) whose *instances* carry the observable
  // surface: world/enabled setters, create/cancelCreation spies, the
  // `list` DataSet stand-in (with `.clear`), the readout event
  // emitters, and a `units` string.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const measureInstances: Array<Record<string, any>> = [];
  function makeMeasureClass(unit: string, uuid: string) {
    const C = class {
      static uuid = uuid;
      world: unknown = null;
      enabled = false;
      create = vi.fn();
      endCreation = vi.fn();
      cancelCreation = vi.fn();
      list = Object.assign(new Set<unknown>(), {
        clear: vi.fn(),
        onItemAdded: { add: vi.fn(), remove: vi.fn() },
        onItemDeleted: { add: vi.fn(), remove: vi.fn() },
        onCleared: { add: vi.fn(), remove: vi.fn() },
      });
      units = unit;
      _temp = { isDragging: false };
      onPointerMove = { add: vi.fn(), remove: vi.fn() };
      onPointerStop = { add: vi.fn(), remove: vi.fn() };
      constructor() {
        measureInstances.push(this);
      }
    };
    return C;
  }
  const LengthMeasurementClass = makeMeasureClass(
    "m",
    "mock-length-measurement",
  );
  const AreaMeasurementClass = makeMeasureClass(
    "m2",
    "mock-area-measurement",
  );
  const AngleMeasurementClass = makeMeasureClass(
    "deg",
    "mock-angle-measurement",
  );
  const VolumeMeasurementClass = makeMeasureClass(
    "m3",
    "mock-volume-measurement",
  );
  // Shared SnapResolver stand-in — the source writes `maxDistance` on
  // the resolver instance returned by `SnapResolvers.get()`.
  const snapResolverState = { maxDistance: 0 };
  class SnapResolversClass {
    static uuid = "mock-snap-resolvers";
    get() {
      return snapResolverState;
    }
  }

  return {
    ComponentsMock,
    WorldsClass,
    FragmentsManagerClass,
    TechnicalDrawingsClass,
    EdgeProjectorClass,
    ClassifierClass,
    BoundingBoxerClass,
    SimpleSceneClass,
    SimpleCameraClass,
    OrthoPerspectiveCameraClass,
    SimpleRendererClass,
    RendererWith2DClass,
    RaycastersClass,
    ClipperClass,
    ClipStylerClass,
    clipperInstances,
    clipStylerInstances,
    HiderClass,
    techDrawingsMock,
    edgeProjectorMock,
    worldMock,
    // Task 24: the fragments mock (model registry) + the camera
    // instance registry, so the `resetCameraToDefault` tests can
    // seed a model bounding box and assert on the camera pose.
    fragmentsMock,
    cameraInstances,
    cameraControlListeners,
    rendererInstances,
    // Task 21: OBCF class + instance mocks. The class uuid is
    // the key Components.get() uses to return the mock instance.
    HighlighterClass,
    highlighterInstanceMock: undefined as unknown,
    highlighterInstances,
    // Wave 12: measurement + snap mocks.
    LengthMeasurementClass,
    AreaMeasurementClass,
    AngleMeasurementClass,
    VolumeMeasurementClass,
    SnapResolversClass,
    measureInstances,
    snapResolverState,
    // Wave 14: FastModelPicker backmocks — the class refs
    // Components.get() matches, plus the mutable state the tests
    // seed to drive the fast/fallback pick paths.
    FastModelPickerClass,
    FastModelPickersClass,
    fastPickerState,
    fastPickerInstance,
    // Wave 19: canvas click-listener double for the viewer-owned pick.
    canvasListeners,
    rendererDomElement,
  };
});

vi.mock("@thatopen/components", () => ({
  Components: h.ComponentsMock,
  Worlds: h.WorldsClass,
  FragmentsManager: h.FragmentsManagerClass,
  TechnicalDrawings: h.TechnicalDrawingsClass,
  EdgeProjector: h.EdgeProjectorClass,
  Classifier: h.ClassifierClass,
  BoundingBoxer: h.BoundingBoxerClass,
  SimpleScene: h.SimpleSceneClass,
  SimpleRenderer: h.SimpleRendererClass,
  SimpleCamera: h.SimpleCameraClass,
  OrthoPerspectiveCamera: h.OrthoPerspectiveCameraClass,
  // Task 21: the mount effect pre-warms the raycaster before
  // the Highlighter setup.
  Raycasters: h.RaycastersClass,
  // Task 23.1: floor clip plane.
  Clipper: h.ClipperClass,
  // Wave 13: section-plane cut styling (components-front).
  ClipStyler: h.ClipStylerClass,
  // Task 19: per-element visibility.
  Hider: h.HiderClass,
  // Wave 12: shared SnapResolver (vertex/edge/face snap tolerance).
  SnapResolvers: h.SnapResolversClass,
  // Wave 14: the pick seam feature-detects the GPU picker at mount.
  FastModelPickers: h.FastModelPickersClass,
  FastModelPicker: h.FastModelPickerClass,
  // Referenced by the viewer surface but not exercised by these
  // smoke tests — declared so the module graph resolves them.
  Views: class {},
  World: class {},
  MouseNavigation: class {},
  CameraProjection: class {},
  Event: class {},
  ModelIdMap: class {},
  NavModeID: class {},
  PostproductionRenderer: class {},
}));

// Task 21: OBCF mock. The Highlighter class lives in
// @thatopen/components-front (NOT @thatopen/components). We
// expose the same minimum surface IfcViewer.tsx uses: setup(),
// highlightByID(), clear(), dispose(), events.select.onHighlight
// + onClear, and a settable `multiple` field.
//
// CRITICAL: this class MUST be the SAME reference as the
// `HighlighterClass` declared in the hoisted `h` block —
// `components.get(HighlighterClass)` matches by class reference,
// and IfcViewer calls `components.get(OBCF.Highlighter)` (which
// is THIS class). We pull the class from `h` via the vi.mock
// factory's reference to `h.HighlighterClass`.
// (vitest's vi.mock is hoisted but `h` from vi.hoisted is also
// hoisted and accessible from any factory in the same file.)
vi.mock("@thatopen/components-front", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Highlighter: (h as any).HighlighterClass,
  Hoverer: class {},
  // Wave 67: SimpleRenderer + CSS2D layer (measurement labels).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RendererWith2D: (h as any).RendererWith2DClass,
  MeasurementLineType: { Basic: "basic", Fat: "fat" },
  // Wave 13: section-plane cut styling.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ClipStyler: (h as any).ClipStylerClass,
  // Wave 12: the four measurement components (matched by class
  // reference in the components mock).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LengthMeasurement: (h as any).LengthMeasurementClass,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AreaMeasurement: (h as any).AreaMeasurementClass,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AngleMeasurement: (h as any).AngleMeasurementClass,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  VolumeMeasurement: (h as any).VolumeMeasurementClass,
}));

vi.mock("@ff/viewer", () => ({
  createLevelPlanController: vi.fn(() => ({
    activeStoreyName: null,
    open: vi.fn(async () => false),
    close: vi.fn(),
    dispose: vi.fn(),
    _setStoreys: vi.fn(),
  })),
}));

// (stats.js mock removed 2026-06-23 — the Stats overlay was dropped
// from IfcViewer; the import is gone too.)

// Stub fetch for the IIFE's getFragmentsWorkerBlobUrl.
vi.stubGlobal("fetch", async () => ({
  ok: true,
  text: async () => "// worker stub",
} as Response));
vi.stubGlobal("URL", {
  createObjectURL: vi.fn(() => "blob:stub"),
  revokeObjectURL: vi.fn(),
});

import { IfcViewer, type IfcViewerHandle, type MeasureReadout } from "@ff/viewer-react";
import {
  createLevelPlanController,
} from "@ff/viewer";
// Task 20 §1.8.3: IfcViewer no longer reads from a global
// viewer store. The `viewerSlice` prop is the seam. The
// beforeEach below no longer resets a global store — the
// viewer is pure (no shared state across tests).

describe("<IfcViewer> handle", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    // Task 24: reset the fragments model registry + the camera
    // instance registry so each test starts from a clean slate.
    h.fragmentsMock.core.models.list.clear();
    h.cameraInstances.length = 0;
    // Wave 14: reset the pick backend state. Default is the clean
    // "fast" path (no init failure, no seeded point).
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = null;
    h.fastPickerInstance.getPointAt.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("openLevel is a function returning Promise<boolean> and returns false on miss", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(typeof ref.current!.openLevel).toBe("function");

    // The mock LevelPlanController.open returns false
    const result = await ref.current!.openLevel("anything");
    expect(result).toBe(false);

    unmount();
  });

  it("closeLevel does not throw when no plan is open", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(() => ref.current!.closeLevel()).not.toThrow();
    unmount();
  });

  it("the handle interface exposes openLevel and closeLevel", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(typeof ref.current!.openLevel).toBe("function");
    expect(typeof ref.current!.closeLevel).toBe("function");
    expect(typeof ref.current!.update).toBe("function");
    expect(ref.current!.loadedModelIds).toBeInstanceOf(Set);
    unmount();
  });

  it("creates LevelPlanController on mount and disposes on unmount", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    // The LevelPlanController is created inside the mount effect's
    // async IIFE (after the fragments worker URL is fetched), so
    // it lands one tick AFTER the imperative handle is attached.
    // Wait for the factory call instead of assuming it already
    // happened when the handle shows up.
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const ctrl = vi.mocked(createLevelPlanController).mock.results[0]
      ?.value as { dispose: ReturnType<typeof vi.fn> };
    unmount();
    expect(ctrl.dispose).toHaveBeenCalled();
  });

  // ─── Task 21: selection / highlight API ──────────────────────
  // Exercises the `selectElement`, `clearSelection`,
  // `getSelection`, and `onSelectionChange` methods on the
  // IfcViewerHandle. The Highlighter mock in the vi.mock
  // factories above exposes the minimum surface these tests
  // touch (setup, highlightByID, clear, events.select).
  it("selectElement populates the internal selection map", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    ref.current!.selectElement("m-1", 42);
    const sel = ref.current!.getSelection();
    expect(sel.size).toBe(1);
    expect(sel.get("m-1")).toBeInstanceOf(Set);
    expect(sel.get("m-1")!.has(42)).toBe(true);
    unmount();
  });

  it("clearSelection empties the selection map", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    ref.current!.selectElement("m-1", 42);
    expect(ref.current!.getSelection().size).toBe(1);
    ref.current!.clearSelection();
    expect(ref.current!.getSelection().size).toBe(0);
    unmount();
  });

  it("selectElement(null, null) clears via the same path", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    ref.current!.selectElement("m-1", 42);
    ref.current!.selectElement(null, null);
    expect(ref.current!.getSelection().size).toBe(0);
    unmount();
  });

  // Wave 20: `getSelectionWorldPoint` is the real-click-point surface
  // tap-to-create prefers. In jsdom the GPU pick pipeline can't run,
  // so what IS testable is the contract's negative half: every
  // programmatic path must read null (never a stale point), forcing
  // callers to the bbox-centre fallback. The positive half (stash on
  // canvas pick + fingerprint guard) is exercised live via the
  // ?ffdebug harness on the dev server.
  it("getSelectionWorldPoint reads null for programmatic selections", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(ref.current!.getSelectionWorldPoint()).toBeNull();
    ref.current!.selectElement("m-1", 42);
    expect(ref.current!.getSelectionWorldPoint()).toBeNull();
    ref.current!.clearSelection();
    expect(ref.current!.getSelectionWorldPoint()).toBeNull();
    unmount();
  });

  it("getSelectionWorldNormal reads null for programmatic selections", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    expect(ref.current!.getSelectionWorldNormal()).toBeNull();
    ref.current!.selectElement("m-1", 42);
    expect(ref.current!.getSelectionWorldNormal()).toBeNull();
    ref.current!.clearSelection();
    expect(ref.current!.getSelectionWorldNormal()).toBeNull();
    unmount();
  });

  it("getSelection returns a snapshot \u2014 mutating it does not affect internal state", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    ref.current!.selectElement("m-1", 42);
    const snap = ref.current!.getSelection();
    snap.delete("m-1");
    expect(ref.current!.getSelection().size).toBe(1);
    unmount();
  });

  it("onSelectionChange fires on selectElement and clearSelection", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    const events: number[] = [];
    ref.current!.onSelectionChange((s) => {
      events.push(s.size);
    });
    ref.current!.selectElement("m-1", 42);
    ref.current!.clearSelection();
    ref.current!.onSelectionChange(null);
    // Expect: 0 (initial), 1 (after select), 0 (after clear).
    // The initial event doesn't fire on subscription \u2014 only on
    // subsequent state changes. So expect [1, 0].
    expect(events).toEqual([1, 0]);
    unmount();
  });

  it("onSelectionChange(null) unsubscribes", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    let count = 0;
    const cb = (): void => {
      count++;
    };
    ref.current!.onSelectionChange(cb);
    ref.current!.selectElement("m-1", 42);
    expect(count).toBe(1);
    ref.current!.onSelectionChange(null);
    ref.current!.clearSelection();
    expect(count).toBe(1); // no further events
    unmount();
  });

  it("the handle sees the CURRENT disableSelection / viewerSlice props (wave 63)", async () => {
    const ref = createRef<IfcViewerHandle>();
    const sliceA = { activeStoreyName: null, setActiveStoreyName: vi.fn() };
    const sliceB = { activeStoreyName: null, setActiveStoreyName: vi.fn() };
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        disableSelection
        viewerSlice={sliceA as never}
      />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        disableSelection={false}
        viewerSlice={sliceB as never}
      />,
    );
    ref.current!.selectElement("m-1", 7);
    expect(ref.current!.getSelection().get("m-1")?.has(7)).toBe(true);
    ref.current!.closeLevel();
    expect(sliceB.setActiveStoreyName).toHaveBeenCalledWith(null);
    utils.unmount();
  });

  it("hide then show of the same id in one frame: the last call wins (wave 63)", async () => {
    const setSpy = vi.spyOn(h.HiderClass.prototype, "set");
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    ref.current!.setElementVisibility("m1", new Set([1, 2]), false);
    ref.current!.setElementVisibility("m1", new Set([2, 3]), true);
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    const calls = setSpy.mock.calls.map(([v, map]) => [
      v,
      Array.from((map as Record<string, Set<number>>).m1 ?? []).sort(),
    ]);
    expect(calls).toContainEqual([true, [2, 3]]);
    expect(calls).toContainEqual([false, [1]]);
    unmount();
  });

  it("the returned unsubscribe removes only that selection listener (wave 63)", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    let a = 0;
    let b = 0;
    const offA = ref.current!.onSelectionChange(() => {
      a++;
    });
    ref.current!.onSelectionChange(() => {
      b++;
    });
    ref.current!.selectElement("m-1", 42);
    offA();
    ref.current!.clearSelection();
    expect(a).toBe(1);
    expect(b).toBe(2);
    unmount();
  });
});

// ─── Task 24: resetCameraToDefault ─────────────────────────────
//
// The camera reset is the "back to a fresh app load" pose. The
// unit test drives the handle method against the mocked OBC stack
// and asserts on the camera-controls surface:
//   - the look-at target = the centre of the merged model bounds
//   - the eye = target + the default orbit direction × the fit
//     distance (bounding-sphere radius × 2.5)
//   - the orbit mouse bindings are restored and the controls are
//     re-enabled
describe("<IfcViewer> resetCameraToDefault", () => {
  // The default orbit direction: 45° above the horizon, 45° around
  // the model (above-front-right).
  const DIR = {
    x: Math.cos(Math.PI / 4) * Math.cos(Math.PI / 4),
    y: Math.sin(Math.PI / 4),
    z: Math.cos(Math.PI / 4) * Math.sin(Math.PI / 4),
  };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    h.cameraInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("frames the loaded model: target = bounds centre, eye = target + direction × fit distance", async () => {
    // One loaded model spanning (0,0,0) → (10, 4, 20).
    h.fragmentsMock.core.models.list.set("m-1", {
      box: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 4, z: 20 },
      },
    });

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");

    ref.current!.resetCameraToDefault();

    expect(setLookAt).toHaveBeenCalledTimes(1);
    const [ex, ey, ez, tx, ty, tz] = setLookAt.mock.calls[0]!;
    // Target = the centre of the merged bounding box.
    expect(tx).toBeCloseTo(5, 5);
    expect(ty).toBeCloseTo(2, 5);
    expect(tz).toBeCloseTo(10, 5);
    // Distance = bounding-sphere radius × the fit factor (2.5).
    const radius = 0.5 * Math.hypot(10, 4, 20);
    const distance = radius * 2.5;
    expect(ex).toBeCloseTo(5 + DIR.x * distance, 5);
    expect(ey).toBeCloseTo(2 + DIR.y * distance, 5);
    expect(ez).toBeCloseTo(10 + DIR.z * distance, 5);

    unmount();
  });

  it("merges the bounds of every loaded model", async () => {
    h.fragmentsMock.core.models.list.set("m-1", {
      box: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 0, z: 10 },
      },
    });
    h.fragmentsMock.core.models.list.set("m-2", {
      box: {
        min: { x: -10, y: 0, z: 0 },
        max: { x: 0, y: 10, z: 10 },
      },
    });

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");
    ref.current!.resetCameraToDefault();

    const [, , , tx, ty, tz] = setLookAt.mock.calls[0]!;
    // Merged box: (-10,0,0) → (10,10,10) → centre (0, 5, 5).
    expect(tx).toBeCloseTo(0, 5);
    expect(ty).toBeCloseTo(5, 5);
    expect(tz).toBeCloseTo(5, 5);

    unmount();
  });

  it("falls back to a safe default pose when no model is loaded", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");
    ref.current!.resetCameraToDefault();

    expect(setLookAt).toHaveBeenCalledTimes(1);
    const [ex, ey, ez, tx, ty, tz] = setLookAt.mock.calls[0]!;
    // Target = the world origin.
    expect(tx).toBe(0);
    expect(ty).toBe(0);
    expect(tz).toBe(0);
    // Distance = the safe default (50).
    expect(ex).toBeCloseTo(DIR.x * 50, 5);
    expect(ey).toBeCloseTo(DIR.y * 50, 5);
    expect(ez).toBeCloseTo(DIR.z * 50, 5);

    unmount();
  });

  it("re-enables the orbit controls (mouse bindings + enabled flag)", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    // Simulate the restricted third-person state: every mouse
    // button zeroed out and the controls switched off.
    cam.controls.mouseButtons.left = 0;
    cam.controls.mouseButtons.right = 0;
    cam.controls.mouseButtons.middle = 0;
    cam.controls.mouseButtons.wheel = 0;
    cam.controls.enabled = false;

    ref.current!.resetCameraToDefault();

    // left=ROTATE(1), right=TRUCK(2), middle=DOLLY(4), wheel=DOLLY(4).
    expect(cam.controls.mouseButtons.left).toBe(1);
    expect(cam.controls.mouseButtons.right).toBe(2);
    expect(cam.controls.mouseButtons.middle).toBe(4);
    expect(cam.controls.mouseButtons.wheel).toBe(4);
    expect(cam.controls.enabled).toBe(true);

    unmount();
  });

  it("is idempotent — calling it twice produces the same pose", async () => {
    h.fragmentsMock.core.models.list.set("m-1", {
      box: {
        min: { x: -5, y: 0, z: -5 },
        max: { x: 5, y: 6, z: 5 },
      },
    });

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");
    ref.current!.resetCameraToDefault();
    ref.current!.resetCameraToDefault();

    expect(setLookAt).toHaveBeenCalledTimes(2);
    expect(setLookAt.mock.calls[0]).toEqual(setLookAt.mock.calls[1]);

    unmount();
  });
});

// ─── Tasks module: getPose / setViewPose ───────────────────────
//
// Pose capture/restore is the "open a task from its author's
// viewpoint" primitive (task-module plan §5). The tests assert
// on the camera-controls surface the handle drives: getPose
// reads three.position + controls.getTarget (fov/type from the
// active camera), setViewPose switches the projection FIRST
// (fov is only meaningful on the perspective camera), then
// looks at the pose.
describe("<IfcViewer> getPose / setViewPose", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.cameraInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getPose reads eye, target, fov and projection from the live camera", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    cam.three.position.x = 12;
    cam.three.position.y = 7;
    cam.three.position.z = -3;
    cam.lookTarget = { x: 1, y: 2, z: 3 };
    cam.three.fov = 60;

    expect(ref.current!.getPose()).toEqual({
      pos: [12, 7, -3],
      target: [1, 2, 3],
      fov: 60,
      isOrtho: false,
    });

    unmount();
  });

  it("getPose flags the orthographic projection and keeps a total fov record", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    cam.three.type = "OrthographicCamera";
    // Orthographic cameras carry no fov — the handle falls back to
    // OBC's perspective default so the stored record stays total.
    (cam.three as unknown as { fov?: number }).fov = undefined;

    const pose = ref.current!.getPose();
    expect(pose!.isOrtho).toBe(true);
    expect(pose!.fov).toBe(45);

    unmount();
  });

  it("getPose records a viewpoint-save breadcrumb unless silent", async () => {
    const tel = ensureViewerTelemetry();
    const crumb = vi.spyOn(tel, "breadcrumb");
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    crumb.mockClear();

    ref.current!.getPose({ silent: true });
    expect(crumb).not.toHaveBeenCalledWith("viewpoint", "save");

    ref.current!.getPose();
    expect(crumb).toHaveBeenCalledWith("viewpoint", "save");

    unmount();
  });

  it("setViewPose switches projection first and drives setLookAt", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");
    const proj = vi.spyOn(cam.projection, "set");

    ref.current!.setViewPose(
      { pos: [1, 2, 3], target: [4, 5, 6], fov: 50, isOrtho: true },
      { animate: true },
    );

    expect(proj).toHaveBeenCalledWith("Orthographic");
    expect(setLookAt).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6, true);
    // An ortho restore must not smear fov onto the perspective
    // camera that the projection swap may still be resolving.
    expect(cam.three.fov).toBe(45);

    unmount();
  });

  it("setViewPose writes fov on perspective restores, no transition by default", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });

    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = vi.spyOn(cam.controls, "setLookAt");
    const proj = vi.spyOn(cam.projection, "set");

    ref.current!.setViewPose({
      pos: [1, 2, 3],
      target: [4, 5, 6],
      fov: 35,
      isOrtho: false,
    });

    expect(proj).toHaveBeenCalledWith("Perspective");
    expect(cam.three.fov).toBe(35);
    expect(setLookAt).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6, false);

    unmount();
  });
});

describe("<IfcViewer> getSnapshot (Day-3, jsdom-safe)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.cameraInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when there is no WebGL canvas surface (no renderer.render/domElement)", async () => {
    const ref = createRef<IfcViewerHandle>();
    render(<IfcViewer ref={ref} projectId="p" activeBuildingId="b" />);
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    // The test world mock has no `three.render` / `domElement` — the
    // same-frame capture must degrade to null instead of throwing.
    expect(ref.current!.getSnapshot()).toBeNull();
    expect(ref.current!.getSnapshot(200)).toBeNull();
  });
});

// ─── Wave 12: 3D measurement tool mode ────────────────────────────
//
// `setMeasureMode` / `clearMeasurements` / `onMeasureReadout` drive the
// OBCF measurement components + the core SnapResolver through the same
// components registry the eye of IfcViewer owns. These seams assert the
// handle wiring against the mocked registry: arming/disarming a
// variant, clearing its list, the unsupported-variant no-op, and the
// readout feed.
describe("<IfcViewer> 3D measurement tool mode", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.measureInstances.length = 0;
    h.snapResolverState.maxDistance = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountHandle(): Promise<{
    ref: { current: IfcViewerHandle | null };
    unmount: () => void;
  }> {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    return { ref, unmount };
  }

  it("setMeasureMode('measure', 'length') arms the length component + snap tolerance", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");

    expect(h.measureInstances.length).toBe(1);
    const m = h.measureInstances[0]!;
    expect(m.units).toBe("m");
    expect(m.enabled).toBe(true);
    expect(m.world).not.toBeNull();
    expect(h.snapResolverState.maxDistance).toBeGreaterThan(0);

    unmount();
  });

  it("switching variants disarms the previous component and arms the next", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    ref.current!.setMeasureMode("measure", "area");

    expect(h.measureInstances.length).toBe(2);
    expect(h.measureInstances[0]!.enabled).toBe(false);
    expect(h.measureInstances[1]!.units).toBe("m2");
    expect(h.measureInstances[1]!.enabled).toBe(true);

    unmount();
  });

  it("setMeasureMode('select') disarms the active component without removing its list", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    expect(h.measureInstances[0]!.enabled).toBe(true);

    ref.current!.setMeasureMode("select");
    expect(h.measureInstances[0]!.enabled).toBe(false);
    // Select keeps measurements on screen — no list clear.
    expect(h.measureInstances[0]!.list.clear).not.toHaveBeenCalled();

    unmount();
  });

  it("clearMeasurements cancels in-flight creation and clears the list", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    ref.current!.clearMeasurements();

    const m = h.measureInstances[0]!;
    expect(m.cancelCreation).toHaveBeenCalled();
    expect(m.list.clear).toHaveBeenCalled();
    // The mode stays armed — clearing doesn't drop back to select.
    expect(m.enabled).toBe(true);

    unmount();
  });

  it("clearMeasurements clears every measurement type used, not only the active one (wave 63)", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    ref.current!.setMeasureMode("measure", "area");
    ref.current!.setMeasureMode("select");
    ref.current!.clearMeasurements();

    expect(h.measureInstances.length).toBe(2);
    for (const m of h.measureInstances) {
      expect(m.list.clear).toHaveBeenCalled();
    }
    unmount();
  });

  it("unmount clears every measurement type used (wave 63)", async () => {
    const { ref, unmount } = await mountHandle();
    ref.current!.setMeasureMode("measure", "angle");
    ref.current!.setMeasureMode("measure", "volume");
    unmount();
    for (const m of h.measureInstances) {
      expect(m.list.clear).toHaveBeenCalled();
    }
  });

  it("setMeasureMode('measure') without a variant warns and no-ops", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure");

    expect(h.measureInstances.length).toBe(0);
    expect(console.warn).toHaveBeenCalled();

    unmount();
  });

  it("setMeasureMode with an unsupported variant warns and no-ops", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode(
      "measure",
      "bogus" as unknown as "length",
    );

    expect(h.measureInstances.length).toBe(0);
    expect(console.warn).toHaveBeenCalled();

    unmount();
  });

  it("onMeasureReadout emits { value, unit } on pointer move", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    const m = h.measureInstances[0]!;
    m._temp.isDragging = true;
    m._temp.line = { value: 12.4 };

    const seen: (MeasureReadout | null)[] = [];
    ref.current!.onMeasureReadout((r) => seen.push(r));

    // Drive the same `emit` closure the source registered on the
    // component's `onPointerMove` emitter.
    const emit = m.onPointerMove.add.mock.calls[0]![0] as () => void;
    emit();

    expect(seen[seen.length - 1]).toEqual({ value: 12.4, unit: "m" });

    ref.current!.onMeasureReadout(null);
    unmount();
  });

  // ─── Wave 50: two-stage measure Escape surface ─────────────

  it("isMeasureInProgress reports false when the component is disarmed or idle", async () => {
    const { ref, unmount } = await mountHandle();

    // Disarmed.
    expect(ref.current!.isMeasureInProgress()).toBe(false);

    ref.current!.setMeasureMode("measure", "length");
    // Armed but no points placed yet (length _temp.isDragging === false).
    expect(ref.current!.isMeasureInProgress()).toBe(false);

    unmount();
  });

  it("isMeasureInProgress reports true while a length preview is in flight", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    const m = h.measureInstances[0]!;
    m._temp.isDragging = true; // first click placed, second pending

    expect(ref.current!.isMeasureInProgress()).toBe(true);

    unmount();
  });

  it("cancelMeasureCreation cancels the in-flight preview without clearing the list", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.setMeasureMode("measure", "length");
    const m = h.measureInstances[0]!;
    m._temp.isDragging = true;

    ref.current!.cancelMeasureCreation();

    expect(m.cancelCreation).toHaveBeenCalled();
    expect(m.list.clear).not.toHaveBeenCalled();
    // Tool stays armed.
    expect(m.enabled).toBe(true);

    unmount();
  });

  // ─── Wave 67: measurements list + finish gesture ───────────
  it("finishMeasureCreation commits the armed area measurement (Enter / dblclick path)", async () => {
    const { ref, unmount } = await mountHandle();
    ref.current!.setMeasureMode("measure", "area");
    const m = h.measureInstances[0]!;
    ref.current!.finishMeasureCreation();
    await waitFor(() => {
      expect(m.endCreation).toHaveBeenCalledTimes(1);
    });
    // Disarmed: nothing to commit.
    ref.current!.setMeasureMode("select");
    ref.current!.finishMeasureCreation();
    expect(m.endCreation).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("getMeasurements lists items and deleteMeasurement removes exactly one", async () => {
    const { ref, unmount } = await mountHandle();
    ref.current!.setMeasureMode("measure", "length");
    const m = h.measureInstances[0]!;
    const a = { id: "a", value: 5 };
    const b = { id: "b", value: 7.5 };
    m.list.add(a);
    m.list.add(b);
    const seen: string[][] = [];
    ref.current!.onMeasurementsChange((entries) => seen.push(entries.map((e) => e.id)));
    expect(ref.current!.getMeasurements().map((e) => e.text)).toEqual(["5.00 m", "7.50 m"]);

    ref.current!.deleteMeasurement("a");
    expect(m.list.has(a)).toBe(false);
    expect(m.list.has(b)).toBe(true);
    expect(seen.at(-1)).toEqual(["b"]);
    // Unknown id: no-op.
    ref.current!.deleteMeasurement("zzz");
    expect(m.list.has(b)).toBe(true);
    unmount();
  });

  it("measurements survive disarming the tool", async () => {
    const { ref, unmount } = await mountHandle();
    ref.current!.setMeasureMode("measure", "length");
    const m = h.measureInstances[0]!;
    m.list.add({ id: "a", value: 1 });
    ref.current!.setMeasureMode("select");
    expect(m.enabled).toBe(false);
    expect(ref.current!.getMeasurements()).toHaveLength(1);
    unmount();
  });

  // ─── Wave 67: plan-mode routing ─────────────────────────────
  function mockOpenPlan(): { listItems: ReturnType<typeof vi.fn>; clearDrawing: ReturnType<typeof vi.fn> } {
    const sys = {
      labelFactory: null,
      units: { unit: "m", localPerMetre: 1 },
      labelCount: 0,
      listItems: vi.fn(() => [] as unknown[]),
      clearDrawing: vi.fn(),
      deleteItems: vi.fn(),
      formatDistance: vi.fn(() => "1.00 m"),
      distanceOf: vi.fn(() => 1),
      onCommit: { add: vi.fn() },
      onDelete: { add: vi.fn() },
      onMachineStateChanged: { add: vi.fn() },
    };
    vi.mocked(createLevelPlanController).mockReturnValueOnce({
      activeStoreyName: "L1",
      getMeasureSystem: () => sys,
      getDrawing: () => ({ three: {} }),
      open: vi.fn(async () => true),
      close: vi.fn(),
      dispose: vi.fn(),
      _setStoreys: vi.fn(),
    } as never);
    return sys;
  }

  it("with a level plan open, Measure > Length uses the plan tool and arms no 3D component", async () => {
    mockOpenPlan();
    const { ref, unmount } = await mountHandle();
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());
    ref.current!.setMeasureMode("measure", "length");
    expect(h.measureInstances.length).toBe(0);
    expect(ref.current!.activeTool).toBe("measure");
    unmount();
  });

  it("with a level plan open, a non-length variant arms the 3D component instead", async () => {
    mockOpenPlan();
    const { ref, unmount } = await mountHandle();
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());
    ref.current!.setMeasureMode("measure", "area");
    expect(h.measureInstances.length).toBe(1);
    expect(h.measureInstances[0]!.enabled).toBe(true);
    unmount();
  });

  it("clearMeasurements also clears the open plan's lines", async () => {
    const sys = mockOpenPlan();
    const { ref, unmount } = await mountHandle();
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());
    ref.current!.clearMeasurements();
    expect(sys.clearDrawing).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cancelMeasureCreation is a no-op when disarmed", async () => {
    const { ref, unmount } = await mountHandle();

    ref.current!.cancelMeasureCreation();

    expect(h.measureInstances.length).toBe(0);

    unmount();
  });

  // ─── Wave 14: pick backend seam ─────────────────────────────
  // Exercises `pickWorldPoint` through both live backends. The mount
  // IIFE runs the feature-detection AFTER the async worker fetch, so
  // we wait for the LevelPlanController (created at the end of that
  // same IIFE) before calling the handle — ensuring `pickBackendRef`
  // is already resolved.

  it("pickWorldPoint resolves through the FastModelPicker when init is clean", async () => {
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const result = await ref.current!.pickWorldPoint();
    expect(result).toEqual({ x: 1, y: 2, z: 3 });
    expect(h.fastPickerInstance.getPointAt).toHaveBeenCalled();

    unmount();
  });

  it("pickWorldPoint falls back to Raycasters when FastModelPicker init fails", async () => {
    h.fastPickerState.failInit = true;

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    // Raycasters stub returns null (no geometry in jsdom). The fast
    // picker must NOT be consulted (init threw at mount).
    const result = await ref.current!.pickWorldPoint();
    expect(result).toBeNull();
    expect(h.fastPickerInstance.getPointAt).not.toHaveBeenCalled();

    unmount();
  });
});

// ─── Wave 19: multi-model element picking (option A) ─────────────────
//
// The field bug: with TWO IFC models loaded, clicking an element of the
// SECOND model never resolved `{modelId, expressId}`. Root cause is the
// Highlighter's own click path (single-model); the fix routes the
// FAST-backend selection through FastModelPicker.getFullPick() and drives
// the orange highlight programmatically.
describe("<IfcViewer> multi-model element pick (Wave 19)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.canvasListeners.clear();
    h.highlighterInstances.length = 0;
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = null;
    h.fastPickerState.normal = null;
    vi.mocked(h.fastPickerInstance.getFullPick).mockClear();
    vi.mocked(h.fastPickerInstance.getPointAt).mockClear();
    vi.mocked(h.fastPickerInstance.getNormalAt).mockClear();
    vi.mocked(h.fastPickerInstance.getItemAt).mockReset();
    h.fastPickerInstance.getItemAt.mockImplementation(async () => null);
    // Wave 24: reset the targeted-coloring op spies per test (mockReset
    // restores the factory default; the coalescer test installs a
    // gated impl that must not leak forward).
    vi.mocked(h.fragmentsMock.highlight).mockReset();
    h.fragmentsMock.highlight.mockImplementation(async () => undefined);
    vi.mocked(h.fragmentsMock.resetHighlight).mockReset();
    h.fragmentsMock.resetHighlight.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a model-#2 click through the id+depth passes and fires setOnElementPick", async () => {
    // Wave 21: selection resolves on the id pass (getItemAt) and the
    // anchor point on the depth pass (getPointAt). getFullPick (which
    // also renders the unused normal pass) must NOT run on the click
    // path any more. Stub the GPU pick so a click on the CANVAS
    // resolves model #2 — the exact case that used to drop.
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const events: Array<{ modelId?: string; expressId?: number } | null> = [];
    ref.current!.setOnElementPick((e) =>
      events.push(e ? { modelId: e.modelId, expressId: e.expressId } : null),
    );

    // The viewer-owned click pipeline registered a click listener on
    // the canvas surface.
    const clickHandlers = h.canvasListeners.get("click");
    expect(clickHandlers?.length).toBeGreaterThan(0);

    // Simulate a left-click at the canvas centre.
    await clickHandlers![0]!({ clientX: 400, clientY: 300, button: 0 });

    expect(h.fastPickerInstance.getItemAt).toHaveBeenCalledTimes(1);
    expect(h.fastPickerInstance.getPointAt).toHaveBeenCalledTimes(1);
    // Wave 21 regression: the three-pass getFullPick is off the
    // click path — that extra depth+normal render pair was the lag.
    expect(h.fastPickerInstance.getFullPick).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ modelId: "B", expressId: 42 });
    // The selection map mirrors the resolved hit.
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);
    // Wave 21: once the handler's promise settles, the depth-pass
    // point is stashed and the pending flag is cleared.
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });
    expect(ref.current!.isSelectionPointPending()).toBe(false);

    unmount();
  });

  it("stashes the face normal for getSelectionWorldNormal (Wave 48)", async () => {
    // The canvas pick resolves the id pass, then the anchor + the lazy
    // normal pass run in the background. `getNormalAt` seeds the surface
    // normal so the section-plane toolbar can orient parallel to the face.
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };
    h.fastPickerState.normal = { x: 0, y: 0, z: 1 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const clickHandlers = h.canvasListeners.get("click");
    expect(clickHandlers?.length).toBeGreaterThan(0);
    await clickHandlers![0]!({ clientX: 400, clientY: 300, button: 0 });

    await waitFor(() => {
      expect(ref.current!.getSelectionWorldNormal()).toEqual({ x: 0, y: 0, z: 1 });
    });
    unmount();
  });

  // Wave 28 (the field complaint itself): a click whose express id
  // cannot be resolved is an UNKNOWN outcome, not empty space. Before
  // this wave a wedged fragments worker either latched the single-flight
  // chain for seconds or — once wave 27 released it — the click was
  // dropped after a 4 s stall. Now the pick bounds its own round-trip
  // and the selection that IS on screen stays exactly as it was: no
  // clear, no spurious `setOnElementPick(null)`, and the chain hands its
  // latch back so the NEXT click still works.
  it("an unresolvable pick leaves the selection untouched and frees the chain", async () => {
    // Wave 28, the field complaint itself. `getItemAt` is the degraded
    // path in jsdom (no private id-pass internals to detect), so this
    // exercises the seam's per-round-trip bound: a wedged fragments
    // worker — which the engine can NEVER settle, reject, or time out
    // on its own — must produce a no-op click, not an empty-space click.
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const events: Array<unknown> = [];
    ref.current!.setOnElementPick((e) => events.push(e));

    const clickHandlers = h.canvasListeners.get("click");
    expect(clickHandlers?.length).toBeGreaterThan(0);
    const click = () =>
      clickHandlers![0]!({
        clientX: 400,
        clientY: 300,
        button: 0,
      } as unknown as MouseEvent);

    // Click 1: a normal pick. Selection applies and exactly one event fires.
    await click();
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);
    expect(events).toHaveLength(1);

    // Wedge the worker for every subsequent call.
    h.fastPickerInstance.getItemAt.mockImplementation(
      () => new Promise(() => undefined),
    );
    const callsBefore = h.fastPickerInstance.getItemAt.mock.calls.length;

    // Click 2 must RETURN on its own (bounded by the seam, not by the
    // 4 s chain guard) — that is the anti-latch property under test.
    await click();

    // UNKNOWN outcome: the selection that IS on screen is untouched, and
    // no `null` event was emitted: a null event means "clicked void",
    // which would clear the properties drawer and mis-anchor a
    // tap-to-create task.
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);
    expect(events).toHaveLength(1);
    // And the deferred-anchor flag is not left pointing at a point that
    // will never arrive — tap-to-create must fall back to the bbox
    // boxer, not wait forever.
    expect(ref.current!.isSelectionPointPending()).toBe(false);
    expect(h.fastPickerInstance.getItemAt.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );

    // And the chain is free: a third click is attempted, not swallowed
    // behind a latched single-flight promise.
    const callsAfterStall = h.fastPickerInstance.getItemAt.mock.calls.length;
    await click();
    expect(h.fastPickerInstance.getItemAt.mock.calls.length).toBeGreaterThan(
      callsAfterStall,
    );

    unmount();
  }, 20000);

  // Wave 21 regression (field report: the marker STILL landed at
  // the bbox centre on every click after the first). Replacing a
  // highlight makes the Highlighter fire onClear for the PREVIOUS
  // selection — asynchronously, i.e. after the new click already
  // stashed its point. The wave-20 mirror honoured that stale clear
  // and wiped the fresh stash; the fingerprint guard must now keep
  // it alive.
  it("stale onClear (previous selection) keeps selection AND click point", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    ref.current!.setOnElementPick(() => undefined);
    const clickHandlers = h.canvasListeners.get("click");
    expect(clickHandlers?.length).toBeGreaterThan(0);
    await clickHandlers![0]!({ clientX: 400, clientY: 300, button: 0 });
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });

    const inst = h.highlighterInstances[h.highlighterInstances.length - 1];
    expect(inst).toBeTruthy();
    // STALE clear — payload is the PREVIOUS element, not "B:42".
    for (const fn of inst!.events.select.onClear.__fns) {
      fn({ A: new Set([1]) });
    }
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });

    // GENUINE clear — payload matches the current selection.
    for (const fn of inst!.events.select.onClear.__fns) {
      fn({ B: new Set([42]) });
    }
    expect(ref.current!.getSelection().size).toBe(0);
    expect(ref.current!.getSelectionWorldPoint()).toBeNull();

    unmount();
  });

  // Wave 21b: two clicks in quick succession — the slow first pick
  // must not paint over the newer selection. Field report: "click
  // one element then another then another and just after that i get
  // the highlight on the first" — queued picks applied stale. The
  // single-flight chain makes that impossible: newer clicks supersede
  // mid-chain and only the newest result applies.
  it("latest click wins: a stale in-flight pick is superseded, never applied", async () => {
    let releaseFirst!: (v: { modelId: string; localId: number } | null) => void;
    const firstGate = new Promise<{ modelId: string; localId: number } | null>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );
    vi.mocked(h.fastPickerInstance.getItemAt)
      .mockImplementationOnce(() => firstGate)
      .mockImplementationOnce(async () => ({ modelId: "B", localId: 42 }));
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const events: Array<{ modelId?: string; expressId?: number } | null> = [];
    ref.current!.setOnElementPick((e) =>
      events.push(e ? { modelId: e.modelId, expressId: e.expressId } : null),
    );
    const clickHandlers = h.canvasListeners.get("click")!;
    const p1 = clickHandlers[0]!({ clientX: 100, clientY: 100, button: 0 });
    // Second click arrives while the first GPU pass is still in
    // flight — single-flight (wave 21b) queues it as the supersede.
    clickHandlers[0]!({ clientX: 400, clientY: 300, button: 0 });
    expect(events).toHaveLength(0);

    releaseFirst({ modelId: "A", localId: 1 });
    await p1;
    // A's result was DROPPED mid-chain and the newest pixel re-picked:
    // only B ever applied. Two getItemAt calls total (A discarded,
    // B applied) — exactly one selection change, no stale burst.
    expect(h.fastPickerInstance.getItemAt).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ modelId: "B", expressId: 42 }]);
    expect(ref.current!.getSelection().get("A")).toBeUndefined();
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });

    unmount();
  });

  // Wave 21: between the id pass (selection + highlight) and the
  // depth pass (anchor point) the handle must report the pick as
  // pending so tap-to-create waits for the REAL point instead of
  // racing to the bbox boxer.
  it("isSelectionPointPending is true while the depth pass runs", async () => {
    let releasePoint!: (v: { x: number; y: number; z: number } | null) => void;
    const pointGate = new Promise<{ x: number; y: number; z: number } | null>(
      (resolve) => {
        releasePoint = resolve;
      },
    );
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    vi.mocked(h.fastPickerInstance.getPointAt).mockImplementationOnce(() => pointGate);

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    ref.current!.setOnElementPick(() => undefined);
    const clickHandlers = h.canvasListeners.get("click")!;
    const p = clickHandlers[0]!({ clientX: 400, clientY: 300, button: 0 });

    // Selection lands on the id pass, BEFORE the point exists.
    await waitFor(() =>
      expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true),
    );
    expect(ref.current!.isSelectionPointPending()).toBe(true);
    expect(ref.current!.getSelectionWorldPoint()).toBeNull();

    releasePoint({ x: 7, y: 8, z: 9 });
    await p;
    expect(ref.current!.isSelectionPointPending()).toBe(false);
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 7, y: 8, z: 9 });

    unmount();
  });

  // Wave 22: the growth-curve telemetry proved highlight cycles
  // STACKED (in-flight peak 8, each 1.2–1.7 s on big MEP) — every
  // new click's getItemAt queued behind them, so delay grew with
  // click count. The coalescer runs one cycle at a time and always
  // the NEWEST target: intermediates are skipped entirely.
  it("wave 22/24: highlight cycles coalesce — newest wins, never concurrent", async () => {
    let releaseCycle!: () => void;
    const cycleGate = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });
    const maps: Array<Record<string, Set<number>>> = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    vi.mocked(h.fastPickerInstance.getItemAt)
      .mockResolvedValueOnce({ modelId: "A", localId: 1 } as never)
      .mockResolvedValueOnce({ modelId: "B", localId: 2 } as never)
      .mockResolvedValueOnce({ modelId: "C", localId: 3 } as never);
    h.fastPickerState.point = { x: 1, y: 1, z: 1 };

    // Gated spy on the wave-24 paint op (the fast backend no longer
    // calls the Highlighter): the FIRST highlight hangs until
    // released; later cycles resolve immediately. Tracks concurrency
    // + the maps applied.
    vi.mocked(h.fragmentsMock.highlight).mockImplementation(
      async (_style: unknown, map?: Record<string, Set<number>>) => {
        maps.push(map!);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        if (maps.length === 1) await cycleGate;
        concurrent -= 1;
      },
    );

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    ref.current!.setOnElementPick(() => undefined);
    const clickHandlers = h.canvasListeners.get("click")!;
    // click A: applies + starts the (gated) paint cycle
    await clickHandlers[0]!({ clientX: 100, clientY: 100, button: 0 });
    // clicks B and C arrive while the cycle runs
    await clickHandlers[0]!({ clientX: 200, clientY: 100, button: 0 });
    await clickHandlers[0]!({ clientX: 300, clientY: 100, button: 0 });

    // Only A's cycle has started; B and C are pending-coalesced.
    expect(maps).toHaveLength(1);
    expect(maxConcurrent).toBe(1);

    releaseCycle();
    await waitFor(() => expect(maps).toHaveLength(2));
    // B was SKIPPED — the drain always applies the newest target.
    expect(maps[0]).toEqual({ A: new Set([1]) });
    expect(maps[1]).toEqual({ C: new Set([3]) });
    expect(maxConcurrent).toBe(1);
    expect(ref.current!.getSelection().get("C")?.has(3)).toBe(true);

    unmount();
  });

  // Wave 24: the targeted-coloring manager replaces the Highlighter
  // cycle in fast mode — un-paint ONLY the previous element, paint
  // ONLY the new one (mirroring the Highlighter's exact call shape,
  // customId included: raw highlight() without it hung on the
  // chiller in the pre-flight). The global resetHighlight() (~1 s on
  // the MEP model) must never be called on the click path.
  it("wave 24: coloring is targeted — prev map reset, new map painted, customId set", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt)
      .mockResolvedValueOnce({ modelId: "A", localId: 1 } as never)
      .mockResolvedValueOnce({ modelId: "B", localId: 2 } as never);
    h.fastPickerState.point = { x: 1, y: 1, z: 1 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    ref.current!.setOnElementPick(() => undefined);
    const clickHandlers = h.canvasListeners.get("click")!;

    // click A — first paint: no previous, so no reset yet.
    await clickHandlers[0]!({ clientX: 100, clientY: 100, button: 0 });
    await waitFor(() => expect(h.fragmentsMock.highlight).toHaveBeenCalledTimes(1));
    const [style, mapA] = vi.mocked(h.fragmentsMock.highlight).mock.calls[0]!;
    expect((style as { customId?: string }).customId).toBe("select");
    expect(mapA).toEqual({ A: new Set([1]) });
    expect(h.fragmentsMock.resetHighlight).not.toHaveBeenCalled();

    // click B — the un-paint must carry A's map (targeted), NOT be
    // the global resetHighlight() the Highlighter would run.
    await clickHandlers[0]!({ clientX: 200, clientY: 100, button: 0 });
    await waitFor(() => expect(h.fragmentsMock.highlight).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.fragmentsMock.resetHighlight).toHaveBeenCalledTimes(1));
    expect(h.fragmentsMock.resetHighlight).toHaveBeenCalledWith({ A: new Set([1]) });
    expect(vi.mocked(h.fragmentsMock.highlight).mock.calls[1]![1]).toEqual({
      B: new Set([2]),
    });

    // the Highlighter itself was never touched on this path.
    const inst = h.highlighterInstances[h.highlighterInstances.length - 1];
    expect(inst!.highlightByID).not.toHaveBeenCalled();

    unmount();
  });

  // Wave 23 field report: "when we click and drag to rotate, if the
  // release is over one element it gets selected" — `click` fires on
  // EVERY mouseup, including the end of an orbit gesture, and our
  // fast-pick path had no drag-vs-click guard (the TOE Highlighter's
  // own path does: press position + 5px mouseMoveThreshold).
  it("wave 23: an orbit drag release over an element does not select", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValue({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 1, y: 2, z: 3 };

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const events: unknown[] = [];
    ref.current!.setOnElementPick((e) => events.push(e));

    const fire = async (type: string, ev: Record<string, number>) => {
      for (const fn of h.canvasListeners.get(type) ?? []) await fn(ev);
    };

    // press → 40px drag → release → the browser's synthetic click:
    // the whole gesture must be ignored (no pick, no selection).
    await fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    await fire("pointermove", { clientX: 140, clientY: 100, button: 0 });
    await fire("pointerup", { clientX: 140, clientY: 100, button: 0 });
    await fire("click", { clientX: 140, clientY: 100, button: 0 });
    expect(events).toHaveLength(0);
    expect(h.fastPickerInstance.getItemAt).not.toHaveBeenCalled();
    expect(ref.current!.getSelection().size).toBe(0);

    // a plain click (press + release without travel) still picks.
    await fire("pointerdown", { clientX: 400, clientY: 300, button: 0 });
    await fire("pointerup", { clientX: 400, clientY: 300, button: 0 });
    await fire("click", { clientX: 400, clientY: 300, button: 0 });
    expect(events).toHaveLength(1);
    expect(ref.current!.getSelection().get("B")?.has(42)).toBe(true);

    unmount();
  });

  it("keeps the raycaster/Highlighter fallback when fast init fails", async () => {
    h.fastPickerState.failInit = true;

    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });

    const events: unknown[] = [];
    ref.current!.setOnElementPick((e) => events.push(e));

    // The fallback must NOT install the canvas click pipeline — it
    // drives selection through `highlighter.events.select.onHighlight`.
    expect(h.canvasListeners.get("click")).toBeUndefined();
    expect(h.fastPickerInstance.getFullPick).not.toHaveBeenCalled();

    unmount();
  });
});

// ─── Wave 45: raycast-primary pick (worker virtual raycast) ──────────
//
// The boss requirement: instant MEP selection regardless of model size or
// warm-up state. `FragmentsManager.raycast` needs NO applied tiles, unlike
// the id-pass. The id-pass (`getItemAt`) is the fallback. These tests drive
// the canvas click → `setOnElementPick` with a mock `fragments.raycast`.
describe("<IfcViewer> raycast-primary pick (Wave 45)", () => {
  type RaycastSurface = { raycast?: unknown };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.canvasListeners.clear();
    h.highlighterInstances.length = 0;
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = null;
    delete (h.fragmentsMock as unknown as RaycastSurface).raycast;
    vi.mocked(h.fastPickerInstance.getItemAt).mockReset();
    h.fastPickerInstance.getItemAt.mockImplementation(async () => null);
    vi.mocked(h.fastPickerInstance.getPointAt).mockClear();
    h.fastPickerInstance.getPointAt.mockImplementation(
      async () => ({ x: 7, y: 8, z: 9 }) as never,
    );
    vi.mocked(h.fragmentsMock.highlight).mockReset();
    h.fragmentsMock.highlight.mockImplementation(async () => undefined);
    vi.mocked(h.fragmentsMock.resetHighlight).mockReset();
    h.fragmentsMock.resetHighlight.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    delete (h.fragmentsMock as unknown as RaycastSurface).raycast;
    vi.restoreAllMocks();
  });

  const mount = () => {
    const ref = createRef<IfcViewerHandle>();
    const rendered = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    return { ref, ...rendered };
  };

  it("raycast-hit → selection event carries the express id (localId, NOT itemId)", async () => {
    (h.fragmentsMock as unknown as RaycastSurface).raycast = vi.fn(
      async () => ({
        localId: 465474,
        itemId: 999, // internal flatbuffer index — must NOT be selected
        fragments: { modelId: "mep" },
        point: { x: 1, y: 2, z: 3 },
      }),
    );

    const { ref, unmount } = mount();
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());

    const events: Array<{ modelId?: string; expressId?: number } | null> = [];
    ref.current!.setOnElementPick((e) =>
      events.push(e ? { modelId: e.modelId, expressId: e.expressId } : null),
    );
    const clickHandlers = h.canvasListeners.get("click")!;
    await clickHandlers[0]!({ clientX: 400, clientY: 300, button: 0 });

    expect(events).toEqual([{ modelId: "mep", expressId: 465474 }]);
    expect(ref.current!.getSelection().get("mep")?.has(465474)).toBe(true);
    // The id-pass was never consulted, and the depth pass never ran (the
    // raycast carries the exact world point).
    expect(h.fastPickerInstance.getItemAt).not.toHaveBeenCalled();
    expect(h.fastPickerInstance.getPointAt).not.toHaveBeenCalled();
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });
    unmount();
  });

  it("raycast-null → empty-space behavior (deselect + setOnElementPick(null))", async () => {
    (h.fragmentsMock as unknown as RaycastSurface).raycast = vi.fn(
      async () => null,
    );

    const { ref, unmount } = mount();
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());

    const events: Array<unknown> = [];
    ref.current!.setOnElementPick((e) => events.push(e));
    const clickHandlers = h.canvasListeners.get("click")!;
    await clickHandlers[0]!({ clientX: 400, clientY: 300, button: 0 });

    expect(events).toEqual([null]);
    expect(ref.current!.getSelection().size).toBe(0);
    // A miss is authoritative — the id-pass tolerance rings do NOT re-scan.
    expect(h.fastPickerInstance.getItemAt).not.toHaveBeenCalled();
    unmount();
  });

  it("raycast-throws → id-pass fallback still selects (wedge/drift safety)", async () => {
    (h.fragmentsMock as unknown as RaycastSurface).raycast = vi.fn(async () => {
      throw new Error("worker wedged");
    });
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    h.fastPickerState.point = { x: 9, y: 9, z: 9 };

    const { ref, unmount } = mount();
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => expect(createLevelPlanController).toHaveBeenCalled());

    const events: Array<{ modelId?: string; expressId?: number } | null> = [];
    ref.current!.setOnElementPick((e) =>
      events.push(e ? { modelId: e.modelId, expressId: e.expressId } : null),
    );
    const clickHandlers = h.canvasListeners.get("click")!;
    await clickHandlers[0]!({ clientX: 400, clientY: 300, button: 0 });

    expect(events).toEqual([{ modelId: "B", expressId: 42 }]);
    expect(h.fastPickerInstance.getItemAt).toHaveBeenCalled();
    unmount();
  });
});

// ─── Wave 15: 3D section-plane clear (Clipper.deleteAll shape) ────────
//
// Regression for the field bug: "Clear cuts" was a silent no-op
// because `Clipper.deleteAll` filters by `plane.type`, not by plane id,
// and `createFromNormalAndCoplanarPoint` never assigns `type`. The mock
// below replicates that real contract (deleteAll deletes by type only;
// `list.delete(id)` deletes by id), so this test would FAIL if the
// source still used `deleteAll(new Set(ids))`.
describe("<IfcViewer> section planes (Wave 15 clear)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.clipperInstances.length = 0;
    h.clipStylerInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountHandle(): Promise<{
    ref: { current: IfcViewerHandle | null };
    unmount: () => void;
  }> {
    const ref = createRef<IfcViewerHandle>();
    const { unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(ref.current).not.toBeNull();
    });
    return { ref, unmount };
  }

  it("clearSectionPlanes empties the handle AND the clipper's plane set", async () => {
    const { ref, unmount } = await mountHandle();

    expect(
      ref.current!.addSectionPlane({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 }),
    ).toBe(true);
    expect(
      ref.current!.addSectionPlane({ x: 5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    ).toBe(true);

    expect(ref.current!.getSectionPlaneCount()).toBe(2);
    // The clipper mock keeps the same plane registry the engine does.
    expect(h.clipperInstances.length).toBe(1);
    expect(h.clipperInstances[0]!.list.size).toBe(2);

    ref.current!.clearSectionPlanes();

    expect(ref.current!.getSectionPlaneCount()).toBe(0);
    expect(ref.current!.getSectionPlanes()).toEqual([]);
    // The real bug left these behind — this assertion is the regression.
    expect(h.clipperInstances[0]!.list.size).toBe(0);

    unmount();
  });

  it("flipLastSectionPlane deletes the last plane and re-adds a flipped one", async () => {
    const { ref, unmount } = await mountHandle();

    expect(
      ref.current!.addSectionPlane({ x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: 1 }),
    ).toBe(true);
    expect(
      ref.current!.addSectionPlane({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }),
    ).toBe(true);

    const before = ref.current!.getSectionPlanes();
    expect(before[1]!.normal).toEqual({ x: 1, y: 0, z: 0 });

    ref.current!.flipLastSectionPlane();

    const after = ref.current!.getSectionPlanes();
    expect(after.length).toBe(2);
    // The most recent plane's normal is negated by the flip. (Negating
    // a zero component yields -0, so use abs() for the zero axes.)
    expect(after[1]!.normal.x).toBe(-1);
    expect(Math.abs(after[1]!.normal.y)).toBe(0);
    expect(Math.abs(after[1]!.normal.z)).toBe(0);
    // No net plane accumulation in the clipper (delete + recreate).
    expect(h.clipperInstances[0]!.list.size).toBe(2);

    unmount();
  });
});

// ─── Wave 29: interaction-cost fixes ──────────────────────────────
//
// Three changes to the click/load path, each pinned here:
//   1. the pick event fires in phase 1 instead of waiting behind the
//      depth pass (nothing in that path reads `event.point`);
//   2. `getPropertyDataForModel` walks the model in batches instead of
//      one fragments-worker round-trip per element;
//   3. measure activation removes the listener it actually added.

describe("<IfcViewer> wave 29 interaction costs", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.canvasListeners.clear();
    h.highlighterInstances.length = 0;
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = null;
    h.fragmentsMock.core.models.list.clear();
    vi.mocked(h.fastPickerInstance.getItemAt).mockReset();
    h.fastPickerInstance.getItemAt.mockImplementation(async () => null);
    vi.mocked(h.fastPickerInstance.getPointAt).mockReset();
    h.fastPickerInstance.getPointAt.mockImplementation(
      async () => h.fastPickerState.point,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mounted() {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    return { ref, unmount: utils.unmount };
  }

  it("fires the pick event in phase 1, before the depth anchor resolves", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 42,
    } as never);
    let release: (p: { x: number; y: number; z: number }) => void = () => undefined;
    h.fastPickerInstance.getPointAt.mockImplementation(
      () => new Promise((res) => { release = res; }),
    );

    const { ref, unmount } = await mounted();
    const events: Array<{ expressId?: number; point?: { x: number } } | null> = [];
    ref.current!.setOnElementPick((e) => events.push(e as never));

    const clickHandler = h.canvasListeners.get("click");
    expect(clickHandler?.length).toBeGreaterThan(0);
    const chain = Promise.resolve(
      clickHandler![0]!({ clientX: 400, clientY: 300, button: 0 }),
    );
    await new Promise((r) => setTimeout(r, 40));

    // The panel path is served immediately…
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ modelId: "B", expressId: 42 });
    // …while the anchor is still owed (deferred-anchor contract intact).
    expect(ref.current!.isSelectionPointPending()).toBe(true);

    release({ x: 1, y: 2, z: 3 });
    await chain;

    // Exactly ONE emit for the click — the anchor stashes, never re-fires.
    expect(events).toHaveLength(1);
    expect(ref.current!.getSelectionWorldPoint()).toEqual({ x: 1, y: 2, z: 3 });
    expect(ref.current!.isSelectionPointPending()).toBe(false);
    unmount();
  });

  it("getPropertyDataForModel batches: one RPC per chunk, ids kept in order", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => i + 1);
    const calls: number[][] = [];
    h.fragmentsMock.core.models.list.set("m-1", {
      getItemsIdsWithGeometry: async () => ids,
      getItemsData: async (chunk: number[]) => {
        calls.push(chunk);
        return chunk.map((id) => ({ Name: { value: `E${id}` } }));
      },
    } as never);

    const { ref, unmount } = await mounted();
    const rows = await ref.current!.getPropertyDataForModel("m-1");

    expect(rows).not.toBeNull();
    // completeness + order: a mis-pairing would poison every custom filter
    expect(rows!.map((r) => r.localId)).toEqual(ids);
    // 600 elements used to be 600 round-trips
    expect(calls.length).toBe(3);
    expect(calls[0]).toHaveLength(256);
    // an EMPTY id array means "every item in the model" to this API
    expect(calls.every((c) => c.length > 0)).toBe(true);
    unmount();
  });

  it("honors batchSize and falls back to per-element on a short batch", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const sizes: number[] = [];
    h.fragmentsMock.core.models.list.set("m-1", {
      getItemsIdsWithGeometry: async () => ids,
      getItemsData: async (chunk: number[]) => {
        sizes.push(chunk.length);
        // answer one row short, every time → length mismatch must be caught
        return chunk.slice(0, Math.max(0, chunk.length - 1)).map((id) => ({
          Name: { value: `E${id}` },
        }));
      },
    } as never);

    const { ref, unmount } = await mounted();
    const rows = await ref.current!.getPropertyDataForModel("m-1", {
      batchSize: 4,
    });

    expect(rows!.map((r) => r.localId)).toEqual(ids); // still complete
    expect(sizes[0]).toBe(4); // batchSize really applies
    // batches first (3 of them), then the per-element re-walk (10)
    expect(sizes.filter((s) => s === 1)).toHaveLength(10);
    unmount();
  });

  it("tool activation removes the pointermove listener it added", async () => {
    const { ref, unmount } = await mounted();
    const el = document.querySelector(".ifc-viewer") as HTMLElement;
    expect(el).toBeTruthy();

    const added: Array<{ type: string; fn: EventListener }> = [];
    const removed = new Set<{ type: string; fn: EventListener }>();
    const realAdd = el.addEventListener.bind(el);
    const realRemove = el.removeEventListener.bind(el);
    el.addEventListener = ((type, fn, opts) => {
      added.push({ type, fn: fn as EventListener });
      realAdd(type as string, fn, opts as boolean);
    }) as typeof el.addEventListener;
    el.removeEventListener = ((type, fn, opts) => {
      const match = added.find((a) => a.type === type && a.fn === fn);
      if (match) removed.add(match);
      realRemove(type as string, fn, opts as boolean);
    }) as typeof el.removeEventListener;

    // The pointermove wiring is installed by the tool switch (what
    // `openLevel` drives internally), not by `setMeasureMode`.
    ref.current!.setActiveTool("measure");
    await waitFor(() => {
      expect(added.some((a) => a.type === "pointermove")).toBe(true);
    });
    ref.current!.setActiveTool("navigation");

    // The pre-wave-29 bug: registered as "pointermove", removed as
    // "mousemove" ⇒ one permanent leaked raycasting listener per
    // activation, so the app slowed down the more measure was used.
    const leaked = added.filter(
      (a) => a.type === "pointermove" && !removed.has(a),
    );
    expect(leaked).toHaveLength(0);

    el.addEventListener = realAdd;
    el.removeEventListener = realRemove;
    unmount();
  });
});

// ─── Wave 30: the viewport-revision token ─────────────────────────
//
// Overlay layers (task pins, the tap-to-create marker) used to
// re-project every world point on every animation frame, forever,
// including while the camera and the canvas were frozen. They can now
// skip that work when `getViewportRevision()` reports no change, so
// the token's own contract is pinned here: conservative when there is
// nothing to hash, stable when nothing moved, and different whenever
// the projection differs.

describe("<IfcViewer> wave 30 viewport revision", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const cam of h.cameraInstances) {
      const three = cam.three as Record<string, unknown>;
      delete three.matrixWorldInverse;
      delete three.projectionMatrix;
    }
    delete (h.rendererDomElement as Record<string, unknown>).clientWidth;
    delete (h.rendererDomElement as Record<string, unknown>).clientHeight;
  });

  async function mounted() {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    return { ref, unmount: utils.unmount };
  }

  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  // The viewer assigns `world.camera = new OBC.OrthoPerspectiveCamera(…)`
  // at mount, so the object the handle reads is the tracked instance,
  // not `worldMock.camera`. Give it real projection state + a canvas box.
  function withProjection() {
    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const three = cam.three as Record<string, unknown>;
    three.matrixWorldInverse = { elements: IDENTITY.slice() };
    three.projectionMatrix = { elements: new Array(16).fill(0.5) };
    const dom = h.rendererDomElement as unknown as Record<string, number>;
    dom.clientWidth = 800;
    dom.clientHeight = 600;
    return {
      view: () => (three.matrixWorldInverse as { elements: number[] }).elements,
      proj: () => (three.projectionMatrix as { elements: number[] }).elements,
      setSize: (w: number) => {
        dom.clientWidth = w;
      },
    };
  }

  it("stays always-dirty when the engine exposes no matrices (tests / partial mounts)", async () => {
    const { ref, unmount } = await mounted();
    // No `matrixWorldInverse` on the mock camera: the only safe answer
    // is "assume it changed", which reproduces the pre-wave-30 loop.
    const a = ref.current!.getViewportRevision();
    expect(ref.current!.getViewportRevision()).not.toBe(a);
    unmount();
  });

  it("does not change while the projection is unchanged", async () => {
    const { ref, unmount } = await mounted();
    withProjection();
    const first = ref.current!.getViewportRevision();
    expect(ref.current!.getViewportRevision()).toBe(first);
    expect(ref.current!.getViewportRevision()).toBe(first);
    unmount();
  });

  it("changes when the camera moves, re-projects, or the canvas resizes", async () => {
    const { ref, unmount } = await mounted();
    const p = withProjection();
    const base = ref.current!.getViewportRevision();

    // orbit / pan: the view matrix's translation column
    p.view()[12] = 3;
    const moved = ref.current!.getViewportRevision();
    expect(moved).not.toBe(base);

    // fov / ortho zoom / near-far: the projection matrix
    p.proj()[0] = 0.75;
    expect(ref.current!.getViewportRevision()).not.toBe(moved);
    p.proj()[0] = 0.5;

    // and the viewport box itself, with both matrices untouched
    p.setSize(801);
    expect(ref.current!.getViewportRevision()).not.toBe(moved);
    p.setSize(800);
    expect(ref.current!.getViewportRevision()).toBe(moved);
    unmount();
  });

  it("ignores sub-pixel camera drift — the documented quantization limit", async () => {
    const { ref, unmount } = await mounted();
    const p = withProjection();
    p.view()[12] = 3;
    const at3 = ref.current!.getViewportRevision();
    // 1e-6 m is ~0.004 of the 1/4096 quantization step: invisible by design.
    p.view()[12] = 3 + 1e-6;
    expect(ref.current!.getViewportRevision()).toBe(at3);
    // 0.01 m is well past it.
    p.view()[12] = 3.01;
    expect(ref.current!.getViewportRevision()).not.toBe(at3);
    unmount();
  });
});

// ─── Wave 30: worldToScreen without per-point layout reads ─────────
//
// Overlay layers project one point per pin per frame. Each call used
// to run `getBoundingClientRect()` — a forced layout flush — so a
// 50-pin cloud cost 50 layout flushes every frame. The handle now
// takes the viewport box from three's own stored size and keeps the
// rect only as the fallback.

describe("<IfcViewer> wave 30 worldToScreen viewport box", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of h.rendererInstances) {
      delete (r.three as Record<string, unknown>).getSize;
    }
    const cam = h.cameraInstances[h.cameraInstances.length - 1];
    if (cam) delete (cam.three as Record<string, unknown>).position;
  });

  async function mounted() {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    return { ref, unmount: utils.unmount };
  }

  // A `Vector3` stand-in: `worldToScreen` builds its projection
  // vector through `camera.three.position.constructor` (drift-clean
  // runtime reuse), so handing it a class with `.project()` is what
  // the real three.js path does.
  class ProjVector {
    constructor(
      public x: number,
      public y: number,
      public z: number,
    ) {}
    project() {
      this.x = 0.5; // NDC → deterministic, known output
      this.y = -0.25;
      return this;
    }
  }

  function cameraAtNdc() {
    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    (cam.three as Record<string, unknown>).position = {
      x: 0,
      y: 0,
      z: 0,
      constructor: ProjVector,
    };
  }

  it("uses the renderer's stored size and touches no layout", async () => {
    const { ref, unmount } = await mounted();
    cameraAtNdc();
    const rendererThree = h.rendererInstances[
      h.rendererInstances.length - 1
    ]!.three as Record<string, unknown>;
    rendererThree.getSize = (t: { set: (x: number, y: number) => unknown }) =>
      t.set(400, 200);
    const rectSpy = vi.spyOn(h.rendererDomElement, "getBoundingClientRect");

    expect(ref.current!.worldToScreen({ x: 1, y: 1, z: 1 })).toEqual({
      x: 300, //   ((0.5 + 1) / 2) * 400
      y: 125, //   ((-(-0.25) + 1) / 2) * 200
    });
    expect(rectSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("still falls back to the canvas rect when three cannot answer", async () => {
    const { ref, unmount } = await mounted();
    cameraAtNdc();
    // The harness rect is 800×600 (set in the store-the-listener double).
    const rectSpy = vi.spyOn(h.rendererDomElement, "getBoundingClientRect");
    const p = ref.current!.worldToScreen({ x: 1, y: 1, z: 1 });
    expect(rectSpy).toHaveBeenCalledTimes(1);
    expect(p).toEqual({ x: 600, y: 375 });
    unmount();
  });

  it("falls back when three reports a zero (unmeasured) viewport", async () => {
    const { ref, unmount } = await mounted();
    cameraAtNdc();
    const rendererThree = h.rendererInstances[
      h.rendererInstances.length - 1
    ]!.three as Record<string, unknown>;
    rendererThree.getSize = (t: { set: (x: number, y: number) => unknown }) =>
      t.set(0, 0);
    const rectSpy = vi.spyOn(h.rendererDomElement, "getBoundingClientRect");
    expect(ref.current!.worldToScreen({ x: 1, y: 1, z: 1 })).toEqual({
      x: 600,
      y: 375,
    });
    expect(rectSpy).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ─── Wave 31: version hot-swap ─────────────────────────────────────
//
// `replaceIfcVersion()` keeps the same `IfcFileRecord.id` and only mints
// a new `fragBlobKey`. The load effect used to guard on `file.id` alone,
// so after an admin replaced a model's version the viewer kept rendering
// the replaced-out geometry until a building switch, and the property
// index — keyed by that same file id — kept answering with the old
// version's values. The effect's own comment promised it handled
// "version promoted to latest"; the guard silently vetoed it.
//
// These are the first tests to drive the `files` prop at all — which is
// exactly why the bug survived every gate before this one.

describe("<IfcViewer> wave 31 version hot-swap", () => {
  const FILE = { id: "f1", name: "tower.ifc", buildingId: "b" };
  const V1 = { id: "v1", fragBlobKey: "f1__v1", versionNumber: 1 };
  const V2 = { id: "v2", fragBlobKey: "f1__v2", versionNumber: 2 };

  const fakeBlob = {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    size: 3,
    type: "application/octet-stream",
  } as unknown as Blob;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    vi.mocked(h.fragmentsMock.core.load).mockClear();
    vi.mocked(h.fragmentsMock.core.load).mockResolvedValue({
      object: {},
      setLodMode: vi.fn(async () => undefined),
    } as never);
    vi.mocked(h.fragmentsMock.core.disposeModel).mockClear();
    vi.mocked(h.fragmentsMock.core.disposeModel).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountedWith(
    files: Array<{ file: typeof FILE; latestVersion: typeof V1 | null }>,
    blobKeys: string[] = [],
  ) {
    const ref = createRef<IfcViewerHandle>();
    const getFragBlob = vi.fn(async (key: string) => {
      blobKeys.push(key);
      return fakeBlob;
    });
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files as never}
        getFragBlob={getFragBlob as never}
      />,
    );
    await waitFor(() => {
      expect(h.fragmentsMock.core.load).toHaveBeenCalled();
    });
    return { ref, rerender: utils.rerender, unmount: utils.unmount, getFragBlob };
  }

  const list = (files: Array<{ file: typeof FILE; latestVersion: typeof V1 | null }>) =>
    files as never;

  it("loads a model once and fetches its version's blob key", async () => {
    const keys: string[] = [];
    const { unmount } = await mountedWith(list([{ file: FILE, latestVersion: V1 }]), keys);
    expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(h.fragmentsMock.core.load).mock.calls[0]![1],
    ).toMatchObject({ modelId: "f1" });
    expect(keys).toEqual(["f1__v1"]);
    expect(h.fragmentsMock.core.disposeModel).not.toHaveBeenCalled();
    unmount();
  });

  it("does NOT re-load when a live-query tick only changes array identity", async () => {
    // Dexie re-emits a fresh array on every tick. The old guard made
    // that cheap; the new version-aware guard must not turn every tick
    // into a dispose/reload cycle.
    const { unmount } = await mountedWith(list([{ file: FILE, latestVersion: V1 }]));
    const afterFirst = vi.mocked(h.fragmentsMock.core.load).mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(h.fragmentsMock.core.load)).toHaveBeenCalledTimes(afterFirst);
    unmount();
  });

  it("wave 63: a version swap re-opens the level plan that was open", async () => {
    const { rerender, unmount } = await mountedWith(list([{ file: FILE, latestVersion: V1 }]));
    const results = vi.mocked(createLevelPlanController).mock.results;
    const ctrl = results[results.length - 1]!.value as {
      activeStoreyName: string | null;
      open: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(1));
    ctrl.activeStoreyName = "L1";
    ctrl.close.mockClear();
    ctrl.close.mockImplementation(() => {
      ctrl.activeStoreyName = null;
    });
    ctrl.open.mockClear();
    ctrl.open.mockImplementation(async (name: string) => {
      ctrl.activeStoreyName = name;
      return true;
    });
    rerender(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(ctrl.open).toHaveBeenCalledWith("L1"));
    expect(ctrl.close).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("wave 63: a version swap with NO plan open does not close (move the camera)", async () => {
    const { rerender, unmount } = await mountedWith(list([{ file: FILE, latestVersion: V1 }]));
    const results = vi.mocked(createLevelPlanController).mock.results;
    const ctrl = results[results.length - 1]!.value as {
      close: ReturnType<typeof vi.fn>;
      open: ReturnType<typeof vi.fn>;
    };
    ctrl.close.mockClear();
    rerender(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.close).not.toHaveBeenCalled();
    expect(ctrl.open).not.toHaveBeenCalled();
    unmount();
  });

  it("wave 63: a remount (new registerFragments) reloads models and resets per-model refs", async () => {
    const ref = createRef<IfcViewerHandle>();
    const files = list([{ file: FILE, latestVersion: V1 }]);
    const regA = vi.fn();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files}
        registerFragments={regA}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ref.current!.loadedModelIds.has("f1")).toBe(true));
    const regB = vi.fn();
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files}
        registerFragments={regB}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    // The mount effect re-ran: the new fragments instance must get the
    // model again (the stale per-model refs used to say "already loaded").
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2), {
      timeout: 4000,
    });
    utils.unmount();
  });

  it("swaps in the new version when the same file id gets a new blob key", async () => {
    const keys: string[] = [];
    const counts: number[] = [];
    const { ref, rerender, unmount } = await mountedWith(
      list([{ file: FILE, latestVersion: V1 }]),
      keys,
    );
    expect(ref.current!.getModelVersionKey("f1")).toBe("f1__v1");
    ref.current!.onLoadedModelsChange((n) => counts.push(n));

    rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={async (k: string) => {
          keys.push(k);
          return fakeBlob;
        }}
      />,
    );

    await waitFor(() => {
      expect(h.fragmentsMock.core.disposeModel).toHaveBeenCalledWith("f1");
    });
    await waitFor(() => {
      expect(vi.mocked(h.fragmentsMock.core.load).mock.calls.length).toBe(2);
    });
    // the NEW bytes, not v1's
    expect(keys).toEqual(["f1__v1", "f1__v2"]);
    // the handle now reports the version that is actually loaded — this
    // is what the property index compares against to detect staleness
    expect(ref.current!.getModelVersionKey("f1")).toBe("f1__v2");
    expect(ref.current!.getModelVersionKey("not-loaded")).toBeNull();
    // listeners saw the model go away (index prune) and come back (rebuild)
    expect(counts).toContain(0);
    expect(counts[counts.length - 1]).toBe(1);
    // and the version map settled on v2 — a third render must be inert
    rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={async () => fakeBlob}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(vi.mocked(h.fragmentsMock.core.load).mock.calls.length).toBe(2);
    expect(keys).toEqual(["f1__v1", "f1__v2"]);
    ref.current!.onLoadedModelsChange(null);
    unmount();
  });

  it("does not teleport the camera when a version swaps under the viewer", async () => {
    const { ref, rerender, unmount } = await mountedWith(
      list([{ file: FILE, latestVersion: V1 }]),
    );
    // `setLookAt` lives on the camera-controls instance, not the
    // camera, and the mock records from creation so the fresh-load
    // framing call (which happens before this line) is counted.
    const cam = h.cameraInstances[h.cameraInstances.length - 1]!;
    const setLookAt = cam.controls.setLookAt as unknown as vi.Mock;
    expect(setLookAt.mock.calls.length).toBeGreaterThan(0); // fresh load frames
    const before = setLookAt.mock.calls.length;

    rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={async () => fakeBlob}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.disposeModel).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 60));
    // the user was already looking at this building; jumping to the
    // demo pose on every upload would read as a glitch
    expect(setLookAt.mock.calls.length).toBe(before);
    unmount();
  });

  it("drops the selection when the model it referred to is swapped out", async () => {
    const { ref, rerender, unmount } = await mountedWith(
      list([{ file: FILE, latestVersion: V1 }]),
    );
    const seen: number[] = [];
    ref.current!.onSelectionChange((sel) => seen.push(sel.size));
    ref.current!.selectElement("f1", 42);
    await waitFor(() => expect(ref.current!.getSelection().size).toBe(1));

    rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={list([{ file: FILE, latestVersion: V2 }])}
        getFragBlob={async () => fakeBlob}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.disposeModel).toHaveBeenCalled());
    await waitFor(() => expect(ref.current!.getSelection().size).toBe(0));
    expect(seen[seen.length - 1]).toBe(0); // listeners were told, not just state
    ref.current!.onSelectionChange(null);
    unmount();
  });
});

// ─── Wave 31b: the pipeline exists without a subscriber ─────────────
//
// `installPickSubscription` used to begin with `if (!cb) return;`, so the
// canvas click handler was installed ONLY as a side effect of some
// consumer calling `setOnElementPick(cb)`. On a route that renders the
// viewer without a pick subscriber — the admin authoring shell, which
// mounts no PropertiesDrawer — the canvas simply had no click handler:
// clicking a model did nothing at all, with no error anywhere.

describe("<IfcViewer> wave 31b selection without a pick subscriber", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.canvasListeners.clear();
    h.fragmentsMock.core.models.list.clear();
    h.fastPickerState.failInit = false;
    h.fastPickerState.point = null;
    vi.mocked(h.fastPickerInstance.getItemAt).mockReset();
    h.fastPickerInstance.getItemAt.mockImplementation(async () => null);
    vi.mocked(h.fastPickerInstance.getPointAt).mockReset();
    h.fastPickerInstance.getPointAt.mockImplementation(async () => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mounted() {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    return { ref, unmount: utils.unmount };
  }

  it("installs the click pipeline at mount with nobody subscribed", async () => {
    const { unmount } = await mounted();
    // No setOnElementPick call anywhere in this test.
    expect(h.canvasListeners.get("click")?.length).toBeGreaterThan(0);
    unmount();
  });

  it("a click still applies the selection when nobody is told about it", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 77,
    } as never);
    const { ref, unmount } = await mounted();
    // deliberately NOT calling setOnElementPick

    const clicks = h.canvasListeners.get("click");
    expect(clicks?.length).toBeGreaterThan(0);
    await clicks![0]!({ clientX: 400, clientY: 300, button: 0 });
    await waitFor(() => {
      expect(ref.current!.getSelection().get("B")?.has(77)).toBe(true);
    });
    // the highlight was queued for the engine too
    await waitFor(() => {
      expect(h.fragmentsMock.highlight).toHaveBeenCalled();
    });
    unmount();
  });

  it("an empty-space click clears the selection without a subscriber", async () => {
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce({
      modelId: "B",
      localId: 91,
    } as never);
    const { ref, unmount } = await mounted();
    const clicks = h.canvasListeners.get("click")!;
    await clicks[0]!({ clientX: 400, clientY: 300, button: 0 });
    await waitFor(() => {
      expect(ref.current!.getSelection().size).toBe(1);
    });

    // second click on void
    vi.mocked(h.fastPickerInstance.getItemAt).mockResolvedValueOnce(null as never);
    await clicks[0]!({ clientX: 401, clientY: 301, button: 0 });
    await waitFor(() => {
      expect(ref.current!.getSelection().size).toBe(0);
    });
    unmount();
  });

  it("awaits the previous building's disposes before loading the next", async () => {
    // A building switch used to fire disposeModel and forget about it, so
    // the new building's core.load() raced the old model's removal in the
    // same saturated worker: both models stayed registered, and the GPU id
    // pass renders EVERY registered model — extra cost per click plus the
    // chance of selecting geometry from a building the user already left.
    const order: string[] = [];
    vi.mocked(h.fragmentsMock.core.disposeModel).mockImplementation(async () => {
      order.push("dispose:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("dispose:end");
    });
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(async () => {
      order.push("load");
      return { object: {} } as never;
    });
    const blob = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Blob;

    const fileA = { id: "fa", name: "a.ifc", buildingId: "b1" };
    const fileB = { id: "fb", name: "b.ifc", buildingId: "b2" };
    const vA = { id: "va", fragBlobKey: "fa__v1", versionNumber: 1 };
    const vB = { id: "vb", fragBlobKey: "fb__v1", versionNumber: 1 };

    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b1"
        files={[{ file: fileA, latestVersion: vA }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await waitFor(() => {
      expect(order).toContain("load");
    });
    expect(ref.current!.getModelVersionKey("fa")).toBe("fa__v1");

    order.length = 0;
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b2"
        files={[{ file: fileB, latestVersion: vB }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await waitFor(() => {
      expect(order).toContain("load");
    });
    // the dispose finished BEFORE the new model was loaded
    expect(order.slice(0, 3)).toEqual(["dispose:start", "dispose:end", "load"]);
    // and only the new building's model is tracked
    expect([...ref.current!.loadedModelIds]).toEqual(["fb"]);
    utils.unmount();
  });

  it("onLoadedModelsChange's unsubscribe keeps the other listeners (wave 63)", async () => {
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(async () => ({ object: {} }) as never);
    const blob = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Blob;
    const ref = createRef<IfcViewerHandle>();
    const fileA = { id: "fa", name: "a.ifc", buildingId: "b1" };
    const vA = { id: "va", fragBlobKey: "fa__v1", versionNumber: 1 };
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b1" getFragBlob={async () => blob} />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    const a: number[] = [];
    const b: number[] = [];
    const offA = ref.current!.onLoadedModelsChange((n) => a.push(n));
    ref.current!.onLoadedModelsChange((n) => b.push(n));
    offA();
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b1"
        files={[{ file: fileA, latestVersion: vA }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await waitFor(() => expect(b).toContain(1));
    expect(a).toEqual([]);
    utils.unmount();
  });

  it("ignores the stale previous-building file list on a building switch (wave 63)", async () => {
    // Dexie's useLiveQuery hands back the OLD building's rows for one
    // render after activeBuildingId changes. The load pass must not
    // reload those models under the new building.
    vi.mocked(h.fragmentsMock.core.disposeModel).mockImplementation(async () => undefined);
    const loaded: string[] = [];
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(async (_b: unknown, opts: unknown) => {
      loaded.push((opts as { modelId: string }).modelId);
      return { object: {} } as never;
    });
    const blob = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Blob;
    const fileA = { id: "fa", name: "a.ifc", buildingId: "b1" };
    const vA = { id: "va", fragBlobKey: "fa__v1", versionNumber: 1 };
    const fileB = { id: "fb", name: "b.ifc", buildingId: "b2" };
    const vB = { id: "vb", fragBlobKey: "fb__v1", versionNumber: 1 };
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b1"
        files={[{ file: fileA, latestVersion: vA }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await waitFor(() => expect(loaded).toContain("fa"));
    loaded.length = 0;
    // stale emission: new building id, OLD building's files
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b2"
        files={[{ file: fileA, latestVersion: vA }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(loaded).toEqual([]);
    expect([...ref.current!.loadedModelIds]).toEqual([]);
    // fresh emission: the new building's files load
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b2"
        files={[{ file: fileB, latestVersion: vB }] as never}
        getFragBlob={async () => blob}
      />,
    );
    await waitFor(() => expect(loaded).toEqual(["fb"]));
    utils.unmount();
  });
});


// ─── Wave 32: the StrictMode zombie mount ─────────────────────────────
//
// React 18 StrictMode runs mount → cleanup → mount. The mount effect
// deliberately resets the shared `disposedRef` so the second pass is not
// strangled by the first pass's cleanup — but that same reset UN-KILLS the
// first pass's in-flight async setup, which resumes against objects its own
// cleanup already disposed, installs a SECOND pick pipeline on the canvas,
// and overwrites the live mount's refs with the dead ones.
//
// Field symptom (Maintainer screenshot): elements keep the colour painted before
// the race, new clicks never colour, and the backend silently degrades —
// console shows "highlighter.setup skipped: world.renderer was disposed
// (StrictMode race)" and "fast pick init failed — backend: raycaster".
//
// The fix is a per-mount generation: a pass whose mount has been superseded
// bails, and a cleanup that no longer owns the refs cannot clear them.

describe("<IfcViewer> wave 32 StrictMode zombie mount", () => {
  afterEach(() => {
    // NOT vi.unstubAllGlobals(): the file-level stubs installed above
    // (fetch + URL.createObjectURL, which the mount needs to resolve the
    // worker) are module-scoped, and unstubbing globals here silently
    // removed them for every test that runs after this one — the mount
    // then died before createLevelPlanController and the failures looked
    // like they belonged to the next describe block.
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => "// worker stub",
    } as Response));
    resetFragmentsWorkerCache();
    vi.restoreAllMocks();
  });

  it("installs exactly one click pipeline across a StrictMode double mount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.canvasListeners.clear();
    resetFragmentsWorkerCache();

    // Hold the worker fetch open so BOTH mount passes are parked inside
    // their async setup at the moment the gate releases — that is the
    // window in which the first pass becomes a zombie.
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    vi.stubGlobal("fetch", async () => {
      await gate;
      return { ok: true, status: 200, text: async () => "/* worker */" };
    });

    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <StrictMode>
        <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 25)); // mount1 → cleanup1 → mount2
    release();

    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 200));

    const clickHandlers = h.canvasListeners.get("click")?.length ?? 0;
    // Invariant: exactly one pick pipeline per live mount.
    //
    // HONEST SCOPE NOTE: this assertion does NOT reproduce the wave-32
    // zombie. Verified by experiment — neutering the generation guard
    // leaves this test green, because the jsdom harness shares one mock
    // world across mounts and never disposes it, so the first pass bails
    // for another reason before it can double-install. The zombie fix is
    // evidenced by the live run instead (no "highlighter.setup skipped" /
    // "fast pick init failed" console output, backend stays `fast`, and a
    // second click resets the first element's tint). This test stays
    // because the one-pipeline invariant is worth pinning on its own.
    expect(clickHandlers).toBe(1);
    // the live mount still answers the handle API
    expect(typeof ref.current!.getViewportRevision()).toBe("number");

    utils.unmount();
  });
});


// ─── Wave 32: the fragments view must follow the camera ───────────────
//
// Fragments re-pushes tiles only inside `FragmentsModels.update()`
// (REFRESH_VIEW -> the worker re-samples the frustum). Nothing called it
// after the initial load: TOE's own `Views` component wires camera 'rest'
// to it, and this viewer replaced Views with LevelPlanController, losing
// that wiring. Measured on a 38 MB MEP model — 20 s idle: 0 tiles in the
// scene; 40 s: 0; orbit: 0; ONE explicit core.update(): tiles appear.
// With no tiles the GPU id pass renders nothing, so every pick reads void.

describe("<IfcViewer> wave 32 camera-driven view refresh", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    for (const k of Object.keys(h.cameraControlListeners)) {
      delete h.cameraControlListeners[k];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mounted() {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    return { ref, unmount: utils.unmount };
  }

  const NAV_EVENTS = ["control", "controlend", "controlstart", "rest", "sleep", "transitionstart", "update"];
  // Render on demand listens to the same camera events (plus 'wake') to
  // redraw on camera change: one listener from the navigation speedups and
  // one from the render scheduler per navigation event.
  const ROD_ONLY_EVENTS = ["wake"];

  it("refreshes the fragments view once per settle, not per drag step", async () => {
    const { unmount } = await mounted();
    const l = h.cameraControlListeners;
    expect(Object.keys(l).sort()).toEqual([...NAV_EVENTS, ...ROD_ONLY_EVENTS].sort());
    for (const k of NAV_EVENTS) expect(l[k].length).toBe(2);
    for (const k of ROD_ONLY_EVENTS) expect(l[k].length).toBe(1);

    // Motion: the models are frozen, so a drag step does NOT refresh.
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    for (const cb of l.control) cb();
    expect(h.fragmentsMock.core.update).not.toHaveBeenCalled();

    for (const cb of l.rest) cb();
    await waitFor(() =>
      expect(h.fragmentsMock.core.update).toHaveBeenCalledTimes(1),
    );

    // An instant programmatic jump (update → sleep) also ends with a refresh.
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    for (const cb of l.update) cb();
    for (const cb of l.sleep) cb();
    expect(h.fragmentsMock.core.update).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("freezes loaded models while moving and unfreezes them at rest", async () => {
    const model = { object: { children: [], visible: true }, frozen: false };
    h.fragmentsMock.core.models.list.set("m1", model as never);
    const { unmount } = await mounted();
    const l = h.cameraControlListeners;
    for (const cb of l.control) cb();
    expect(model.frozen).toBe(true);
    for (const cb of l.rest) cb();
    await waitFor(() => expect(model.frozen).toBe(false));
    h.fragmentsMock.core.models.list.clear();
    unmount();
  });

  it("a missed rest is recovered by the safety timer", async () => {
    const model = { object: { children: [], visible: true }, frozen: false };
    h.fragmentsMock.core.models.list.set("m1", model as never);
    const { unmount } = await mounted();
    for (const cb of h.cameraControlListeners.control) cb();
    expect(model.frozen).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(model.frozen).toBe(false);
    h.fragmentsMock.core.models.list.clear();
    unmount();
  });

  it("refreshes UNFORCED — a forced flush parks behind streaming", async () => {
    // core.update(true) waits for a worker FINISH stamped past the current
    // sequence, i.e. behind every queued tile and storage download. That is
    // the stall wave 28 removed from the click path; the camera handler must
    // not reintroduce it.
    const { unmount } = await mounted();
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    for (const cb of h.cameraControlListeners.control) cb();
    for (const cb of h.cameraControlListeners.rest) cb();
    await waitFor(() => expect(h.fragmentsMock.core.update).toHaveBeenCalled());
    const cameraCall =
      h.fragmentsMock.core.update.mock.calls[
        h.fragmentsMock.core.update.mock.calls.length - 1
      ];
    expect(cameraCall).toEqual([]);
    unmount();
  });

  it("detaches exactly the listeners it attached, on unmount", async () => {
    const { unmount } = await mounted();
    for (const k of NAV_EVENTS) expect(h.cameraControlListeners[k].length).toBe(2);
    for (const k of ROD_ONLY_EVENTS) expect(h.cameraControlListeners[k].length).toBe(1);
    unmount();
    for (const k of [...NAV_EVENTS, ...ROD_ONLY_EVENTS]) {
      expect(h.cameraControlListeners[k].length).toBe(0);
    }
  });

  it("re-points every model at the new camera on a projection change", async () => {
    const useCamera = vi.fn();
    h.fragmentsMock.core.models.list.set("m1", {
      useCamera,
      object: { children: [] },
    } as never);
    const { unmount } = await mounted();
    const cam = h.cameraInstances[h.cameraInstances.length - 1] as unknown as {
      projectionHandlers: Set<(c: unknown) => void>;
    };
    expect(cam.projectionHandlers.size).toBe(1);
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    const ortho = { isOrthographicCamera: true };
    for (const fn of cam.projectionHandlers) fn(ortho);
    expect(useCamera).toHaveBeenCalledWith(ortho);
    expect(h.fragmentsMock.core.update).toHaveBeenCalled();
    unmount();
    expect(cam.projectionHandlers.size).toBe(0);
    h.fragmentsMock.core.models.list.clear();
  });
});

// ─── Wave 33: full geometry per model so thin MEP is pickable ─────
//
// Thin/small MEP elements are tessellated by fragments as LOD "wire"
// stand-ins (ObjectClass.LINE) that carry `position/itemFirst/itemLast`
// but NOT a per-vertex `id`. The GPU id pass hides such meshes
// (applyIdMaterial), so they can never be selected/tinted: the field
// asymmetry "structural OK, MEP never". The fix force-sets
// LodMode.ALL_GEOMETRY per load (and per version-swap re-load) and then
// fires an UNFORCED `core.update()` — setLodMode only QUEUES the
// re-tessellation, the follow-up update is what actually re-pushes.

describe("<IfcViewer> wave 33 full-geometry LOD per load", () => {
  const FILE = { id: "f1", name: "tower.ifc", buildingId: "b" };
  const V1 = { id: "v1", fragBlobKey: "f1__v1", versionNumber: 1 };
  const V2 = { id: "v2", fragBlobKey: "f1__v2", versionNumber: 2 };

  const fakeBlob = {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    size: 3,
    type: "application/octet-stream",
  } as unknown as Blob;

  // The `setLodMode` spy hangs off the (shared) object `load` resolves to.
  // Each test re-arms it in beforeEach so assertions on call count/args are
  // isolated per test.
  let lodSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    lodSpy = vi.fn(async () => undefined);
    vi.mocked(h.fragmentsMock.core.load).mockClear();
    vi.mocked(h.fragmentsMock.core.load).mockResolvedValue({
      object: {},
      setLodMode: lodSpy,
    } as never);
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    vi.mocked(h.fragmentsMock.core.disposeModel).mockClear();
    vi.mocked(h.fragmentsMock.core.disposeModel).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountedWith(
    files: Array<{ file: typeof FILE; latestVersion: typeof V1 | null }>,
    getFragBlob = async () => fakeBlob,
  ) {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files as never}
        getFragBlob={getFragBlob as never}
      />,
    );
    await waitFor(() => {
      expect(h.fragmentsMock.core.load).toHaveBeenCalled();
    });
    return { ref, rerender: utils.rerender, unmount: utils.unmount };
  }

  it("arms ALL_GEOMETRY per model load (background, after the gate)", async () => {
    const { unmount } = await mountedWith([{ file: FILE, latestVersion: V1 }]);
    // Wave 38: the LOD call moved OFF the load loop into the background
    // phase (after the settle check lifts the gate), so allow more than
    // the default 1 s waitFor window.
    await waitFor(
      () => {
        expect(lodSpy).toHaveBeenCalledWith(LodMode.ALL_GEOMETRY);
      },
      { timeout: 6000 },
    );
    expect(lodSpy).toHaveBeenCalledTimes(1);
    // ALL_GEOMETRY: real geometry, no wire stand-ins; never the
    // pose-independent ALL_VISIBLE sweep.
    expect(lodSpy).not.toHaveBeenCalledWith(LodMode.ALL_VISIBLE);
    unmount();
  });

  it("arms ALL_GEOMETRY again on a version-swap re-load", async () => {
    const { ref, rerender, unmount } = await mountedWith([
      { file: FILE, latestVersion: V1 },
    ]);
    rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={[{ file: FILE, latestVersion: V2 }] as never}
        getFragBlob={async () => fakeBlob}
      />,
    );
    await waitFor(() => {
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2);
    });
    // one LOD call per load: the swap dispose + re-load must re-arm it.
    // Wave 38: both calls happen in background phases (the first pass
    // may be superseded mid-settle — its queue entry survives on the
    // component-level pendingWarmRef for the next pass to consume).
    await waitFor(
      () => {
        expect(lodSpy).toHaveBeenCalledTimes(2);
      },
      { timeout: 6000 },
    );
    expect(lodSpy).toHaveBeenNthCalledWith(1, LodMode.ALL_GEOMETRY);
    expect(lodSpy).toHaveBeenNthCalledWith(2, LodMode.ALL_GEOMETRY);
    unmount();
  });

  it("runs ONE unforced update after setLodMode (no rAF pump)", async () => {
    const { unmount } = await mountedWith([{ file: FILE, latestVersion: V1 }]);
    await waitFor(
      () => {
        expect(lodSpy).toHaveBeenCalled();
      },
      { timeout: 6000 },
    );
    const lodCallOrder = lodSpy.mock.invocationCallOrder[0] as number;
    const update = h.fragmentsMock.core.update;
    // After the LOD arm, one UNFORCED update() lets the apply loop run.
    // The FORCED initial push update(true) runs BEFORE the LOD call and
    // must not count.
    await waitFor(
      () => {
        const unforced = update.mock.calls.map((c, i) => ({
          args: c,
          order: update.mock.invocationCallOrder[i] as number,
        }));
        expect(
          unforced.some((u) => u.args.length === 0 && u.order > lodCallOrder),
        ).toBe(true);
      },
      { timeout: 6000 },
    );
    unmount();
  });

  it("a stale (unmounted) load does NOT call setLodMode or the unforced update", async () => {
    // Park the load so the IIFE is suspended across an await at unmount
    // time; the resumed pass belongs to a dead mount and must bail.
    let resolveLoad!: (m: unknown) => void;
    const loadGate = new Promise((res) => {
      resolveLoad = res;
    });
    vi.mocked(h.fragmentsMock.core.load).mockReturnValue(loadGate as never);

    const { unmount } = await mountedWith([{ file: FILE, latestVersion: V1 }]);
    expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(1);

    unmount();
    const staleSpy = vi.fn(async () => undefined);
    // The in-flight load resolves after the view is gone.
    resolveLoad({ object: {}, setLodMode: staleSpy });
    await new Promise((r) => setTimeout(r, 30));

    expect(staleSpy).not.toHaveBeenCalled();
    // no UNFORCED update may have been emitted for the stale load
    const unforced = h.fragmentsMock.core.update.mock.calls.filter(
      (c) => c.length === 0,
    );
    expect(unforced).toEqual([]);
  });
});

// ─── Wave 34: the loading gate covers the WHOLE load+warm window ───
//
// Wave 33 armed `isStreaming` only AFTER the sequential load loop
// finished, so the overlay lifted at the first model while the shared
// fragments worker was still saturating on the remaining loads,
// force-flushes and ALL_GEOMETRY re-tessellation. Measured on Demo
// Tower (3 models): overlay lifted t=3.4 s, pickAt latency 1.5–10.3 s
// until t≈69 s, then 57–104 ms — the customer-visible "clicks don't
// land for 30 s" cold window. The gate now arms at pass start when
// fresh loads are pending, reports per-model progress, and lifts only
// after the post-loop quiet-ticks drain (or immediately when nothing
// loaded, so failures never pin the loader).

describe("<IfcViewer> wave 34 loading gate covers load+warm window", () => {
  const F1 = { id: "f1", name: "struct.ifc", buildingId: "b" };
  const F2 = { id: "f2", name: "mep.ifc", buildingId: "b" };
  const V1 = { id: "v1", fragBlobKey: "f1__v1", versionNumber: 1 };
  const V1B = { id: "v1b", fragBlobKey: "f2__v1", versionNumber: 1 };
  const V2 = { id: "v2", fragBlobKey: "f1__v2", versionNumber: 2 };

  const fakeBlob = {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    size: 3,
    type: "application/octet-stream",
  } as unknown as Blob;

  const overlayEl = () =>
    document.querySelector<HTMLElement>(
      '[data-testid="viewer-loading-overlay"]',
    );
  const overlayText = () => overlayEl()?.textContent ?? "";
  const gateUp = () => /Loading model/.test(overlayText());

  beforeEach(() => {
    __resetViewerSessionLoadedFlag();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    vi.mocked(h.fragmentsMock.core.load).mockClear();
    vi.mocked(h.fragmentsMock.core.load).mockResolvedValue({
      object: {},
      setLodMode: vi.fn(async () => undefined),
    } as never);
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    vi.mocked(h.fragmentsMock.core.update).mockResolvedValue(undefined);
    vi.mocked(h.fragmentsMock.core.disposeModel).mockClear();
    vi.mocked(h.fragmentsMock.core.disposeModel).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("arms the gate at pass start while loads are still pending", async () => {
    // Park every load: pre-fix the overlay showed "Initializing 3D
    // viewer…" here (gate armed only after the loop); post-fix the
    // pass-start arm must already report loading progress.
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[
          { file: F1, latestVersion: V1 },
          { file: F2, latestVersion: V1B },
        ] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(true), { timeout: 4000 });
    expect(overlayText()).toContain("Loading model 1 of 2");
    utils.unmount();
  });

  it("advances the progress counter as each fresh load completes", async () => {
    let resolveFirst!: (m: unknown) => void;
    const firstGate = new Promise((res) => {
      resolveFirst = res;
    });
    vi.mocked(h.fragmentsMock.core.load)
      .mockReturnValueOnce(firstGate as never)
      .mockImplementation(() => new Promise(() => undefined) as never);
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[
          { file: F1, latestVersion: V1 },
          { file: F2, latestVersion: V1B },
        ] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(gateUp()).toBe(true), { timeout: 4000 });
    expect(overlayText()).toContain("Loading model 1 of 2");
    resolveFirst({ object: {}, setLodMode: vi.fn(async () => undefined) });
    await waitFor(() => expect(overlayText()).toContain("Loading model 2 of 2"), {
      timeout: 4000,
    });
    utils.unmount();
  });

  it("lifts the gate only after the post-loop settle check (single fresh load)", async () => {
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    // Single fresh load: no "N of M" counter, but the gate text shows.
    await waitFor(() => expect(gateUp()).toBe(true), { timeout: 4000 });
    expect(overlayText()).toContain("Loading model geometry");
    // Wave 42: the overlay is FULL-SCREEN (fixed, viewport-relative)
    // so the toolbar / task pins / rail are hidden while loading.
    expect(overlayEl()?.style.position).toBe("fixed");
    // Wave 36 phase 1: the settle check polls isBusy every 250 ms and
    // needs only 2 quiet ticks (~500 ms) before the gate lifts — the
    // long full-drain wait moved to the background (phase 2).
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    utils.unmount();
  });

  it("wave 36: the background drain never re-arms the overlay", async () => {
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    // Worker goes busy AFTER the lift (phase-2 drain window): the
    // overlay must stay down — phase 2 is telemetry-only and must not
    // touch overlay state.
    h.fragmentsMock.core.models.list.set("m1", { isBusy: true } as never);
    await new Promise((r) => setTimeout(r, 1500));
    expect(gateUp()).toBe(false);
    utils.unmount();
  });

  it("wave 38: lifts the gate without waiting for the LOD arm", async () => {
    // Park the LOD arm forever: under waves 33–36 (inline) the overlay
    // would never lift. The LOD arm runs in the background phase, so the
    // gate lifts on the settle check alone — the reveal never waits on
    // the re-tessellation.
    vi.mocked(h.fragmentsMock.core.load).mockResolvedValue({
      object: {},
      setLodMode: () => new Promise(() => undefined),
    } as never);
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    utils.unmount();
  });

  it("runs no warm pump: no per-frame apply loop, one unforced update", async () => {
    // The ALL_VISIBLE warm-up needed an apply-only rAF pump
    // (core.models.update per frame, up to 90 s). ALL_GEOMETRY is
    // view-bounded; the engine's own update loop applies its tiles, so
    // the viewer must not pump.
    const modelsUpdate = vi.fn();
    (h.fragmentsMock.core.models as { update?: () => void }).update =
      modelsUpdate;
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(modelsUpdate).not.toHaveBeenCalled();
    const unforced = h.fragmentsMock.core.update.mock.calls.filter(
      (c) => c.length === 0,
    ).length;
    expect(unforced).toBeLessThanOrEqual(1);
    delete (h.fragmentsMock.core.models as { update?: () => void }).update;
    utils.unmount();
  });

  it("a version swap does NOT re-arm the gate", async () => {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    // Swap to V2 with the re-load parked: the user is already looking
    // at this building, so the overlay must stay down (initial-stream
    // only).
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V2 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() =>
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(gateUp()).toBe(false);
    utils.unmount();
  });

  it("a fully failed pass lifts the gate (loader never pinned)", async () => {
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[
          { file: F1, latestVersion: V1 },
          { file: F2, latestVersion: V1B },
        ] as never}
        getFragBlob={(async () => null) as never}
      />,
    );
    // The pass arms the gate on start, then every blob is missing: no
    // model registers, so the post-loop else-branch must lift the gate
    // instead of leaving the overlay up forever.
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    expect(h.fragmentsMock.core.load).not.toHaveBeenCalled();
    utils.unmount();
  });

  it("wave 63: a Dexie re-emission mid-gate does not lift the overlay early", async () => {
    // The model is registered but still streaming (busy) when the live
    // query re-emits the same rows. The new pass loads nothing fresh;
    // it must inherit the armed gate instead of dropping it.
    h.fragmentsMock.core.models.list.set("f1", { isBusy: true } as never);
    const ref = createRef<IfcViewerHandle>();
    const files = () => [{ file: F1, latestVersion: V1 }] as never;
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files()}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(ref.current?.loadedModelIds.has("f1")).toBe(true), {
      timeout: 4000,
    });
    expect(gateUp()).toBe(true);
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={files()}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(gateUp()).toBe(true);
    // The stream settles → the re-armed pass lifts the gate.
    h.fragmentsMock.core.models.list.set("f1", { isBusy: false } as never);
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    utils.unmount();
  });

  it("wave 63: later loads in a session show the streaming chip", async () => {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    // A second file arrives; its load parks. The once-per-session
    // overlay stays hidden, so the chip must show instead.
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    utils.rerender(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={[
          { file: F1, latestVersion: V1 },
          { file: F2, latestVersion: V1B },
        ] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="viewer-streaming-chip"]'),
      ).not.toBeNull(),
    );
    expect(overlayEl()).toBeNull();
    utils.unmount();
  });

  it("wave 63: the load error banner is dismissable and resets on the next pass", async () => {
    vi.mocked(h.fragmentsMock.core.load).mockRejectedValue(new Error("bad frag"));
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    const banner = () =>
      document.querySelector<HTMLElement>('[data-testid="viewer-load-error"]');
    await waitFor(() => expect(banner()?.textContent).toContain("bad frag"));
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-testid="viewer-load-error-dismiss"]',
      )!,
    );
    await waitFor(() => expect(banner()).toBeNull());

    // Fails again, then a building switch: the banner must reset.
    utils.rerender(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[
          { file: F1, latestVersion: V1 },
          { file: F2, latestVersion: V1B },
        ] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(banner()).not.toBeNull());
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    utils.rerender(
      <IfcViewer
        projectId="p"
        activeBuildingId="b2"
        files={[{ file: { ...F1, id: "g1", buildingId: "b2" }, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(banner()).toBeNull());
    utils.unmount();
  });
});

// ─── Wave 60: parallel load pipeline ─────────────────────────────
describe("<IfcViewer> wave 60 parallel load pipeline", () => {
  const F1 = { id: "f1", name: "a.ifc", buildingId: "b" };
  const F2 = { id: "f2", name: "b.ifc", buildingId: "b" };
  const V1 = { id: "v1", fragBlobKey: "f1__v1", versionNumber: 1 };
  const V2 = { id: "v2", fragBlobKey: "f2__v1", versionNumber: 1 };
  const FILES = [
    { file: F1, latestVersion: V1 },
    { file: F2, latestVersion: V2 },
  ];
  const fakeBlob = {
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    size: 3,
    type: "application/octet-stream",
  } as unknown as Blob;
  const coreAny = () =>
    h.fragmentsMock.core as unknown as { baseCoordinates?: unknown };
  const gateUp = () =>
    /Loading model/.test(
      document.querySelector('[data-testid="viewer-loading-overlay"]')
        ?.textContent ?? "",
    );

  beforeEach(() => {
    __resetViewerSessionLoadedFlag();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.fragmentsMock.core.models.list.clear();
    delete coreAny().baseCoordinates;
    vi.mocked(h.fragmentsMock.core.load).mockClear();
    vi.mocked(h.fragmentsMock.core.load).mockResolvedValue({
      object: {},
      setLodMode: vi.fn(async () => undefined),
    } as never);
    vi.mocked(h.fragmentsMock.core.update).mockClear();
    vi.mocked(h.fragmentsMock.core.update).mockResolvedValue(undefined);
  });

  afterEach(() => {
    h.fragmentsMock.core.models.list.clear();
    delete coreAny().baseCoordinates;
    vi.restoreAllMocks();
  });

  it("dispatches every load without waiting for the previous one to finish", async () => {
    // Park every parse: the sequential loop would never reach file 2.
    vi.mocked(h.fragmentsMock.core.load).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={FILES as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() =>
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2),
    );
    utils.unmount();
  });

  it("wave 63: one renderer resize per load pass, no window resize events", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const proto = h.SimpleRendererClass.prototype as unknown as { resize?: () => void };
    const resize = vi.fn();
    proto.resize = resize;
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer
        ref={ref}
        projectId="p"
        activeBuildingId="b"
        files={FILES as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(ref.current?.loadedModelIds.size).toBe(2));
    expect(resize).toHaveBeenCalledTimes(1);
    expect(
      dispatchSpy.mock.calls.filter(([e]) => (e as Event).type === "resize"),
    ).toEqual([]);
    delete proto.resize;
    utils.unmount();
  });

  it("keeps file order for core.load dispatch even when blob reads finish out of order", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const reads: string[] = [];
    const getFragBlob = vi.fn(async (key: string) => {
      reads.push(key);
      if (key === "f1__v1") await firstRead;
      return fakeBlob;
    });
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={FILES as never}
        getFragBlob={getFragBlob as never}
      />,
    );
    await waitFor(() => expect(reads).toContain("f2__v1"));
    await new Promise((r) => setTimeout(r, 50));
    // f2's bytes are ready, but f1 has not been dispatched yet.
    expect(h.fragmentsMock.core.load).not.toHaveBeenCalled();
    releaseFirst();
    await waitFor(() =>
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2),
    );
    const ids = vi
      .mocked(h.fragmentsMock.core.load)
      .mock.calls.map((c) => (c[1] as { modelId: string }).modelId);
    expect(ids).toEqual(["f1", "f2"]);
    // Each blob is read exactly once (prefetch + load pass share it).
    expect(reads.filter((k) => k === "f1__v1")).toHaveLength(1);
    expect(reads.filter((k) => k === "f2__v1")).toHaveLength(1);
    utils.unmount();
  });

  it("never awaits the forced initial update (a parked flush does not pin the overlay)", async () => {
    vi.mocked(h.fragmentsMock.core.update).mockImplementation(
      () => new Promise(() => undefined) as never,
    );
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={FILES as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() =>
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 8000,
      interval: 100,
    });
    utils.unmount();
  });

  it("aligns every model to the FIRST file's coordinates, whichever parse finishes first", async () => {
    const pos1 = { x: 0, y: 0, z: 0 };
    const pos2 = { x: 0, y: 0, z: 0 };
    let resolveFirst!: (m: unknown) => void;
    vi.mocked(h.fragmentsMock.core.load)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        }) as never,
      )
      .mockResolvedValueOnce({
        object: { position: pos2 },
        setLodMode: vi.fn(async () => undefined),
        getCoordinates: async () => [10, 20, 30],
      } as never);
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={FILES as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() =>
      expect(h.fragmentsMock.core.load).toHaveBeenCalledTimes(2),
    );
    await new Promise((r) => setTimeout(r, 50));
    // f2 parsed first but must not become the base.
    expect(coreAny().baseCoordinates ?? null).toBeNull();
    resolveFirst({
      object: { position: pos1 },
      setLodMode: vi.fn(async () => undefined),
      getCoordinates: async () => [1, 2, 3],
    });
    await waitFor(() => expect(pos2).toEqual({ x: -9, y: -18, z: -27 }));
    expect(pos1).toEqual({ x: 0, y: 0, z: 0 });
    expect(coreAny().baseCoordinates).toEqual([1, 2, 3]);
    utils.unmount();
  });

  it("lifts the overlay as soon as every model draws, while the worker still streams", async () => {
    // Registered + drawing (1 tile) but busy forever: the quiet check
    // alone would hold the overlay for the full 12 s cap.
    h.fragmentsMock.core.models.list.set("f1", {
      isBusy: true,
      tiles: { size: 1 },
    } as never);
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => fakeBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    const t0 = Date.now();
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 4000,
      interval: 50,
    });
    expect(Date.now() - t0).toBeLessThan(4000);
    utils.unmount();
  });

  it("holds the overlay while a BIG model (>= 48 MiB frag) is still streaming", async () => {
    // A big model still streaming its view makes click raycasts
    // unreliable, so drawing alone must not lift the gate.
    const big = new ArrayBuffer(48 * 1024 * 1024);
    const bigBlob = {
      arrayBuffer: async () => big,
      size: big.byteLength,
      type: "application/octet-stream",
    } as unknown as Blob;
    const entry = { isBusy: true, tiles: { size: 3 } };
    h.fragmentsMock.core.models.list.set("f1", entry as never);
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => bigBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(true), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(gateUp()).toBe(true);
    entry.isBusy = false; // finished streaming
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 4000,
      interval: 50,
    });
    utils.unmount();
  });

  it("wave 61: caps the big-model wait at ~5 s, then shows the non-blocking chip until the view is drawn", async () => {
    const big = new ArrayBuffer(48 * 1024 * 1024);
    const bigBlob = {
      arrayBuffer: async () => big,
      size: big.byteLength,
      type: "application/octet-stream",
    } as unknown as Blob;
    const entry = { isBusy: true, tiles: { size: 3 } };
    h.fragmentsMock.core.models.list.set("f1", entry as never);
    const chipUp = () =>
      !!document.querySelector('[data-testid="viewer-streaming-chip"]');
    const utils = render(
      <IfcViewer
        projectId="p"
        activeBuildingId="b"
        files={[{ file: F1, latestVersion: V1 }] as never}
        getFragBlob={(async () => bigBlob) as never}
      />,
    );
    await waitFor(() => expect(h.fragmentsMock.core.load).toHaveBeenCalled());
    await waitFor(() => expect(gateUp()).toBe(true), { timeout: 4000 });
    const t0 = Date.now();
    // Still streaming, but the wait is capped: the overlay lifts.
    await waitFor(() => expect(gateUp()).toBe(false), {
      timeout: 9000,
      interval: 100,
    });
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThan(3000);
    expect(waited).toBeLessThan(8000);
    // ...and the chip says the view is still filling in.
    expect(chipUp()).toBe(true);
    entry.isBusy = false; // view fully drawn
    await waitFor(() => expect(chipUp()).toBe(false), {
      timeout: 3000,
      interval: 50,
    });
    utils.unmount();
  }, 20_000);
});

// ─── renderPaused: covered secondary viewers stop drawing ──────
describe("<IfcViewer> renderPaused", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.rendererInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the OBC renderer while paused and re-enables it on resume", async () => {
    const ref = createRef<IfcViewerHandle>();
    const { rerender, unmount } = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" renderPaused />,
    );
    await waitFor(() => {
      expect(h.rendererInstances.length).toBeGreaterThan(0);
    });
    const renderer = h.rendererInstances[
      h.rendererInstances.length - 1
    ] as unknown as { enabled?: boolean };
    // Applied at world creation (the mount is async).
    expect(renderer.enabled).toBe(false);

    rerender(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" renderPaused={false} />,
    );
    expect(renderer.enabled).toBe(true);

    rerender(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" renderPaused />,
    );
    expect(renderer.enabled).toBe(false);

    unmount();
  });
});

// ─── Render on demand: the renderer only draws when the view changed ──
describe("<IfcViewer> render on demand", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    h.rendererInstances.length = 0;
    for (const k of Object.keys(h.cameraControlListeners)) {
      delete h.cameraControlListeners[k];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type MockRenderer = { mode?: number; needsUpdate?: boolean; enabled?: boolean };

  async function mountViewer(props: Record<string, unknown> = {}) {
    const ref = createRef<IfcViewerHandle>();
    const utils = render(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" {...props} />,
    );
    await waitFor(() => {
      expect(createLevelPlanController).toHaveBeenCalled();
    });
    const renderer = h.rendererInstances[
      h.rendererInstances.length - 1
    ] as unknown as MockRenderer;
    return { ref, renderer, ...utils };
  }

  it("puts the OBC renderer in MANUAL mode (RendererMode.MANUAL = 0)", async () => {
    const { renderer, unmount } = await mountViewer();
    expect(renderer.mode).toBe(0);
    unmount();
  });

  it("renderOnDemand={false} keeps per-frame rendering (AUTO = 1)", async () => {
    const { renderer, unmount } = await mountViewer({ renderOnDemand: false });
    expect(renderer.mode).toBe(1);
    unmount();
  });

  it("restores AUTO mode on unmount", async () => {
    const { renderer, unmount } = await mountViewer();
    unmount();
    expect(renderer.mode).toBe(1);
  });

  it("camera 'update' requests a frame synchronously", async () => {
    const { renderer, unmount } = await mountViewer();
    renderer.needsUpdate = false;
    for (const cb of h.cameraControlListeners.update ?? []) cb();
    expect(renderer.needsUpdate).toBe(true);
    unmount();
  });

  it("mutating handle methods request a frame; read-only ones do not", async () => {
    const { ref, renderer, unmount } = await mountViewer();
    renderer.needsUpdate = false;
    ref.current!.getViewportRevision();
    ref.current!.getSelection();
    ref.current!.getSectionPlaneCount();
    ref.current!.isMeasureInProgress();
    expect(renderer.needsUpdate).toBe(false);
    ref.current!.addSectionPlane({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(renderer.needsUpdate).toBe(true);
    renderer.needsUpdate = false;
    ref.current!.setElementVisibility("m1", new Set([1, 2]), false);
    expect(renderer.needsUpdate).toBe(true);
    renderer.needsUpdate = false;
    ref.current!.requestRender?.("test");
    expect(renderer.needsUpdate).toBe(true);
    unmount();
  });

  it("exposes render stats through the handle", async () => {
    const { ref, unmount } = await mountViewer();
    const stats = ref.current!.getRenderStats?.();
    expect(stats?.mode).toBe("on-demand");
    expect(stats?.invalidations).toBeGreaterThan(0);
    unmount();
  });

  it("resuming a paused viewer requests a frame", async () => {
    const { ref, renderer, rerender, unmount } = await mountViewer({ renderPaused: true });
    renderer.needsUpdate = false;
    rerender(
      <IfcViewer ref={ref} projectId="p" activeBuildingId="b" renderPaused={false} />,
    );
    expect(renderer.enabled).toBe(true);
    expect(renderer.needsUpdate).toBe(true);
    unmount();
  });

  it("section fills: each async ClipEdges.updateMeshes settle requests a frame", async () => {
    let resolveFill!: () => void;
    const updateMeshes = vi.fn(
      () => new Promise<void>((r) => (resolveFill = r)),
    );
    const edges = { visible: true, updateMeshes };
    const { ref, renderer, unmount } = await mountViewer();
    // The ClipStyler instance is resolved lazily on the first plane.
    ref.current!.addSectionPlane({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 });
    const styler = h.clipStylerInstances[h.clipStylerInstances.length - 1] as unknown as {
      createFromClipping: ReturnType<typeof vi.fn>;
    };
    // Second plane uses the cached styler; make it hand back our edges.
    styler.createFromClipping.mockReturnValueOnce(edges);
    ref.current!.addSectionPlane({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 });
    // The engine calls updateMeshes on the (wrapped) instance later.
    renderer.needsUpdate = false;
    const p = (edges.updateMeshes as unknown as () => Promise<void>)();
    expect(updateMeshes).toHaveBeenCalledTimes(1);
    renderer.needsUpdate = false;
    resolveFill();
    await p;
    await Promise.resolve();
    expect(renderer.needsUpdate).toBe(true);
    unmount();
  });
});
