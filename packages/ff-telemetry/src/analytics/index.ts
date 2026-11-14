// analytics/index.ts — Channel C (Firebase Analytics) session rollups.
//
// Spec §5.6 / §7 U5: at the end of a session (`pagehide`, with
// `visibilitychange → hidden` as backup) we emit ONE rollup event:
//
//   { frameP50, frameP95, frameP99, ifcToFirstFrameMs, fragmentDecodeMs,
//     deviceTags, uidHash, samplingApplied }
//
// Three gates decide whether an event is ever emitted:
//
//   1. **Remote Config sampling** — `telemetry_sampling_pct` (0–100).
//      Default 0. A fetch failure is **fail-closed** (0 % → no events),
//      never fail-open (spec §9 risk 7).
//   2. **Opt-in** — the user setting gate (`setAnalyticsOptIn`).
//      Off ⇒ no analytics events. Crash channels (A + B) are untouched.
//   3. **Double-emit guard** — `pagehide` AND `visibilitychange` both
//      fire on a normal tab close; only the first one emits.
//
// Survivability law: every body is safe()-wrapped (async bodies use an
// explicit try/catch — `safe()` cannot catch a rejection). A Firebase
// failure logs a warn and DROPS the event; it never throws into app
// code. Nothing here touches Channels A/B.
//
// Load-time cost: ZERO. `firebase/analytics` + `firebase/remote-config`
// are loaded through dynamic `import()` *inside* async functions only —
// the module itself imports neither at load time. The `pagehide` /
// `visibilitychange` listeners are attached by `initAnalytics()`, never
// at module load.

import { safe } from "../safe";
import { deviceTags } from "../deviceTags";
import { getFrameStats } from "../frameTimer";
import type { Telemetry } from "../telemetry";
import type { AnalyticsConfig } from "../types";
import { dailySaltFor, hashUid } from "./hash";
import {
  createPerfStatsAccumulator,
  createSessionTimeline,
  type PerfStatsAccumulator,
  type SessionTimeline,
} from "./perfStats";

/** The GA4 event name used for the session rollup. */
export const ROLLUP_EVENT_NAME = "session_rollup";

/** Default Remote Config key holding the sampling percentage. */
export const DEFAULT_SAMPLING_KEY = "telemetry_sampling_pct";

/** How often the frame stats are folded into the session histogram. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** The rollup payload (spec §7 U5 DoD shape). */
export interface SessionRollupSummary {
  /** Session frame-time p50, ms. */
  frameP50: number;
  /** Session frame-time p95, ms. */
  frameP95: number;
  /** Session frame-time p99, ms. */
  frameP99: number;
  /** Load-start → first frame after load-complete, ms (null = unknown). */
  ifcToFirstFrameMs: number | null;
  /** Fragment decode duration, ms (null = unknown). */
  fragmentDecodeMs: number | null;
  /** Device segmentation tags (§5.5). */
  deviceTags: Record<string, unknown>;
  /** Hashed uid (16 hex chars) — never the raw uid. */
  uidHash: string | null;
  /** Whether this session was sampled by the RC percentage. */
  samplingApplied: boolean;
}

/** Minimal structural shape of the `firebase/analytics` module. */
export interface AnalyticsModuleLike {
  getAnalytics: (app?: unknown) => unknown;
  logEvent: (
    analytics: unknown,
    eventName: string,
    params?: Record<string, unknown>,
  ) => void;
  isSupported?: () => Promise<boolean>;
}

/** Minimal structural shape of a Remote Config `Value`. */
export interface RemoteConfigValueLike {
  asNumber?: () => number;
  asString?: () => string;
}

/** Minimal structural shape of the `firebase/remote-config` module. */
export interface RemoteConfigModuleLike {
  getRemoteConfig: (app?: unknown) => unknown;
  fetchAndActivate: (remoteConfig: unknown) => Promise<boolean>;
  getValue: (
    remoteConfig: unknown,
    key: string,
  ) => RemoteConfigValueLike;
}

