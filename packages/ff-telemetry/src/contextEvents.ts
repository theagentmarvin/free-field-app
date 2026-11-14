// contextEvents.ts — WebGL context loss/restore as FIRST-CLASS events.
//
// `RendererDiagnostics` treats a lost device as a reportable
// event, not a log line: when the GPU context flaps more than twice in
// a session the field app escalates ("SetExtra" analog — a warning
// capture carrying the loss count) so the office sees the tablet
// trouble instead of the user seeing a frozen viewer.
//
// Spec §7 U3 / §4.3 / §5.2:
//   - `webglcontextlost` → breadcrumb ("context", "lost") carrying the
//     session's `deviceLostCount`.
//   - restore → breadcrumb ("context", "restored"), also carrying the
//     (unchanged) `deviceLostCount`.
//   - > 2 losses in a session → ONE escalation (level "warning",
//     reason "webgl-context-flapping") through an INJECTED callback,
//     so this module stays Sentry-free and unit-testable.
//   - a restore NEVER decrements the counter (v1 semantics preserved:
//     `noteDeviceLost()` counts, `noteDeviceRestored()` only records).
//
// The counters themselves stay in `telemetry.ts` (single source of
// truth) — this module only calls the public `noteDeviceLost()` /
// `noteDeviceRestored()` API and reads `deviceLostCount` back.
//
// Survivability law: every callback body is `safe()`-wrapped, the
// listeners never throw into app code, and the module touches no DOM
// at import time. No `three` import (structural types only).
//
// Observation only: we NEVER call `preventDefault()` on
// `webglcontextlost` — the app owns the cancel decision (WebGL
// restoration requires the app to cancel the event itself). The
// listener options are forwarded verbatim (and reused on detach) so
// the app can keep `capture`/`passive` semantics it needs.

import { safe } from "./safe";

/** DOM event fired when the WebGL context is lost. */
export const CONTEXT_LOST_EVENT = "webglcontextlost";
/** DOM event fired when the WebGL context is restored. */
export const CONTEXT_RESTORED_EVENT = "webglcontextrestored";
/** Short alias accepted for the restore signal (spec wording:
 *  "`webglcontextlost`/`restored`"). */
export const CONTEXT_RESTORED_ALIAS_EVENT = "restored";

/** Escalation reason ("SetExtra" analog). */
export const CONTEXT_FLAPPING_REASON = "webgl-context-flapping";

/** Loss count above which the session escalates (> 2 ⇒ 3rd loss). */
export const CONTEXT_LOSS_ESCALATION_THRESHOLD = 2;

/**
 * The telemetry surface this module needs. Structural on purpose: the
 * v1 `Telemetry` instance satisfies it, and tests can inject a tiny
 * fake recorder without pulling the whole ring-buffer machine in.
 */
export interface ContextEventTelemetry {
  /** Record a breadcrumb (category / action / data). */
  breadcrumb(
    category: string,
    action: string,
    data?: Record<string, unknown>,
  ): void;
  /** v1 semantics: increments the lifetime loss counter. */
  noteDeviceLost(): void;
  /** v1 semantics: records a restore — NEVER decrements the counter. */
  noteDeviceRestored(): void;
  /** Lifetime loss count for the session. */
  readonly deviceLostCount: number;
}

/** Listener options accepted by the DOM (and mirrored on detach). */
export interface ContextListenerOptions {
  capture?: boolean;
  passive?: boolean;
}

/**
 * Minimal event-target surface. Kept structural (and optional) so a
 * canvas, an `EventTarget`, or the viewer's lightweight
 * `CanvasEventTargetLike` all fit without a DOM type dependency.
 */
export interface ContextEventTarget {
  addEventListener?: (
    type: string,
    listener: EventListener,
    options?: ContextListenerOptions,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListener,
    options?: ContextListenerOptions,
  ) => void;
}

/** Payload handed to the escalation callback (Sentry-free shape). */
export interface ContextEscalationExtra {
  /** Severity semantics — the capture is a warning, not an error. */
  level: "warning";
  /** Machine-readable reason (`webgl-context-flapping`). */
  reason: typeof CONTEXT_FLAPPING_REASON;
  /** Loss count observed when the threshold was crossed. */
  deviceLostCount: number;
}

/**
 * Escalation callback. `message` is the capture text; `extra` carries
 * the level / reason / count so a Sentry adapter can forward it as
 * `captureMessage(message, { level: extra.level, extra })`.
 */
export type ContextEscalationHandler = (
  message: string,
  extra: ContextEscalationExtra,
) => void;

/** Injected dependencies for {@link attachContextEvents}. */
export interface ContextEventsDeps {
  /** Telemetry instance (breadcrumb + counters). */
  telemetry: ContextEventTelemetry;
  /** Optional escalation sink — injected so tests stay Sentry-free. */
  onEscalation?: ContextEscalationHandler;
  /**
   * Listener options forwarded to `addEventListener` (and reused on
   * detach so the capture flag matches). Defaults to the DOM default
   * (`capture: false`, `passive: false`) — the app stays free to
   * `preventDefault()` the `webglcontextlost` event itself.
   */
  listenerOptions?: ContextListenerOptions;
}

/**
 * Default listener options. `capture: false` keeps us on the bubble
 * phase; `passive: false` leaves the event cancelable for the APP's
 * own `preventDefault()` (required for WebGL restoration). We never
 * cancel it ourselves — observation only.
 */
