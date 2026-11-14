// src/viewer/level/LevelPlanController.ts
//
// Wraps OBC.TechnicalDrawings + OBC.EdgeProjector to produce
// a true 2D plan-drawing at a storey's elevation.
//
// LRU cache = at most 1 active drawing (Option A, per Maintainer 2026-06-05).
// Edge projection runs on the main thread — dispose the previous drawing
// on level switch.
//
// No raw three.js imports.  OBC type imports are allowed per the
// TOE drift-check configuration (the linter only flags runtime
// three.js usage via `import "three"` / `import * as THREE`).

import * as OBC from "@thatopen/components";
import { MeasurementLineSystem } from "./MeasurementLineSystem";

// ── Module-level OBC monkey-patch ──────────────────────────────────────────
//
// The OBC EdgeProjector defaults `useWebGPU = true` on its internal
// ProjectionGenerator. The WebGPU compute path (`getBvhcastEdgesWebgpu`)
// has no working WebGL2 fallback — Three.js WebGPURenderer falls back to
// WebGL2, but the compute-style GLSL shaders don't compile there
// (`atomicAdd(&nodeVarying4, 1u)` is WGSL, not GLSL).
//
// Setting the flag inside the controller's factory or `open()` method
// is unreliable: Vite HMR re-imports this module without re-running
// the controller's constructor, so a stale controller keeps the
// default `useWebGPU = true`.
//
// We wrap the EdgeProjector.prototype.get method at module load to
// force `useWebGPU = false` on the generator + the projector right
// before each call. This runs on every HMR cycle (module top-level
// re-executes) AND guarantees the flag is set right before the
// projection runs, regardless of which controller instance is alive.
//
// Idempotent: a __ffPatched flag on the prototype prevents double-wrapping.
if (typeof (OBC.EdgeProjector as unknown as { prototype: { __ffPatched?: boolean } }).prototype !== "undefined") {
  const proto = (OBC.EdgeProjector as unknown as {
    prototype: { __ffPatched?: boolean; get?: (...args: unknown[]) => unknown };
  }).prototype;
  if (proto.get && !proto.__ffPatched) {
    const originalGet = proto.get;
    proto.get = function patchedGet(this: unknown, ...args: unknown[]): unknown {
      // `this` is the EdgeProjector instance. Force the flag on it AND
      // on its generator before delegating to the original.
      const self = this as {
        useWebGPU?: boolean;
        generator?: { useWebGPU?: boolean };
      };
      self.useWebGPU = false;
      if (self.generator) {
        self.generator.useWebGPU = false;
      }
      // eslint-disable-next-line no-console
      console.log(
        "[LevelPlanController/ff-patch] EdgeProjector.get called — useWebGPU forced to false on instance and generator.",
      );
      return (originalGet as (...a: unknown[]) => unknown).apply(this, args);
    };
    proto.__ffPatched = true;
    // eslint-disable-next-line no-console
    console.log(
      "[LevelPlanController/ff-patch] EdgeProjector.prototype.get wrapped at module load to force useWebGPU=false.",
    );
  }
}

// ── Level-plan framing distance ───────────────────────────────

/**
 * The straight-down framing distance (metres) used when a level
 * plan opens or re-frames: the camera sits this far above the slab
 * top and looks straight down before the ortho `camera.fit` tightens
 * the frustum over the plan geometry.
 *
 * Shared single source of truth — `LevelPlanController.open()`,
 * `IfcViewer.fitLevelPlan()` (the plan toolbar's "fit plan"), and
 * the LinkView navigation view's straight-down camera all use this
 * exact value so the nav view frames a floor from the same height
 * as the level-plan view.
 */
export const LEVEL_PLAN_FRAME_DISTANCE = 50;

// ── Public handle ─────────────────────────────────────────────