/** The event target shape we need (window / document). */
export interface AnalyticsEventTargetLike {
  addEventListener(
    type: string,
    listener: (event?: unknown) => void,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event?: unknown) => void,
    options?: unknown,
  ): void;
}

/** The document shape we need (visibility state). */
export interface AnalyticsDocumentLike extends AnalyticsEventTargetLike {
  visibilityState?: string;
}

/** Injectable dependencies — the Firebase modules are lazy-loaded by
 *  default and injectable so the unit tests never need a real Firebase
 *  project. */
export interface AnalyticsDeps {
  /** Loads `firebase/analytics` (lazy, inside `initAnalytics`). */
  loadAnalytics?: () => Promise<AnalyticsModuleLike>;
  /** Loads `firebase/remote-config` (lazy, inside `initAnalytics`). */
  loadRemoteConfig?: () => Promise<RemoteConfigModuleLike>;
  /** Wall-clock source (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Sampling randomness in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
  /** Injected rAF (frame watch). Defaults to `requestAnimationFrame`. */
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  /** Injected cancel-rAF. Defaults to `cancelAnimationFrame`. */
  cancelAnimationFrame?: (id: number) => void;
  /** Injected interval. Defaults to `setInterval`. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Injected clear-interval. Defaults to `clearInterval`. */
  clearInterval?: (handle: unknown) => void;
  /** The `pagehide` target. Defaults to `window`. */
  eventTarget?: AnalyticsEventTargetLike | null;
  /** The `visibilitychange` target. Defaults to `document`. */
  visibilityTarget?: AnalyticsDocumentLike | null;
}

/** Options for `initAnalytics` (identity + injected dependencies). */
export interface AnalyticsInitOptions {
  /** The signed-in uid — hashed, never logged raw. */
  uid?: string;
  /** The Firebase app id used in the hash input. */
  appId?: string;
  /** The rotating daily salt. Defaults to today's UTC date. */
  dailySalt?: string;
  /** The telemetry instance used to read the model load breadcrumbs. */
  telemetry?: Telemetry;
  /** Injectable dependencies (tests). */
  deps?: AnalyticsDeps;
}

// --- module state ----------------------------------------------------

let initialized = false;
let optIn = false;
let samplingPct = 0;
let sessionSampled = false;
let emittedThisSession = false;

let analyticsModule: AnalyticsModuleLike | null = null;
let analyticsInstance: unknown = null;
let analyticsInstancePromise: Promise<unknown> | null = null;
let firebaseApp: unknown = null;

let uidHash: string | null = null;
let uidValue: string | null = null;
let appIdValue: string | null = null;
let dailySaltValue: string | null = null;

let telemetryInstance: Telemetry | null = null;
let deps: AnalyticsDeps = {};

const perf: PerfStatsAccumulator = createPerfStatsAccumulator();
const timeline: SessionTimeline = createSessionTimeline();

let pollHandle: unknown = null;
let rafHandle: number | null = null;
let rafStopped = true;
let listenersAttached = false;

const onPageHide = (): void => {
  void handleSessionEnd();
};

const onVisibilityChange = (): void => {
  const doc = resolveVisibilityTarget();
  if (doc && doc.visibilityState !== undefined && doc.visibilityState !== "hidden") {
    return;
  }
  void handleSessionEnd();
};

// --- helpers ---------------------------------------------------------

function warn(message: string, err?: unknown): void {
  // eslint-disable-next-line no-console
  if (err === undefined) console.warn(`[ff-telemetry] ${message}`);
  else console.warn(`[ff-telemetry] ${message}:`, err);
}

function resolveEventTarget(): AnalyticsEventTargetLike | null {
  if (deps.eventTarget !== undefined) return deps.eventTarget;
  try {
    return (globalThis as { window?: AnalyticsEventTargetLike }).window ?? null;
  } catch {
    return null;
  }
}

