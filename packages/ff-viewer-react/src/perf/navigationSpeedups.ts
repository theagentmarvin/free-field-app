// packages/ff-viewer-react/src/perf/navigationSpeedups.ts
//
// Glue between the NavigationModeController (is the camera moving?) and
// the three motion-time speedups the viewer applies while it is:
//
//   1. Frozen tile refresh — every loaded fragments model gets
//      `model.frozen = true` (public FragmentsModel API: "whether the model
//      should stop updating"). The engine keeps its ~10 Hz auto-update
//      loop, but a frozen model sends no REFRESH_VIEW, so the worker does
//      not re-cull / re-tile for every intermediate camera pose of a
//      gesture. Built tiles still apply, and forced updates (highlight,
//      visibility, load) still complete — unlike throttling through
//      `settings.maxUpdateRate`, which would park a forced update(true)
//      behind the throttle delay. At settle the models are unfrozen (the
//      setter re-sends the view) and the caller's refresh runs once.
//      Only models WE froze are unfrozen: the loader freezes a model while
//      it is being set up, and that one is left alone.
//   2. Motion draw budget — see motionBudget.ts. Bracketed around the
//      MAIN render only (SimpleRenderer onBeforeUpdate/onAfterUpdate), so
//      picking passes and snapshots always see every tile.
//   3. Reduced pixel ratio — `restRatio * movingPixelRatioScale` while
//      moving, the rest ratio back at settle.
//
// Engine objects are typed structurally so this module stays testable
// with plain fakes.

// eslint-disable-next-line no-restricted-imports
import type * as THREE from "three";
import { MotionBudget, type MotionBudgetOptions } from "./motionBudget";
import {
  NavigationModeController,
  type CameraEventTarget,
  type NavigationStopReason,
} from "./navigationMode";

export type { CameraEventTarget };

export interface EngineEvent<T> {
  add(handler: (data: T) => void): void;
  remove?(handler: (data: T) => void): void;
}

export interface SpeedupRenderer {
  onBeforeUpdate?: EngineEvent<unknown>;
  onAfterUpdate?: EngineEvent<unknown>;
  three?: {
    getPixelRatio?: () => number;
    setPixelRatio?: (r: number) => void;
    clippingPlanes?: THREE.Plane[];
  };
}

export interface SpeedupModel {
  object: THREE.Object3D;
  frozen?: boolean;
}

export interface NavigationSpeedupsDeps {
  controls: CameraEventTarget;
  renderer: SpeedupRenderer;
  /** The camera the main render uses (OrthoPerspectiveCamera.three). */
  getCamera: () => THREE.Camera | null | undefined;
  /** Currently loaded fragments models. */
  getModels: () => Iterable<SpeedupModel>;
  /** Unforced fragments view refresh, run once per settle. */
  refresh: () => void;
  /** Pixel-ratio factor while moving (default 0.5; 1 disables). */
  movingPixelRatioScale?: number;
  /** Motion draw budget options, or false to disable it. */
  budget?: MotionBudgetOptions | false;
  /** Freeze the tile refresh while moving (default true). */
  freezeView?: boolean;
  idleMs?: number;
  settleDelayMs?: number;
  now?: () => number;
  onStart?: () => void;
  onStop?: (reason: NavigationStopReason, stats: MotionStats) => void;
}

/** Per-gesture counters, handed to `onStop` (telemetry). */
export interface MotionStats {
  /** Main renders drawn in motion mode. */
  frames: number;
  /** Mean tiles hidden by the budget per motion frame. */
  meanHidden: number;
  /** Mean render CPU ms (budget pass + three render) per motion frame. */
  meanRenderMs: number;
  /** Tile budget at the end of the gesture. */
  budget: number | null;
  durationMs: number;
}

export interface NavigationSpeedups {
  readonly controller: NavigationModeController;
  readonly budget: MotionBudget | null;
  /** Leave motion mode now (full-quality frame on the next render). */
  forceRest(): void;
  dispose(): void;
}