export interface LevelPlanHandle {
  readonly activeStoreyName: string | null;
  open(storeyName: string): Promise<boolean>;
  close(): void;
  dispose(): void;
  /**
   * The active TechnicalDrawing (the level plan currently shown),
   * or `null` when no plan is open. Used by IfcViewer to wire
   * the measurement system — `drawing.raycast(ray)` returns the
   * line hit that the measurement system snaps to on click.
   */
  getDrawing(): OBC.TechnicalDrawing | null;
  /**
   * The measurement line system singleton (registered with
   * `techDrawings.use(...)` at factory time). Survives across
   * drawings — when the drawing is disposed, the base class
   * removes it from `_knownDrawings` and the committed
   * geometry is cleared with the drawing. We do NOT dispose
   * the system on level close; only the full viewer teardown
   * (via `components.dispose()`) should dispose it.
   */
  getMeasureSystem(): MeasurementLineSystem;
  /**
   * Metadata for the currently open storey, or `null` when no
   * plan is open. Reads from the storey map populated by the
   * pipeline's `_setStoreys(...)` call (IfcViewer calls this
   * after the first model loads for a building).
   *
   * Used by IfcViewer's restricted third-person camera (Task 21):
   * the camera locks at `elevation + 1.8m` (human eye height)
   * above the active storey. Returning `null` lets the caller
   * distinguish "no plan open" from "plan open at elevation 0",
   * which would both yield `elevation === 0` from a naive lookup.
   */
  getActiveStoreyMeta(): StoreyMeta | null;
}

// ── Layer / category config ───────────────────────────────────

// Per-discipline IFC category patterns + their visible/hidden layer pair.
// `OBC.TechnicalDrawing.addProjectionFromItems` only takes a single
// `{visible, hidden}` layer pair per call, so we run it four times —
// once per category — to get the discipline-layer colour separation
// the architectural plan needs.
const CATEGORY_LAYER_PAIRS: Array<{
  category: RegExp;
  visible: string;
  hidden: string;
  color: number;
}> = [
  {
    category: /^IFCWALL$|^IFCWALLSTANDARDCASE$/,
    visible: "Walls",
    hidden: "Walls.Hidden",
    color: 0x1a1a1a,
  },
  {
    category: /^IFCCOLUMN$/,
    visible: "Columns",
    hidden: "Columns.Hidden",
    color: 0x1a1a1a,
  },
  {
    category: /^IFCSLAB$|^IFCROOF$/,
    visible: "Slabs",
    hidden: "Slabs.Hidden",
    color: 0x808080,
  },
  {
    category: /^IFCDOOR$|^IFCWINDOW$|^IFCOPENINGELEMENT$/,
    visible: "Openings",
    hidden: "Openings.Hidden",
    color: 0x606060,
  },
];

// Light gray for the dashed hidden-line pairs.
const HIDDEN_LAYER_COLOR = 0xcccccc;

// 8 layers total: 4 discipline visible + 4 hidden siblings. The
// `dot` in the hidden layer name is the convention used by the
// TOE DrawingLayers setColor example (e.g. "walls.hidden").
const LAYER_NAMES = [
  "Walls",
  "Walls.Hidden",
  "Columns",
  "Columns.Hidden",
  "Slabs",
  "Slabs.Hidden",
  "Openings",
  "Openings.Hidden",
  // Task 18: dedicated layer for committed measurement lines.
  // The measurement system stamps `group.userData.layer` with
  // the drawing's `activeLayer` at persist time (see
  // `AnnotationSystem._persist`). We switch `activeLayer` to
  // "Measurements" before any measurement interactions and
  // restore the previous layer afterwards — see the tool
  // switching in IfcViewer.
  "Measurements",
] as const;

const LAYER_COLORS: Record<string, number> = {
  Walls: 0x1a1a1a,
  "Walls.Hidden": HIDDEN_LAYER_COLOR,
  Columns: 0x1a1a1a,
  "Columns.Hidden": HIDDEN_LAYER_COLOR,
  Slabs: 0x808080,
  "Slabs.Hidden": HIDDEN_LAYER_COLOR,
  Openings: 0x606060,
  "Openings.Hidden": HIDDEN_LAYER_COLOR,
  // Orange to match the MeasurementLineSystem default style.
  Measurements: 0xff6600,
};

export interface StoreyMeta {
  name: string;
  elevation: number;
  height: number | null;
}

// ── Collect IFC items by category ─────────────────────────────

/**
 * Build a ModelIdMap containing only the items that match `category`
 * across every loaded model. Returns an empty map (no modelIds) when
 * nothing matches — callers skip empty maps so they don't trigger
 * an empty `addProjectionFromItems` call.
 *
 * CRITICAL: call the method via `model.getItemsOfCategories(...)`
 * (not a bare extracted reference) so the `this` binding is preserved.
 * If you extract the method reference and call it bare, `this` is
 * undefined inside the call and the implementation throws
 * "Cannot read properties of undefined (reading '_dataManager')".
 */
