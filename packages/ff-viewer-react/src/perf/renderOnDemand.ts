// packages/ff-viewer-react/src/perf/renderOnDemand.ts
//
// Glue between the RenderScheduler (pure policy) and the OBC world: puts
// the SimpleRenderer in MANUAL mode and wires every engine-level source
// of visual change to `invalidate()`. Engine objects are typed
// structurally (every member optional), so this module stays testable
// with plain fakes and degrades to "render more", never to "render less",
// when an engine surface is missing.
//
// OBC semantics this relies on (@thatopen/components 3.6):
//   - `Components.update` runs every animation frame regardless of the
//     renderer mode and calls `Worlds.update` → `SimpleWorld.update`:
//       world.onBeforeUpdate → scene.update → camera.update (camera-controls
//       update; emits 'update' when the camera changed) → renderer.update.
//   - `SimpleRenderer.update`: `if (mode === MANUAL && !needsUpdate) return;`
//     then clears `needsUpdate`, fires onBeforeUpdate, renders, fires
//     onAfterUpdate. So onBefore/onAfterUpdate fire ONLY for real renders.
//   So: the per-frame decision runs on `world.onBeforeUpdate`, camera
//   'update' events set `needsUpdate` synchronously (same frame), and the
//   renderer's onAfterUpdate marks "a main render happened".
//
// Wired here (generic, engine-level):
//   camera-controls update/control/transitionstart/wake/rest/sleep/
//     controlstart/controlend;
//   renderer.onResize (canvas resize clears the drawing buffer),
//   renderer.onClippingPlanesUpdated (Clipper add/remove/move);
//   scene childadded/childremoved (model roots, overlay meshes);
//   canvas webglcontextrestored;
//   user input on the viewer container (pointer/wheel/keys) — covers
//     hover tints, plane dragging, measurement previews, snapping;
//   fragments: every tile request applied on the main thread (create /
//     update / delete — loads, highlight tints, visibility, LOD), model
//     loaded / added / removed, and continuous rendering while a model
//     is busy streaming (with a stall cap).
// The viewer adds its own call sites on top (handle calls, highlight
// queue, visibility flush, section fills, motion settle, pause/resume).

import {
  RenderScheduler,
  SIGNATURE_SEED,
  mixSignature,
  type RenderMode,
  type RenderSchedulerStats,
  type StaleFrameInfo,
  type ViewSignature,
} from "./renderScheduler";
import type { CameraEventTarget } from "./navigationMode";

export interface RodEvent<T = unknown> {
  add(handler: (data: T) => void): void;
  remove?(handler: (data: T) => void): void;
}