function resolveVisibilityTarget(): AnalyticsDocumentLike | null {
  if (deps.visibilityTarget !== undefined) return deps.visibilityTarget;
  try {
    return (globalThis as { document?: AnalyticsDocumentLike }).document ?? null;
  } catch {
    return null;
  }
}

function nowMs(): number {
  return safe(() => (deps.now ? deps.now() : Date.now()), "now failed") ?? 0;
}

function random01(): number {
  const value = safe(
    () => (deps.random ? deps.random() : Math.random()),
    "random failed",
  );
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

async function defaultLoadAnalytics(): Promise<AnalyticsModuleLike> {
  const mod = await import("firebase/analytics");
  return mod as unknown as AnalyticsModuleLike;
}

async function defaultLoadRemoteConfig(): Promise<RemoteConfigModuleLike> {
  const mod = await import("firebase/remote-config");
  return mod as unknown as RemoteConfigModuleLike;
}

/** Clamp a Remote Config value into the 0–100 sampling range. */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.floor(value);
}

/**
 * Read the sampling percentage from Remote Config.
 *
 * **Fail-closed** (spec §9 risk 7): any failure — module load, RC not
 * initialised, fetch rejected, malformed value — yields 0, i.e. no
 * events at all. Analytics never fails open.
 */
async function resolveSamplingPct(
  config: AnalyticsConfig,
): Promise<number> {
  try {
    const key =
      typeof config.samplingRemoteConfigKey === "string" &&
      config.samplingRemoteConfigKey.trim() !== ""
        ? config.samplingRemoteConfigKey.trim()
        : DEFAULT_SAMPLING_KEY;

    const loader = deps.loadRemoteConfig ?? defaultLoadRemoteConfig;
    const rcModule = await loader();

    if (typeof rcModule.getRemoteConfig !== "function") return 0;
    const remoteConfig = rcModule.getRemoteConfig(config.firebaseApp);

    if (typeof rcModule.fetchAndActivate === "function") {
      await rcModule.fetchAndActivate(remoteConfig);
    }

    if (typeof rcModule.getValue !== "function") return 0;
    const value = rcModule.getValue(remoteConfig, key);

    let raw: number | undefined;
    if (value && typeof value.asNumber === "function") {
      raw = value.asNumber();
    } else if (value && typeof value.asString === "function") {
      raw = Number(value.asString());
    }
    if (raw === undefined || !Number.isFinite(raw)) return 0;
    return clampPct(raw);
  } catch (err) {
    warn("analytics: Remote Config sampling fetch failed — fail-closed (0%)", err);
    return 0;
  }
}

/** Is this session sampled under the current percentage? */
function sampleByPct(pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return random01() * 100 < pct;
}

/** Lazily load + create the Analytics instance (memoized). */
function ensureAnalyticsInstance(): Promise<unknown> {
  if (analyticsInstancePromise) return analyticsInstancePromise;
  analyticsInstancePromise = (async () => {
    try {
      const loader = deps.loadAnalytics ?? defaultLoadAnalytics;
      const mod = await loader();
      if (typeof mod?.getAnalytics !== "function") {
        warn("analytics: firebase/analytics module shape unexpected");
        return null;
      }
      if (typeof mod.isSupported === "function") {
        let supported = false;
        try {
          supported = (await mod.isSupported()) === true;
        } catch (err) {
          warn("analytics: isSupported() failed — analytics disabled", err);
          return null;
        }
        if (!supported) {
          warn("analytics: Firebase Analytics is not supported here — disabled");
          return null;
        }
      }
      analyticsModule = mod;
      analyticsInstance = mod.getAnalytics(firebaseApp);
      return analyticsInstance;
    } catch (err) {
      warn("analytics: failed to initialise Firebase Analytics", err);
      return null;
    }
  })();
  return analyticsInstancePromise;
}