/** Exported for testing. Internal callers use the bare function. */
export async function filterItemsByCategory(
  fragments: OBC.FragmentsManager,
  category: RegExp,
): Promise<OBC.ModelIdMap> {
  const map: OBC.ModelIdMap = {};
  for (const model of fragments.core.models.list.values()) {
    // FragmentsModel exposes the model id as `modelId` (a string getter),
    // not `uuid`. We need this exact key — the EdgeProjector / BoundingBoxer
    // look up items by the same id that was passed to the loader
    // (see IfcViewer.tsx where fragments.core.load is called with raw:true).
    const modelId = (model as unknown as { modelId: string }).modelId;
    if (!modelId) continue;
    const getItems = (cats: RegExp[]) =>
      (model as unknown as {
        getItemsOfCategories: (
          cats: RegExp[],
        ) => Promise<{ [category: string]: number[] }>;
      }).getItemsOfCategories(cats);
    try {
      const catMap = await getItems([category]);
      if (!catMap) continue;
      const ids = new Set<number>();
      for (const arr of Object.values(catMap)) {
        for (const id of arr) ids.add(id);
      }
      if (ids.size > 0) map[modelId] = ids;
    } catch {
      // model may not have items categorized yet — skip
    }
  }
  return map;
}

// ── Camera helpers ────────────────────────────────────────────

function cameraSetLookAt(
  world: OBC.World,
  ex: number,
  ey: number,
  ez: number,
  tx: number,
  ty: number,
  tz: number,
): void {
  const ctrl = world.camera.controls as unknown as {
    setLookAt?: (
      ex2: number,
      ey2: number,
      ez2: number,
      tx2: number,
      ty2: number,
      tz2: number,
      transition?: boolean,
    ) => void;
  };
  ctrl?.setLookAt?.(ex, ey, ez, tx, ty, tz, false);
}

/** A 3D camera pose saved when a level plan opens (wave 63). */
interface SavedCameraPose {
  pos: [number, number, number];
  target: [number, number, number];
  projection: OBC.CameraProjection | null;
}

/**
 * Read the live camera pose: eye from the Three camera, target from
 * camera-controls' `getTarget(out)`. The `out` vector is a clone of the
 * camera position (no raw three import). Null when unreadable.
 */
function captureCameraPose(world: OBC.World): SavedCameraPose | null {
  const cam = world.camera as unknown as {
    three?: { position?: { x: number; y: number; z: number; clone?: () => unknown } };
    controls?: { getTarget?: (out: unknown, receiveEndValue?: boolean) => { x: number; y: number; z: number } };
    projection?: { current?: OBC.CameraProjection };
  };
  const p = cam.three?.position;
  const getTarget = cam.controls?.getTarget;
  if (!p || typeof p.clone !== "function" || typeof getTarget !== "function") {
    return null;
  }
  try {
    const t = getTarget.call(cam.controls, p.clone(), true);
    if (!t) return null;
    return {
      pos: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      projection: cam.projection?.current ?? null,
    };
  } catch {
    return null;
  }
}

// ── Factory ───────────────────────────────────────────────────