export function installNavigationSpeedups(
  deps: NavigationSpeedupsDeps,
): NavigationSpeedups {
  const now = deps.now ?? (() => performance.now());
  const scale = deps.movingPixelRatioScale ?? 0.5;
  const freezeView = deps.freezeView !== false;
  const budget = deps.budget === false ? null : new MotionBudget(deps.budget ?? {});
  const frozenByUs = new Set<SpeedupModel>();
  let restRatio: number | null = null;
  let applied = false;
  let frameStart = 0;
  let stats = { frames: 0, hidden: 0, renderMs: 0, t0: 0 };

  const freezeModels = (): void => {
    if (!freezeView) return;
    for (const m of deps.getModels()) {
      if (m.frozen === true) continue; // already frozen (by us or the loader)
      try {
        m.frozen = true;
        frozenByUs.add(m);
      } catch {
        // engine-shape drift: a model without the setter just keeps refreshing
      }
    }
  };
  const unfreezeModels = (): void => {
    if (frozenByUs.size === 0) return;
    const live = new Set<SpeedupModel>(deps.getModels());
    for (const m of frozenByUs) {
      if (!live.has(m)) continue; // disposed / swapped meanwhile
      try {
        m.frozen = false;
      } catch {
        // best-effort
      }
    }
    frozenByUs.clear();
  };

  const three = deps.renderer.three;
  const lowerPixelRatio = (): void => {
    if (scale >= 1 || !three?.getPixelRatio || !three.setPixelRatio) return;
    if (restRatio !== null) return;
    restRatio = three.getPixelRatio();
    three.setPixelRatio(restRatio * scale);
  };
  const restorePixelRatio = (): void => {
    if (restRatio === null) return;
    const r = restRatio;
    restRatio = null;
    three?.setPixelRatio?.(r);
  };

  const controller = new NavigationModeController({
    idleMs: deps.idleMs,
    settleDelayMs: deps.settleDelayMs,
    onStart: () => {
      freezeModels();
      lowerPixelRatio();
      budget?.resetTiming();
      stats = { frames: 0, hidden: 0, renderMs: 0, t0: now() };
      deps.onStart?.();
    },
    onStop: (reason) => {
      if (applied) {
        budget?.restore();
        applied = false;
      }
      restorePixelRatio();
      unfreezeModels();
      const f = stats.frames;
      deps.onStop?.(reason, {
        frames: f,
        meanHidden: f ? Math.round(stats.hidden / f) : 0,
        meanRenderMs: f ? Math.round((stats.renderMs / f) * 100) / 100 : 0,
        budget: budget?.budget ?? null,
        durationMs: Math.round(now() - stats.t0),
      });
    },
    onSettle: () => {
      deps.refresh();
    },
  });
  controller.attach(deps.controls);

  const beforeRender = (): void => {
    if (!controller.moving) return;
    // A model that finished loading mid-gesture joins the frozen set.
    freezeModels();
    if (!budget) return;
    const camera = deps.getCamera();
    if (!camera) return;
    frameStart = now();
    const roots: THREE.Object3D[] = [];
    for (const m of deps.getModels()) if (m.object) roots.push(m.object);
    try {
      stats.hidden += budget.apply(roots, camera, three?.clippingPlanes ?? []);
      applied = true;
    } catch {
      budget.restore();
      applied = false;
    }
  };
  const afterRender = (): void => {
    if (!applied || !budget) return;
    budget.restore();
    applied = false;
    const ms = now() - frameStart;
    stats.frames++;
    stats.renderMs += ms;
    budget.recordFrame(ms);
  };
  deps.renderer.onBeforeUpdate?.add(beforeRender);
  deps.renderer.onAfterUpdate?.add(afterRender);

  let disposed = false;
  return {
    controller,
    budget,
    forceRest: () => controller.stop("manual"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      controller.dispose(); // runs onStop when moving → restores everything
      deps.renderer.onBeforeUpdate?.remove?.(beforeRender);
      deps.renderer.onAfterUpdate?.remove?.(afterRender);
      budget?.restore();
    },
  };
}