/** Feed the session histogram with the current frame stats. */
function pollFrameStats(): void {
  safe(() => {
    const stats = getFrameStats();
    perf.addFrameStats(stats);
  }, "pollFrameStats failed");
}

/** Re-read the model load breadcrumbs and feed the timeline. */
function syncTimelineFromTelemetry(): void {
  const tel = telemetryInstance;
  if (!tel) return;
  safe(() => {
    const bundle = tel.getBundle();
    for (const crumb of bundle.breadcrumbs) {
      if (crumb.category !== "model") continue;
      if (crumb.action === "load-start") {
        timeline.noteLoadStart(crumb.ts);
      } else if (crumb.action === "load-complete") {
        timeline.noteLoadComplete(crumb.ts);
      }
    }
  }, "syncTimelineFromTelemetry failed");
}

/** Start the 1 Hz poll + the frame watch (only when sampling applies). */
function startRuntime(): void {
  if (pollHandle === null) {
    const setInt =
      deps.setInterval ??
      ((cb: () => void, ms: number): unknown =>
        (globalThis as unknown as {
          setInterval: (cb: () => void, ms: number) => unknown;
        }).setInterval(cb, ms));
    pollHandle = setInt(() => {
      pollFrameStats();
      syncTimelineFromTelemetry();
    }, DEFAULT_POLL_INTERVAL_MS);
  }
  if (rafHandle === null) {
    const raf =
      deps.requestAnimationFrame ??
      ((cb: FrameRequestCallback): number => {
        if (typeof requestAnimationFrame === "function") {
          return requestAnimationFrame(cb);
        }
        return 0;
      });
    // A dedicated stop flag: a synchronously-invoked fake rAF must
    // not see `rafHandle === null` and abort the loop.
    rafStopped = false;
    const tick = (): void => {
      if (rafStopped) return;
      timeline.noteFrameTick(nowMs());
      rafHandle = raf(tick);
    };
    rafHandle = raf(tick);
  }
}

/** Stop the 1 Hz poll + the frame watch. */
function stopRuntime(): void {
  if (pollHandle !== null) {
    const clearInt =
      deps.clearInterval ??
      ((handle: unknown): void => {
        (globalThis as unknown as {
          clearInterval: (handle: unknown) => void;
        }).clearInterval(handle);
      });
    safe(() => clearInt(pollHandle), "clearInterval failed");
    pollHandle = null;
  }
  if (rafHandle !== null) {
    const cancel =
      deps.cancelAnimationFrame ??
      ((id: number): void => {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(id);
        }
      });
    const id = rafHandle;
    rafStopped = true;
    rafHandle = null;
    safe(() => cancel(id), "cancelAnimationFrame failed");
  }
}

/** Apply the gates to the runtime (poll + frame watch follow them). */
function syncRuntime(): void {
  if (initialized && optIn && samplingPct > 0) startRuntime();
  else stopRuntime();
}

function attachListeners(): void {
  if (listenersAttached) return;
  const target = resolveEventTarget();
  const doc = resolveVisibilityTarget();
  safe(() => {
    target?.addEventListener("pagehide", onPageHide);
    doc?.addEventListener("visibilitychange", onVisibilityChange);
    listenersAttached = true;
  }, "attachListeners failed");
}

function detachListeners(): void {
  if (!listenersAttached) return;
  const target = resolveEventTarget();
  const doc = resolveVisibilityTarget();
  safe(() => {
    target?.removeEventListener("pagehide", onPageHide);
    doc?.removeEventListener("visibilitychange", onVisibilityChange);
    listenersAttached = false;
  }, "detachListeners failed");
}