const DEFAULT_LISTENER_OPTIONS: ContextListenerOptions = {
  capture: false,
  passive: false,
};

/**
 * Sessions that already escalated. Keyed by the telemetry instance so
 * the one-time capture is per SESSION (a viewer remount / re-attach
 * cannot fire it twice) while a fresh session can still escalate on
 * its own.
 */
const escalatedSessions = new WeakSet<object>();

/**
 * Fire the escalation at most once per session, and only after the
 * loss count passes the threshold. Never throws.
 */
function maybeEscalate(
  telemetry: ContextEventTelemetry,
  count: number,
  onEscalation: ContextEscalationHandler | undefined,
): void {
  if (!onEscalation) return;
  if (!Number.isFinite(count) || count <= CONTEXT_LOSS_ESCALATION_THRESHOLD) {
    return;
  }
  const key = telemetry as unknown as object;
  if (typeof key !== "object" || key === null) return;
  if (escalatedSessions.has(key)) return;
  // Latch BEFORE calling out: a throwing sink must not turn into a
  // repeated escalation storm on the next loss.
  escalatedSessions.add(key);
  safe(
    () =>
      onEscalation(CONTEXT_FLAPPING_REASON, {
        level: "warning",
        reason: CONTEXT_FLAPPING_REASON,
        deviceLostCount: count,
      }),
    "context escalation failed",
  );
}

/**
 * Attach WebGL context-loss / context-restore observers to a canvas
 * (or any event target).
 *
 * Behaviour:
 *   - loss → `telemetry.noteDeviceLost()` (counter++) then a
 *     first-class `("context", "lost")` breadcrumb with the session's
 *     `deviceLostCount`; past the threshold → one escalation.
 *   - restore → `telemetry.noteDeviceRestored()` (counter untouched)
 *     then a `("context", "restored")` breadcrumb with the unchanged
 *     `deviceLostCount`.
 *
 * Returns a detach function that removes every listener. Safe(): the
 * function never throws into app code.
 */
export function attachContextEvents(
  target: ContextEventTarget | null | undefined,
  deps: ContextEventsDeps,
): () => void {
  return (
    safe(() => {
      if (!target || typeof target.addEventListener !== "function") {
        return () => {
          /* nothing attached */
        };
      }

      const telemetry = deps.telemetry;
      const onEscalation = deps.onEscalation;
      const options = {
        ...DEFAULT_LISTENER_OPTIONS,
        ...(deps.listenerOptions ?? {}),
      };

      // Loss events observed by THIS attachment. The session counter
      // lives in `telemetry` (single source of truth); we keep a local
      // tally as a floor so the breadcrumb/escalation can never report
      // fewer losses than actually happened (e.g. a reporter that does
      // not expose a live counter).
      let observedLosses = 0;

      // A restore is only recorded once per loss cycle. Some hosts
      // emit BOTH `webglcontextrestored` and the short `restored`
      // alias for the same restore — without this guard the error
      // crumb would be written twice and `noteDeviceRestored()` would
      // run twice (the v1 seam only ever saw one event).
      let restoreRecorded = false;

      /** Session loss count: the telemetry counter, never below what we observed. */
      const sessionLossCount = (): number => {
        const reported = safe(
          () => telemetry.deviceLostCount,
          "read deviceLostCount failed",
        );
        if (typeof reported !== "number" || !Number.isFinite(reported)) {
          return observedLosses;
        }
        return Math.max(reported, observedLosses);
      };

      const onLost = (_event: Event): void => {
        safe(() => {
          telemetry.noteDeviceLost();
          observedLosses += 1;
          restoreRecorded = false;
          const count = sessionLossCount();
          telemetry.breadcrumb("context", "lost", { deviceLostCount: count });
          maybeEscalate(telemetry, count, onEscalation);
        }, "webglcontextlost handler failed");
      };

      const onRestored = (_event: Event): void => {
        safe(() => {
          if (restoreRecorded) return; // same restore, second event name
          restoreRecorded = true;
          // v1 semantics: a restore NEVER decrements the counter.
          telemetry.noteDeviceRestored();
          telemetry.breadcrumb("context", "restored", {
            deviceLostCount: sessionLossCount(),
          });
        }, "webglcontextrestored handler failed");
      };

      target.addEventListener(CONTEXT_LOST_EVENT, onLost, options);
      target.addEventListener(CONTEXT_RESTORED_EVENT, onRestored, options);
      // Short alias — some hosts emit `restored` instead of the DOM
      // `webglcontextrestored`. Observing it keeps the first-class
      // breadcrumb complete either way.
      target.addEventListener(CONTEXT_RESTORED_ALIAS_EVENT, onRestored, options);

      return () => {
        safe(() => {
          target.removeEventListener?.(CONTEXT_LOST_EVENT, onLost, options);
          target.removeEventListener?.(
            CONTEXT_RESTORED_EVENT,
            onRestored,
            options,
          );
          target.removeEventListener?.(
            CONTEXT_RESTORED_ALIAS_EVENT,
            onRestored,
            options,
          );
        }, "detach context events failed");
      };
    }, "attachContextEvents failed") ??
    (() => {
      /* no-op detach */
    })
  );
}