interface DomTarget {
  addEventListener(type: string, cb: (e: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, cb: (e: unknown) => void, opts?: unknown): void;
}

export interface RodRenderer {
  mode?: number;
  needsUpdate?: boolean;
  enabled?: boolean;
  onAfterUpdate?: RodEvent;
  onResize?: RodEvent;
  onClippingPlanesUpdated?: RodEvent;
  three?: {
    domElement?: Partial<DomTarget> | null;
    getPixelRatio?: () => number;
    clippingPlanes?: ArrayLike<{ constant?: number; normal?: { x: number; y: number; z: number } }>;
    getSize?: (t: { x: number; y: number; set(x: number, y: number): unknown }) => unknown;
  };
}

export interface RodCamera {
  position?: { x: number; y: number; z: number };
  quaternion?: { x: number; y: number; z: number; w: number };
  projectionMatrix?: { elements: ArrayLike<number> };
  zoom?: number;
}

export interface RodScene {
  children?: ArrayLike<{ visible?: boolean }>;
  addEventListener?: (type: string, cb: (e: unknown) => void) => void;
  removeEventListener?: (type: string, cb: (e: unknown) => void) => void;
}

export interface RodModel {
  isBusy?: boolean;
  object?: { visible?: boolean };
  tiles?: { size?: number };
}

/** Fragments surfaces watched for tile application (all optional). */
export interface RodFragmentsCore {
  onModelLoaded?: RodEvent;
  models?: {
    list?: { values(): Iterable<RodModel> };
    /** MeshManager's per-applied-request callback (private engine seam). */
    _onUpdate?: unknown;
  };
}

export interface RodFragmentsManager {
  core?: RodFragmentsCore;
  list?: { onItemSet?: RodEvent; onItemDeleted?: RodEvent };
}

export interface RenderOnDemandConfig {
  /** Keep-alive window after an invalidation (ms). Default 300. */
  keepAliveMs?: number;
  /** Idle heartbeat render period (ms); 0 = off (default). */
  heartbeatMs?: number;
  /** Stale-frame guard (default true). */
  staleGuard?: boolean;
  /**
   * Continuous rendering while a model `isBusy` stops after this long
   * without any tile applied on the main thread (ms). A model whose
   * FINISH never arrives would otherwise pin the viewer at full frame
   * rate forever. Default 2000.
   */
  busyStallMs?: number;
  /**
   * Wave 61 — streaming render throttle. While `streamThrottle()` says a
   * load is streaming and there was no user input / camera event for
   * `streamInputGraceMs`, renders driven ONLY by tile streaming (applied
   * tile requests, a busy model) happen at most once per this many ms.
   * Each full-resolution frame of a big scene costs the main thread and
   * GPU process tens of ms that the tile build / apply needs (measured,
   * heavy scenario: ~2 s slower fill-in at full frame rate). Every other
   * invalidation (camera, input, handle calls, highlight) still renders
   * at once. 0 disables (default).
   */
  streamRenderIntervalMs?: number;
  /** Input / camera quiet time before the stream throttle applies (ms). Default 1000. */
  streamInputGraceMs?: number;
}

export interface RenderOnDemandDeps extends RenderOnDemandConfig {
  renderer: RodRenderer;
  /** `world.onBeforeUpdate` — fires every animation frame. */
  frameEvent?: RodEvent;
  controls?: Partial<CameraEventTarget> | null;
  getCamera?: () => RodCamera | null | undefined;
  getScene?: () => RodScene | null | undefined;
  /** Element whose user input should keep the view fresh. */
  inputTarget?: Partial<DomTarget> | null;
  /** Window-level key events (Escape cancels a measurement, ...). */
  keyTarget?: Partial<DomTarget> | null;
  /** Fragments models (for busy + signature). */
  getModels?: () => Iterable<RodModel>;
  /** Extra continuous reasons owned by the viewer (moving, tools...). */
  continuous?: () => string | null;
  /** Is a load streaming right now (the stream throttle may apply)? Default: never. */
  streamThrottle?: () => boolean;
  mode?: RenderMode;
  /** Renderer mode constants (OBC.RendererMode). */
  manualMode?: number;
  autoMode?: number;
  now?: () => number;
  onStale?: (info: StaleFrameInfo) => void;
}

export interface RenderOnDemand {
  readonly scheduler: RenderScheduler;
  invalidate(reason?: string, keepAliveMs?: number): void;
  /** Hook a FragmentsManager (call once it is initialised). */
  watchFragments(manager: RodFragmentsManager | null | undefined): void;
  setMode(mode: RenderMode): void;
  stats(): RenderSchedulerStats;
  dispose(): void;
}

const CAMERA_EVENTS = [
  "update",
  "control",
  "controlstart",
  "controlend",
  "transitionstart",
  "wake",
  "rest",
  "sleep",
] as const;
const INPUT_EVENTS = ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick", "contextmenu"] as const;
const KEY_EVENTS = ["keydown", "keyup"] as const;
const SCENE_EVENTS = ["childadded", "childremoved"] as const;

const SIZE_SCRATCH = {
  x: 0,
  y: 0,
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
    return this;
  },
};