/** Build the rollup summary from the live session state. */
function composeSummary(): SessionRollupSummary {
  const snapshot = perf.snapshot();
  let frameP50 = snapshot.frameP50;
  let frameP95 = snapshot.frameP95;
  let frameP99 = snapshot.frameP99;

  if (snapshot.sampleCount === 0) {
    // No poll happened yet (short session) — read the live frame stats.
    const stats = safe(() => getFrameStats(), "getFrameStats failed");
    if (stats) {
      frameP50 = stats.p50;
      frameP95 = stats.p95;
      frameP99 = stats.p99;
    }
  }

  const tags = safe(() => deviceTags(), "deviceTags failed") ?? {};

  return {
    frameP50: round2(frameP50),
    frameP95: round2(frameP95),
    frameP99: round2(frameP99),
    ifcToFirstFrameMs: timeline.ifcToFirstFrameMs(),
    fragmentDecodeMs: timeline.fragmentDecodeMs(),
    deviceTags: tags,
    uidHash,
    samplingApplied: sessionSampled,
  };
}

/** The pagehide / visibilitychange handler. */
async function handleSessionEnd(): Promise<void> {
  try {
    if (!initialized) return;
    if (emittedThisSession) return; // double-emit guard
    syncTimelineFromTelemetry();
    const summary = composeSummary();
    await logSessionRollup(summary);
  } catch (err) {
    warn("analytics: session rollup failed", err);
  }
}

// --- public API ------------------------------------------------------

/**
 * Initialise Channel C (spec §4.1 / §4.3).
 *
 * - Idempotent: a second call only refreshes the opt-in flag.
 * - Fetches the Remote Config sampling percentage (fail-closed → 0).
 * - Attaches the `pagehide` / `visibilitychange` listeners.
 * - Computes the hashed uid (raw uid never leaves this function).
 * - Never throws.
 */
export async function initAnalytics(
  config: AnalyticsConfig,
  options: AnalyticsInitOptions = {},
): Promise<void> {
  try {
    if (!config || !config.firebaseApp) {
      warn("initAnalytics: no Firebase app supplied — Channel C disabled");
      return;
    }

    // Keep the injected dependencies across re-inits (a repeat call
    // must not detach the runtime from its fake rAF / targets).
    if (options.deps) deps = options.deps;
    telemetryInstance = options.telemetry ?? telemetryInstance;
    optIn = config.optIn === true;
    firebaseApp = config.firebaseApp;

    if (initialized) {
      // Idempotent: refresh the gate, keep everything else as-is.
      syncRuntime();
      return;
    }

    appIdValue =
      options.appId ??
      readStringOption(config.firebaseApp, "appId") ??
      readStringOption(config.firebaseApp, "projectId") ??
      null;
    dailySaltValue = options.dailySalt ?? dailySaltFor(nowMs());
    uidValue = options.uid ?? null;

    samplingPct = await resolveSamplingPct(config);
    sessionSampled = sampleByPct(samplingPct);

    if (uidValue) {
      uidHash = await hashUid(uidValue, appIdValue ?? "", dailySaltValue);
    } else {
      uidHash = null;
    }

    initialized = true;
    attachListeners();
    syncRuntime();

    // Preload the Analytics SDK when sampling could apply, so the
    // session-end emit does not pay the module-load cost.
    if (optIn && samplingPct > 0) {
      void ensureAnalyticsInstance();
    }
  } catch (err) {
    warn("initAnalytics failed", err);
  }
}

/** Read a string option off the structural Firebase app. */
function readStringOption(
  app: unknown,
  key: string,
): string | undefined {
  return safe(() => {
    const options = (app as { options?: Record<string, unknown> } | undefined)
      ?.options;
    const value = options?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  }, "readStringOption failed");
}

/**
 * The user opt-in gate (spec §5.6 — "this spec exposes
 * `setAnalyticsOptIn(bool)` only"). Purely local: it never touches
 * Firebase and never affects the crash channels (A + B).
 */
export function setAnalyticsOptIn(enabled: boolean): void {
  optIn = enabled === true;
  syncRuntime();
}

/** Whether the user opted in to analytics. */
export function isAnalyticsOptIn(): boolean {
  return optIn;
}

