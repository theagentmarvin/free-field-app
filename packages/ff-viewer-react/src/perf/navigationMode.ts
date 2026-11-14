// packages/ff-viewer-react/src/perf/navigationMode.ts
//
// Navigation mode: the single owner of "is the camera moving right now?"
// for the viewer's motion-time speedups (frozen tile refresh, motion draw
// budget, reduced pixel ratio). Pure: no three.js, no engine imports —
// it only listens to a camera-controls style event target.
//
// camera-controls 3.1.2 events used:
//   control         user drag step / wheel notch (wheel emits ONLY this)
//   transitionstart a programmatic move with transition (fit, setLookAt
//                   with enableTransition, setPose animate)
//   update          the camera changed this frame
//   rest            the motion settled below restThreshold
//   sleep           the camera stopped changing
//   controlstart    pointer down — NOT motion by itself (a click must not
//                   enter navigation mode), only keeps an active one alive
//
// Motion STARTS on `control`, or on the first `update` after a
// `transitionstart`. Motion STOPS `settleDelayMs` after `rest` / `sleep`
// (cancelled by new user input), on `stop()`, or when no camera event
// arrived for `idleMs` (safety timer — a missed `rest` can never leave
// the viewer stuck in its degraded motion mode).
//
// While a pointer drag is in progress (controlstart … controlend),
// `rest` / `sleep` are ignored: camera-controls emits `sleep` on any
// frame without pointer input (the display refreshes faster than the
// mouse reports), so a slow drag would otherwise flip in and out of
// motion mode many times per second — every flip costs a full-quality
// frame, a canvas resize and a worker re-cull. The idle timer still
// ends motion when the user holds the pointer still.
//
// Callbacks:
//   onStart()          entering motion
//   onStop(reason)     leaving motion
//   onSettle(reason)   after every settle (rest/sleep/idle/stop), whether
//                      or not motion mode was active — programmatic jumps
//                      without a transition (wake → update → sleep) also
//                      end with a settle, so the caller can always refresh
//                      the view there.

export type NavigationStopReason = "rest" | "sleep" | "idle" | "manual";

export interface CameraEventTarget {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener?(type: string, cb: () => void): void;
}

export interface NavigationModeOptions {
  /** Silence (ms) after which motion is treated as ended. */
  idleMs?: number;
  /** Delay (ms) between rest/sleep and leaving motion mode. */
  settleDelayMs?: number;
  onStart?: () => void;
  onStop?: (reason: NavigationStopReason) => void;
  onSettle?: (reason: NavigationStopReason) => void;
}

export const NAVIGATION_IDLE_MS = 400;
export const NAVIGATION_SETTLE_DELAY_MS = 150;

export class NavigationModeController {
  private _moving = false;
  private transitionPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;
  private readonly idleMs: number;
  private readonly settleDelayMs: number;
  private readonly opts: NavigationModeOptions;
  private detachFns: Array<() => void> = [];
  private disposed = false;

  constructor(opts: NavigationModeOptions = {}) {
    this.opts = opts;
    this.idleMs = opts.idleMs ?? NAVIGATION_IDLE_MS;
    this.settleDelayMs = opts.settleDelayMs ?? NAVIGATION_SETTLE_DELAY_MS;
  }

  get moving(): boolean {
    return this._moving;
  }

  /** Wire to a camera-controls instance. Returns a detach function. */
  attach(target: CameraEventTarget): () => void {
    const on = (type: string, cb: () => void): void => {
      target.addEventListener(type, cb);
      this.detachFns.push(() => target.removeEventListener?.(type, cb));
    };
    on("control", () => this.control());
    on("controlstart", () => this.controlStart());
    on("controlend", () => this.controlEnd());
    on("transitionstart", () => this.transitionStart());
    on("update", () => this.update());
    on("rest", () => this.cameraSettled("rest"));
    on("sleep", () => this.cameraSettled("sleep"));
    return () => this.detach();
  }

  detach(): void {
    const fns = this.detachFns;
    this.detachFns = [];
    for (const f of fns) f();
  }

  /** User input moved the camera (drag step / wheel notch). */
  control(): void {
    if (this.disposed) return;
    this.clearSettleTimer();
    this.begin();
    this.arm();
  }

  /** Pointer down: keeps an active motion alive, never starts one. */
  controlStart(): void {
    if (this.disposed) return;
    this.dragging = true;
    this.clearSettleTimer();
    if (this._moving) this.arm();
  }

  /** Pointer up: from here on rest/sleep may end the motion. */
  controlEnd(): void {
    if (this.disposed) return;
    this.dragging = false;
    if (this._moving) this.arm();
  }

  /**
   * camera-controls rest/sleep. Ignored mid-drag; otherwise ends the
   * motion after `settleDelayMs` unless new user input arrives first.
   * When not moving, settles right away (programmatic jump).
   */
  cameraSettled(reason: "rest" | "sleep"): void {
    if (this.disposed) return;
    if (!this._moving && !this.transitionPending) {
      this.settle(reason);
      return;
    }
    if (this.dragging) return;
    if (this.settleDelayMs <= 0) {
      this.settle(reason);
      return;
    }
    if (this.settleTimer !== null) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settle(reason);
    }, this.settleDelayMs);
  }

  /** A programmatic transition was requested. */
  transitionStart(): void {
    if (this.disposed) return;
    this.transitionPending = true;
    this.arm();
  }

  /** The camera changed this frame. */
  update(): void {
    if (this.disposed) return;
    if (this._moving) {
      this.arm();
    } else if (this.transitionPending) {
      this.begin();
      this.arm();
    }
  }

  /** Motion settled (camera-controls rest/sleep). */
  settle(reason: NavigationStopReason): void {
    if (this.disposed) return;
    this.clearTimer();
    this.clearSettleTimer();
    this.dragging = false;
    this.transitionPending = false;
    if (this._moving) {
      this._moving = false;
      this.opts.onStop?.(reason);
    }
    this.opts.onSettle?.(reason);
  }

  /**
   * Leave motion mode now (e.g. before a snapshot or when the view is
   * torn down). No-op settle when not moving and nothing is pending.
   */
  stop(reason: NavigationStopReason = "manual"): void {
    if (this.disposed) return;
    if (
      !this._moving &&
      !this.transitionPending &&
      this.timer === null &&
      this.settleTimer === null
    ) {
      return;
    }
    this.settle(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.clearSettleTimer();
    if (this._moving) {
      this._moving = false;
      this.opts.onStop?.("manual");
    }
    this.detach();
    this.disposed = true;
  }

  private begin(): void {
    if (this._moving) return;
    this._moving = true;
    this.opts.onStart?.();
  }

  private arm(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settle("idle");
    }, this.idleMs);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