export function installRenderOnDemand(deps: RenderOnDemandDeps): RenderOnDemand {
  const now = deps.now ?? (() => performance.now());
  const renderer = deps.renderer;
  const manual = deps.manualMode ?? 0;
  const auto = deps.autoMode ?? 1;
  const busyStallMs = deps.busyStallMs ?? 2000;
  const detach: Array<() => void> = [];
  let disposed = false;
  // Last time a fragments tile request was applied on the main thread
  // (only meaningful when the MeshManager seam was hooked).
  let lastTileAt = -Infinity;
  let tileSeamHooked = false;
  let wasBusy = false;
  // Stream throttle state (see RenderOnDemandConfig.streamRenderIntervalMs).
  const streamIntervalMs = Math.max(0, deps.streamRenderIntervalMs ?? 0);
  const streamGraceMs = Math.max(0, deps.streamInputGraceMs ?? 1000);
  let lastInputAt = -Infinity;
  let lastRenderAt = -Infinity;
  // Tiles applied since the last render while throttled (render owed).
  let streamPending = false;
  // `models` part of the view signature at the last render — reported
  // while a throttled render is owed, so the stale-frame guard does not
  // treat the deliberately deferred tiles as a missed invalidation.
  let renderedModelsSig: number | undefined;
  const streamThrottled = (): boolean => {
    if (streamIntervalMs <= 0 || disposed) return false;
    if (now() - lastInputAt < streamGraceMs) return false;
    try {
      return deps.streamThrottle?.() === true;
    } catch {
      return false;
    }
  };
  const noteInput = (): void => {
    lastInputAt = now();
  };

  const applyMode = (m: RenderMode): void => {
    try {
      renderer.mode = m === "always" ? auto : manual;
    } catch {
      // a renderer without a mode just keeps rendering every frame
    }
  };

  // Evaluated once per frame (before the decision), so the busy period
  // and its stall clock are tracked even while other reasons render.
  let busyState: string | null = null;
  const updateBusy = (): string | null => {
    let busy = false;
    try {
      for (const m of deps.getModels?.() ?? []) {
        if (m?.isBusy) {
          busy = true;
          break;
        }
      }
    } catch {
      return null;
    }
    if (!busy) {
      if (wasBusy) {
        wasBusy = false;
        // The last tiles of a stream may have been applied after the
        // previous frame — one more short burst picks them up.
        scheduler.invalidate("busy-end");
      }
      return null;
    }
    if (!wasBusy) {
      wasBusy = true;
      lastTileAt = now(); // the stall clock starts with the busy period
    }
    // With the tile seam hooked every applied tile invalidates anyway; the
    // busy loop is a belt-and-braces that must not pin a wedged stream.
    if (tileSeamHooked && now() - lastTileAt > busyStallMs) return null;
    if (streamThrottled() && now() - lastRenderAt < streamIntervalMs) return null;
    return "busy";
  };

  const signature =
    deps.staleGuard === false
      ? undefined
      : (): ViewSignature | null => {
          const out: ViewSignature = {};
          const cam = deps.getCamera?.();
          if (cam) {
            let h = SIGNATURE_SEED;
            const p = cam.position;
            const q = cam.quaternion;
            if (p) h = mixSignature(mixSignature(mixSignature(h, p.x), p.y), p.z);
            if (q) h = mixSignature(mixSignature(mixSignature(mixSignature(h, q.x), q.y), q.z), q.w);
            const e = cam.projectionMatrix?.elements;
            if (e) for (let i = 0; i < e.length; i++) h = mixSignature(h, e[i] * 64);
            if (typeof cam.zoom === "number") h = mixSignature(h, cam.zoom);
            out.camera = h;
          }
          const three = renderer.three;
          if (three) {
            let h = SIGNATURE_SEED;
            if (typeof three.getSize === "function") {
              three.getSize(SIZE_SCRATCH);
              h = mixSignature(mixSignature(h, SIZE_SCRATCH.x), SIZE_SCRATCH.y);
            }
            if (typeof three.getPixelRatio === "function") h = mixSignature(h, three.getPixelRatio());
            out.size = h;
            const planes = three.clippingPlanes;
            if (planes) {
              let c = mixSignature(SIGNATURE_SEED, planes.length);
              for (let i = 0; i < planes.length; i++) {
                const pl = planes[i];
                c = mixSignature(c, pl?.constant ?? 0);
                if (pl?.normal) c = mixSignature(mixSignature(mixSignature(c, pl.normal.x), pl.normal.y), pl.normal.z);
              }
              out.clip = c;
            }
          }
          const scene = deps.getScene?.();
          const children = scene?.children;
          if (children) {
            let h = mixSignature(SIGNATURE_SEED, children.length);
            for (let i = 0; i < children.length; i++) h = mixSignature(h, children[i]?.visible === false ? 0 : 1);
            out.scene = h;
          }
          let tiles = SIGNATURE_SEED;
          let any = false;
          for (const m of deps.getModels?.() ?? []) {
            any = true;
            tiles = mixSignature(tiles, m?.tiles?.size ?? -1);
            tiles = mixSignature(tiles, m?.object?.visible === false ? 0 : 1);
          }
          if (any) {
            out.models =
              streamPending && renderedModelsSig !== undefined ? renderedModelsSig : tiles;
          }
          return out;
        };

  const scheduler = new RenderScheduler({
    mode: deps.mode ?? "on-demand",
    keepAliveMs: deps.keepAliveMs,
    heartbeatMs: deps.heartbeatMs,
    now,
    continuous: () => deps.continuous?.() ?? busyState,
    signature,
    onStale: deps.onStale,
    onInvalidate: () => {
      if (disposed) return;
      try {
        renderer.needsUpdate = true;
      } catch {
        // ignore
      }
    },
  });
  applyMode(scheduler.mode);

  const invalidate = (reason = "unknown", keepAliveMs?: number): void => {
    if (disposed) return;
    scheduler.invalidate(reason, keepAliveMs);
  };

  const listen = <T>(ev: RodEvent<T> | undefined | null, fn: (d: T) => void): void => {
    if (!ev || typeof ev.add !== "function") return;
    try {
      ev.add(fn);
      detach.push(() => {
        try {
          ev.remove?.(fn);
        } catch {
          // already gone
        }
      });
    } catch {
      // engine-shape drift: this source just isn't watched
    }
  };
  const listenDom = (
    target: Partial<DomTarget> | null | undefined,
    types: readonly string[],
    fn: (e: unknown) => void,
    opts?: unknown,
  ): void => {
    if (!target || typeof target.addEventListener !== "function") return;
    for (const t of types) {
      try {
        target.addEventListener(t, fn, opts);
        detach.push(() => target.removeEventListener?.(t, fn, opts));
      } catch {
        // ignore
      }
    }
  };

  // ── per-frame decision ─────────────────────────────────────────
  const onFrame = (): void => {
    if (disposed) return;
    if (renderer.enabled === false) return; // paused: nothing would render
    busyState = updateBusy();
    if (streamPending && (!streamThrottled() || now() - lastRenderAt >= streamIntervalMs)) {
      streamPending = false;
      scheduler.invalidate("tiles", 0);
    }
    if (scheduler.frame() !== null) renderer.needsUpdate = true;
  };
  listen(deps.frameEvent, onFrame);
  listen(renderer.onAfterUpdate, () => {
    if (disposed) return;
    lastRenderAt = now();
    streamPending = false;
    scheduler.rendered();
    renderedModelsSig = signature?.()?.models;
  });

  // ── camera-controls ────────────────────────────────────────────
  const ctl = deps.controls;
  if (ctl && typeof ctl.addEventListener === "function") {
    for (const type of CAMERA_EVENTS) {
      const fn = (): void => {
        noteInput();
        invalidate(`camera-${type}`, type === "update" ? 0 : undefined);
      };
      try {
        ctl.addEventListener(type, fn);
        detach.push(() => ctl.removeEventListener?.(type, fn));
      } catch {
        // ignore
      }
    }
  }

  // ── renderer / scene / canvas ──────────────────────────────────
  listen(renderer.onResize, () => invalidate("resize"));
  listen(renderer.onClippingPlanesUpdated, () => invalidate("clipping"));
  const scene = deps.getScene?.();
  listenDom(scene as Partial<DomTarget> | undefined, SCENE_EVENTS, () => invalidate("scene-child"));
  listenDom(renderer.three?.domElement ?? null, ["webglcontextrestored"], () => invalidate("context-restored"));
  listenDom(deps.inputTarget, INPUT_EVENTS, () => {
    noteInput();
    invalidate("input");
  }, { capture: true, passive: true });
  listenDom(deps.keyTarget, KEY_EVENTS, () => {
    noteInput();
    invalidate("key");
  });

  // ── fragments ──────────────────────────────────────────────────
  const watched = new WeakSet<object>();
  const watchFragments = (manager: RodFragmentsManager | null | undefined): void => {
    if (disposed || !manager || watched.has(manager)) return;
    watched.add(manager);
    listen(manager.list?.onItemSet, () => invalidate("model-added"));
    listen(manager.list?.onItemDeleted, () => invalidate("model-removed"));
    const core = manager.core;
    if (!core) return;
    listen(core.onModelLoaded, () => invalidate("model-loaded"));
    // MeshManager calls `_onUpdate()` after EVERY tile request it applies
    // on the main thread (create / update / delete / finish) — tile
    // streaming, highlight tints, visibility (Hider), LOD switches all
    // land through it. Wrapping the instance property (feature-detected)
    // is the one place that sees all of them.
    const mm = core.models as { _onUpdate?: unknown } | undefined;
    if (mm && typeof mm._onUpdate === "function") {
      const orig = mm._onUpdate as (...a: unknown[]) => unknown;
      const wrapped = function (this: unknown, ...a: unknown[]): unknown {
        lastTileAt = now();
        // Throttled stream: the render is owed, onFrame pays it at most
        // once per streamRenderIntervalMs.
        if (streamThrottled()) streamPending = true;
        else invalidate("tiles");
        return orig.apply(this, a);
      };
      try {
        mm._onUpdate = wrapped;
        tileSeamHooked = true;
        detach.push(() => {
          if (mm._onUpdate === wrapped) mm._onUpdate = orig;
        });
      } catch {
        // frozen object: the busy loop covers tile streaming
      }
    }
    invalidate("fragments");
  };

  invalidate("install");

  return {
    scheduler,
    invalidate,
    watchFragments,
    setMode: (m) => {
      scheduler.mode = m;
      applyMode(m);
    },
    stats: () => scheduler.stats,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const f of detach.splice(0)) {
        try {
          f();
        } catch {
          // ignore
        }
      }
      // Leave the renderer in the engine default (AUTO) so anything that
      // outlives us keeps drawing.
      try {
        renderer.mode = auto;
      } catch {
        // ignore
      }
    },
  };
}