/** The current Remote Config sampling percentage (0–100). */
export function getAnalyticsSamplingPct(): number {
  return samplingPct;
}

/** The hashed uid of the current session (null when not signed in). */
export function getAnalyticsUidHash(): string | null {
  return uidHash;
}

/** Whether this session was sampled (drives `samplingApplied`). */
export function isSessionSampled(): boolean {
  return sessionSampled;
}

/** Whether a rollup was already emitted in this session. */
export function hasEmittedSessionRollup(): boolean {
  return emittedThisSession;
}

/**
 * Set (or refresh) the signed-in identity. The uid is hashed with the
 * daily salt; the raw uid is never stored in the event payload.
 */
export async function setAnalyticsIdentity(options: {
  uid?: string | null;
  appId?: string | null;
  dailySalt?: string | null;
}): Promise<void> {
  try {
    if (typeof options.appId === "string") appIdValue = options.appId;
    if (typeof options.dailySalt === "string") {
      dailySaltValue = options.dailySalt;
    }
    if (options.uid === null) {
      uidValue = null;
      uidHash = null;
      return;
    }
    if (typeof options.uid === "string") {
      uidValue = options.uid;
      uidHash = await hashUid(
        uidValue,
        appIdValue ?? "",
        dailySaltValue ?? dailySaltFor(nowMs()),
      );
    }
  } catch (err) {
    warn("setAnalyticsIdentity failed", err);
  }
}

/**
 * Re-fetch the Remote Config sampling percentage (fail-closed) and
 * re-decide the session's sampling. Use it after a ramp-up.
 */
export async function refreshAnalyticsSamplingPct(
  config?: AnalyticsConfig,
): Promise<number> {
  try {
    if (!config) return samplingPct;
    samplingPct = await resolveSamplingPct(config);
    sessionSampled = sampleByPct(samplingPct);
    syncRuntime();
    return samplingPct;
  } catch (err) {
    warn("refreshAnalyticsSamplingPct failed", err);
    return 0;
  }
}

/**
 * Build the session rollup summary from the live session state.
 * Exposed so the seam can emit a rollup at a custom moment.
 */
export function buildSessionRollup(
  partial: Partial<SessionRollupSummary> = {},
): SessionRollupSummary {
  const base = safe(composeSummary, "composeSummary failed");
  const summary: SessionRollupSummary = base ?? {
    frameP50: 0,
    frameP95: 0,
    frameP99: 0,
    ifcToFirstFrameMs: null,
    fragmentDecodeMs: null,
    deviceTags: {},
    uidHash: null,
    samplingApplied: sessionSampled,
  };
  return { ...summary, ...partial };
}

/**
 * Compact the device tags into a single GA4-safe string.
 * GA4 caps string parameter values at 100 characters, so the tags are
 * added in priority order until the JSON no longer fits.
 */
export function compactDeviceTags(
  tags: Record<string, unknown>,
  maxLength = 100,
): string {
  const priority = [
    "gpu",
    "renderer_type",
    "webgl2",
    "deviceMemory",
    "hardwareConcurrency",
    "maxTextureSize",
    "screen",
  ];
  const out: Record<string, unknown> = {};
  for (const key of priority) {
    const value = tags?.[key];
    if (value === undefined || value === null) continue;
    const candidate = { ...out, [key]: value };
    const json = JSON.stringify(candidate);
    if (json.length > maxLength) break;
    out[key] = value;
  }
  return JSON.stringify(out);
}

/**
 * Map the rollup summary onto GA4 event parameters.
 *
 * `null` metrics are omitted (GA4 has no null parameter) and the device
 * tags are compacted to respect GA4's 100-char string limit.
 */