export function createLevelPlanController(
  world: OBC.World,
  fragments: OBC.FragmentsManager,
  components: OBC.Components,
): LevelPlanHandle {
  // Components is passed in by the caller (IfcViewer) — the world
  // is *owned by* the components instance, not the reverse, so we
  // can't extract it from `world._components` (that field doesn't
  // exist on OBC.World in v3.4.x).

  const techDrawings = components.get(OBC.TechnicalDrawings);
  // Task 18: register the custom measurement system at factory
  // time. `techDrawings.use(SystemClass)` is the OBC-recommended
  // pattern for adding annotation systems — it manages the
  // singleton (one instance per SystemClass) and wires the
  // system's _components reference. The system survives across
  // drawings, so we don't need to re-register on `open()`.
  const measureLines = techDrawings.use(MeasurementLineSystem);
  const edgeProjector = components.get(OBC.EdgeProjector);
  edgeProjector.enabled = true;
  // The BoundingBoxer is a singleton managed by `components`. Get it
  // ONCE here at factory time and reuse across every `open()` call.
  // Calling `new OBC.BoundingBoxer(components)` from inside `open()`
  // throws on the second invocation with
  // "You're trying to add a component that already exists in the
  // components instance. Use Components.get() instead."
  // — because the BoundingBoxer constructor calls
  // `components.add(this)` internally, and the second call tries to
  // re-register the same component. The reset between `open()` calls
  // is `boxer.list.clear()` (the BoundingBoxer holds its boxes in a
  // `FRAGS.DataSet<THREE.Box3>` — see `node_modules/@thatopen/
  // components/dist/index.mjs:11691`).
  const boxer = components.get(OBC.BoundingBoxer);
  // FORCE the CPU edge-projection path. The default `useWebGPU = true`
  // on the ProjectionGenerator runs a WebGPU compute pipeline that has
  // no working WebGL2 fallback (the Three.js WebGPURenderer "fallback"
  // tries to use transform feedback + compute-style GLSL shaders that
  // don't compile under WebGL2 — see the cascading `atomicAdd(&...)`
  // syntax errors and INVALID_VALUE/INVALID_OPERATION storm).
  //
  // `navigator.gpu` is a useless detection signal: Chrome ships a
  // truthy stub since v94 even when no actual adapter is available
  // (the user sees "No available adapters." when the WebGPU code
  // actually tries to use it). A proper async
  // `await navigator.gpu.requestAdapter()` check is possible at app
  // startup but adds complexity for a single feature. For now, just
  // always force the CPU path. Revisit when WebGPU ships stable
  // (~2026/2027) and the BVH compute fallback is fixed upstream.
  (edgeProjector as any).useWebGPU = false;
  if (edgeProjector.generator) {
    edgeProjector.generator.useWebGPU = false;
  }
  // eslint-disable-next-line no-console
  console.log(
    "[LevelPlanController] Forcing CPU edge projection (useWebGPU=false on generator and EdgeProjector). WebGPU compute path is incompatible with WebGL2 fallback.",
  );

  let activeStoreyName: string | null = null;
  let currentDrawing: OBC.TechnicalDrawing | null = null;
  const storeyMap = new Map<string, StoreyMeta>();
  // Wave 63: the 3D pose the user had before the FIRST plan opened.
  // `close()` returns there (it used to jump to a fixed (10,10,10)).
  // Switching storey keeps the original pose — it is only replaced
  // when a plan opens from the 3D view.
  let savedPose: SavedCameraPose | null = null;

  /** Dispose the drawing + reset the measure machine; camera untouched. */
  const closeDrawing = (): void => {
    // Wave 67: drop the distance labels / dots (CSS2D marks) with the
    // drawing they belong to.
    measureLines.disposeLabels();
    if (currentDrawing) {
      currentDrawing.dispose();
      currentDrawing = null;
    }
    // Task 18: reset the measurement state machine on close.
    // The system singleton survives (the spec wants it to — its
    // committed geometry is per-drawing, so disposing the
    // drawing already cleared the active measurements). What
    // we DO need to reset is the click → click state machine:
    // if the user closed the level plan mid-flow (state 2 with
    // a half-placed line), the next level open should start
    // fresh in state 1, not continue from the orphan state.
    measureLines.sendMachineEvent({ type: "ESCAPE" });
    activeStoreyName = null;
  };

  /**
   * Return the camera to the saved 3D pose (or the app's initial
   * (10,10,10) pose when none was captured), perspective + orbit.
   */
  const restoreCamera = (): void => {
    const pose = savedPose;
    savedPose = null;
    const apply = (): void => {
      if (pose) {
        cameraSetLookAt(world, ...pose.pos, ...pose.target);
      } else {
        cameraSetLookAt(world, 10, 10, 10, 0, 0, 0);
      }
    };
    apply();
    const cam = world.camera as unknown as {
      projection?: { set: (p: OBC.CameraProjection) => Promise<void> };
      set?: (mode: string) => void;
    };
    if (cam.projection && cam.set) {
      const projection = pose?.projection ?? "Perspective";
      // The projection switch moves the camera to match the old
      // frustum, so re-apply the pose once it has resolved.
      void Promise.resolve(cam.projection.set(projection)).then(apply, () => undefined);
      cam.set("Orbit");
    }
  };

  const handle: LevelPlanHandle = {
    get activeStoreyName(): string | null {
      return activeStoreyName;
    },

    getDrawing(): OBC.TechnicalDrawing | null {
      return currentDrawing;
    },

    getMeasureSystem(): MeasurementLineSystem {
      return measureLines;
    },

    getActiveStoreyMeta(): StoreyMeta | null {
      // Reads from the in-closure storey map populated by the
      // pipeline via `_setStoreys(...)`. We index by the live
      // `activeStoreyName` so the caller always sees the same
      // storey the controller's drawing is framed on — important
      // for the restricted third-person camera (Task 21), which
      // reads `elevation` to lock the camera 1.8m above the
      // active storey.
      //
      // Returns `null` when no plan is open (caller can
      // distinguish "no plan" from "elevation 0", which a naive
      // lookup would conflate). Safe to call any time after the
      // factory finishes — `storeyMap` is always populated by the
      // pipeline before the user can open a level plan.
      if (activeStoreyName === null) return null;
      return storeyMap.get(activeStoreyName) ?? null;
    },

    async open(storeyName: string): Promise<boolean> {
      const meta = storeyMap.get(storeyName);
      if (!meta) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LevelPlanController] open("${storeyName}"): not in metadata`,
        );
        return false;
      }
      if (activeStoreyName === storeyName && currentDrawing) return true;

      // Wave 63: remember the 3D pose when opening FROM the 3D view.
      if (!currentDrawing) savedPose = captureCameraPose(world);

      // Dispose previous drawing (LRU = 1). Camera stays — the new
      // plan re-frames it, and close() still returns to the 3D pose.
      if (currentDrawing) closeDrawing();

      // Re-assert useWebGPU=false on every open() call. The flag is
      // set at construction time, but Vite HMR can re-import the
      // module without re-running the constructor — a stale controller
      // would otherwise keep the default `useWebGPU = true` and
      // re-trigger the WebGPU compute path on every click. Setting it
      // right before the projection call guarantees the flag is correct
      // regardless of HMR state.
      (edgeProjector as any).useWebGPU = false;
      if (edgeProjector.generator) {
        edgeProjector.generator.useWebGPU = false;
      }

      try {
        // 1. Switch the world camera to ortho + Plan nav BEFORE we
        // create the drawing. TechnicalDrawings.create() configures
        // the camera based on its current projection; doing this
        // first avoids creating a perspective-framed viewport and
        // then having to retag it. Only available on
        // OrthoPerspectiveCamera — guard with a feature check.
        const cam = world.camera as unknown as {
          projection?: { current: OBC.CameraProjection; set: (p: OBC.CameraProjection) => Promise<void> };
          mode?: { id: OBC.NavModeID };
          set?: (mode: string) => void;
        };
        if (cam.projection && cam.mode && cam.set) {
          await cam.projection.set("Orthographic");
          cam.set("Plan");
        }

        // 2. Compute the storey height with a fallback. meta.height
        // is `number | null` — null is rare but legal (a storey with
        // no height data). We compute from the next storey in the
        // sorted list; for the topmost storey we fall back to 5m.
        let storeyHeight: number;
        if (meta.height !== null && meta.height > 0) {
          storeyHeight = meta.height;
        } else {
          const sorted = Array.from(storeyMap.values()).sort(
            (a, b) => a.elevation - b.elevation,
          );
          const idx = sorted.findIndex((s) => s.name === meta.name);
          if (idx >= 0 && idx < sorted.length - 1) {
            storeyHeight = sorted[idx + 1].elevation - meta.elevation;
          } else {
            storeyHeight = 5;
            // eslint-disable-next-line no-console
            console.warn(
              `[LevelPlanController] storey "${meta.name}" has null height; using 5m fallback`,
            );
          }
        }
        const slabTop = meta.elevation + storeyHeight;

        // 3. Build the per-category item maps. We need at least one
        // non-empty category to proceed — bail out otherwise.
        const perCategoryItems: Record<string, OBC.ModelIdMap> = {};
        let totalModelsWithItems = 0;
        for (const pair of CATEGORY_LAYER_PAIRS) {
          const map = await filterItemsByCategory(fragments, pair.category);
          perCategoryItems[pair.visible] = map;
          totalModelsWithItems += Object.keys(map).length;
        }
        if (totalModelsWithItems === 0) {
          // eslint-disable-next-line no-console
          console.warn("[LevelPlanController] no IFC items for projection");
          // Wave 63: the camera already switched to ortho/Plan above.
          restoreCamera();
          return false;
        }

        // 4. Compute the bounding box from the union of all per-category
        // maps so the framing covers everything we're about to project.
        // We use the factory-scope singleton boxer (`components.get`
        // returns the registered instance) and clear its `list` DataSet
        // before re-populating — the BoundingBoxer constructor calls
        // `components.add(this)`, so re-instantiating it from `open()`
        // throws "component already exists" on the second call. Clearing
        // `list` is the canonical reset pattern (same as the BoundingBoxer's
        // own `getCenter` method does internally at line 11767 of
        // `node_modules/@thatopen/components/dist/index.mjs`).
        boxer.list.clear();
        for (const pair of CATEGORY_LAYER_PAIRS) {
          const map = perCategoryItems[pair.visible];
          if (Object.keys(map).length === 0) continue;
          await boxer.addFromModelIdMap(map);
        }
        const bbox = boxer.get();
        const cx =
          bbox.min.x === Infinity ? 0 : (bbox.min.x + bbox.max.x) / 2;
        const cz =
          bbox.min.z === Infinity ? 0 : (bbox.min.z + bbox.max.z) / 2;

        // 5. Create the drawing
        const drawing = techDrawings.create(world);

        // 6. Position the drawing at the TOP of the storey slab and
        // orient top-down. The drawing's projection volume is
        // [position.y, position.y - far] (per OBC: drawing.far is
        // the distance below the drawing's position). Setting
        // `far = storeyHeight` projects exactly one storey's worth
        // of geometry downward.
        drawing.three.position.set(cx, slabTop, cz);

        // Access THREE.Vector3 via the world camera's position constructor —
        // same drift-safe pattern used in IfcViewer.tsx worldToScreen.
        const V3 = world.camera.three?.position?.constructor;
        if (V3) {
          const dir = new (V3 as new (
            x: number,
            y: number,
            z: number,
          ) => object)(0, -1, 0);
          drawing.orientTo(
            dir as unknown as Parameters<
              OBC.TechnicalDrawing["orientTo"]
            >[0],
          );
        }

        drawing.far = storeyHeight;

        // 7. Create all 8 layers (4 visible + 4 hidden siblings) and
        // set their colours. MUST happen before addProjectionFromItems.
        for (const layerName of LAYER_NAMES) {
          drawing.layers.create(layerName, { visible: true });
          const color = LAYER_COLORS[layerName];
          if (color !== undefined) {
            drawing.layers.setColor(layerName, color);
          }
        }

        // 8. Per-category projection — 4 calls, each with its own
        // (visible, hidden) layer pair. Skip categories with zero
        // matching items.
        for (const pair of CATEGORY_LAYER_PAIRS) {
          const map = perCategoryItems[pair.visible];
          if (Object.keys(map).length === 0) continue;
          await drawing.addProjectionFromItems(map, {
            layers: { visible: pair.visible, hidden: pair.hidden },
          });
        }

        drawing.three.visible = true;

        // 9. Frame the camera. The ortho projection was set at the
        // top of open(); the Three camera is now OrthoPerspectiveCamera.threeOrtho.
        // Try the high-level fit() first (uses controls.fitToSphere);
        // fall back to manual left/right/top/bottom from the XZ bbox.
        cameraSetLookAt(
          world,
          cx,
          slabTop + LEVEL_PLAN_FRAME_DISTANCE,
          cz,
          cx,
          slabTop,
          cz,
        );

        if (cam.projection) {
          const fitCam = world.camera as unknown as {
            fit?: (meshes: Iterable<unknown>, offset?: number) => Promise<void>;
          };
          if (fitCam.fit) {
            // Collect all scene meshes — fit() works on the ortho
            // camera's frustum.
            const meshes: unknown[] = [];
            world.scene.three.traverse((obj: unknown) => {
              if (
                obj &&
                typeof obj === "object" &&
                (obj as { isMesh?: boolean }).isMesh
              ) {
                meshes.push(obj);
              }
            });
            if (meshes.length > 0) {
              try {
                await fitCam.fit(meshes as never, 1.2);
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(
                  "[LevelPlanController] camera.fit failed, leaving manual lookAt:",
                  err,
                );
              }
            }
          }
        }

        currentDrawing = drawing;
        activeStoreyName = storeyName;
        return true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[LevelPlanController] open("${storeyName}") failed:`,
          err,
        );
        // Wave 63: don't leave the camera stuck in ortho/Plan.
        if (!currentDrawing) restoreCamera();
        return false;
      }
    },

    close(): void {
      // Wave 63: return to the 3D pose saved when the plan opened
      // (perspective/orbit). Falls back to the app's initial pose
      // (10,10,10 → origin) when no pose was captured.
      restoreCamera();
      closeDrawing();
    },

    dispose(): void {
      handle.close();
      storeyMap.clear();
    },
  };

  // Internal setter for storey metadata
  (handle as LevelPlanHandle & { _setStoreys: (s: StoreyMeta[]) => void })._setStoreys =
    (storeys: StoreyMeta[]) => {
      storeyMap.clear();
      for (const s of storeys) storeyMap.set(s.name, s);
    };

  return handle;
}