// ── imperative-handle wrapper ────────────────────────────────────
//
// Every IfcViewerHandle method that can change what is on screen
// invalidates the view when it is called, when it returns and — for
// async methods — when its promise settles. Methods that only READ
// (getters, queries, subscriptions, projections, picks) are left alone:
// overlay layers call some of them every animation frame, and an
// invalidation there would keep the viewer rendering forever.
export const READ_ONLY_HANDLE_METHOD =
  /^(get[A-Z]|is[A-Z]|has[A-Z]|on[A-Z]|worldToScreen$|unprojectToFloorPlane$|pickWorldPoint$|setOnElementPick$|requestRender$)/;

export function wrapHandleForInvalidation<T extends object>(
  handle: T,
  invalidate: (reason: string) => void,
  isReadOnly: (name: string) => boolean = (n) => READ_ONLY_HANDLE_METHOD.test(n),
): T {
  const out = {} as T;
  const descs = Object.getOwnPropertyDescriptors(handle);
  for (const key of Object.keys(descs)) {
    const d = descs[key];
    if (typeof d.value === "function" && !isReadOnly(key)) {
      const fn = d.value as (...a: unknown[]) => unknown;
      const reason = `handle:${key}`;
      d.value = function (this: unknown, ...args: unknown[]): unknown {
        invalidate(reason);
        let result: unknown;
        try {
          result = fn.apply(this, args);
        } finally {
          invalidate(reason);
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(
            () => invalidate(reason),
            () => invalidate(reason),
          );
        }
        return result;
      };
    }
    Object.defineProperty(out, key, d);
  }
  return out;
}