export function buildRollupEventParams(
  summary: SessionRollupSummary,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  params.frame_p50 = round2(summary.frameP50);
  params.frame_p95 = round2(summary.frameP95);
  params.frame_p99 = round2(summary.frameP99);
  if (
    typeof summary.ifcToFirstFrameMs === "number" &&
    Number.isFinite(summary.ifcToFirstFrameMs)
  ) {
    params.ifc_to_first_frame_ms = round2(summary.ifcToFirstFrameMs);
  }
  if (
    typeof summary.fragmentDecodeMs === "number" &&
    Number.isFinite(summary.fragmentDecodeMs)
  ) {
    params.fragment_decode_ms = round2(summary.fragmentDecodeMs);
  }
  params.device_tags = compactDeviceTags(summary.deviceTags ?? {});
  params.uid_hash = summary.uidHash ?? "";
  params.sampling_applied = summary.samplingApplied ? 1 : 0;
  return params;
}

/**
 * Emit the session rollup (one per session).
 *
 * The gates — opt-in, RC sampling percentage, the per-session
 * double-emit guard — are applied here, so a manual call can never
 * bypass them. Never throws; a Firebase failure logs a warn and drops
 * the event.
 */
export async function logSessionRollup(
  summary: SessionRollupSummary,
): Promise<void> {
  try {
    if (!initialized) {
      warn("logSessionRollup: analytics not initialised — event dropped");
      return;
    }
    if (!optIn) return; // user opt-out — no analytics events
    if (samplingPct <= 0) return; // RC gate, fail-closed
    if (!summary || summary.samplingApplied !== true) return;
    if (emittedThisSession) return; // double-emit guard

    // Set the guard BEFORE the await so `pagehide` + `visibilitychange`
    // can never both emit.
    emittedThisSession = true;

    const instance = await ensureAnalyticsInstance();
    if (instance === null || analyticsModule === null) return;

    const params = buildRollupEventParams(summary);
    analyticsModule.logEvent(instance, ROLLUP_EVENT_NAME, params);
  } catch (err) {
    warn("logSessionRollup failed — event dropped", err);
  }
}

/** Feed the session histogram with an explicit frame reading (seam). */
export function recordFrameStats(
  stats?: {
    p50: number;
    p95: number;
    p99: number;
    frameEmaMs?: number;
    frameMaxMs?: number;
  },
): void {
  safe(() => {
    const reading = stats ?? getFrameStats();
    perf.addFrameStats(reading);
  }, "recordFrameStats failed");
}

/** Note a rendered frame in the session timeline (seam). */
export function recordFrameTick(ts?: number): void {
  safe(() => timeline.noteFrameTick(ts ?? nowMs()), "recordFrameTick failed");
}

/** Note a model load-start in the session timeline (seam). */
export function noteModelLoadStart(ts?: number): void {
  safe(() => timeline.noteLoadStart(ts ?? nowMs()), "noteModelLoadStart failed");
}

/** Note a model load-complete in the session timeline (seam). */
export function noteModelLoadComplete(ts?: number): void {
  safe(
    () => timeline.noteLoadComplete(ts ?? nowMs()),
    "noteModelLoadComplete failed",
  );
}

/** Note a measured web-ifc worker span (ms) — overrides the proxy. */
export function noteFragmentDecodeSpan(ms: number): void {
  safe(() => timeline.noteWorkerSpanMs(ms), "noteFragmentDecodeSpan failed");
}

/** Stop the analytics runtime (listeners + timers). */
export function stopAnalytics(): void {
  detachListeners();
  stopRuntime();
}

/**
 * Reset every module-level flag. Test helper — also used when the
 * host app re-initialises telemetry for a new session.
 */
export function resetAnalyticsForTests(): void {
  detachListeners();
  stopRuntime();
  initialized = false;
  optIn = false;
  samplingPct = 0;
  sessionSampled = false;
  emittedThisSession = false;
  analyticsModule = null;
  analyticsInstance = null;
  analyticsInstancePromise = null;
  firebaseApp = null;
  uidHash = null;
  uidValue = null;
  appIdValue = null;
  dailySaltValue = null;
  telemetryInstance = null;
  deps = {};
  perf.reset();
  timeline.reset();
}
