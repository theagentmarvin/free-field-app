// @ff/telemetry — local, zero-dependency viewer crash forensics +
// performance breadcrumbs (ring-buffer state history + launch-crash
// detection). No React, no DOM at module load, no `three` import.
//
// v1 deliberately trims a 7-part design to its two crown
// jewels: the ring-buffer state history attached to errors, and
// launch-crash detection. No Sentry, no analytics, no session replay,
// no network endpoint — everything stays on the device (console /
// localStorage / clipboard).
//
// Wave 18 grows it into a three-channel architecture, adapted to
// web. `initTelemetry` (spec §4.1) is the public entry: it wires
// Channel A (Sentry, lazy-loaded) plus identity + device scope tags.
// Channel B (renderer diagnostics) and Channel C (analytics) slot in
// behind the same config object in later units.
//
// Survivability law: no exported function may ever throw into app
// code. Every body is wrapped in `safe()` (or an explicit try/catch
// for async work) and logs a warn on internal failure. Storage goes
// through an injected getItem/setItem so jsdom tests never touch a
// real DOM storage.

export { RingBuffer } from "./ringBuffer";
export {
  createTelemetry,
  type Telemetry,
  type TelemetryOptions,
  type TelemetryBundle,
  type Breadcrumb,
  type Snapshot,
} from "./telemetry";
export { deviceTags } from "./deviceTags";
export {
  installBootFlag,
  persist,
  localStorageStorage,
  resetPersistThrottle,
  BOOT_FLAG_KEY,
  BUNDLE_KEY,
  PERSIST_THROTTLE_MS,
  type TelemetryStorage,
} from "./boot";
export {
  installErrorListeners,
  attachChannelAErrorBridge,
  setErrorReporter,
  getErrorReporter,
  type ErrorListenerOptions,
  type ErrorReporter,
} from "./errorListeners";
export {
  startRendererSampler,
  OOM_GEOMETRY_THRESHOLD,
  OOM_TEXTURE_THRESHOLD,
  OOM_HEAP_RATIO_THRESHOLD,
  type RendererRead,
  type RendererSamplerOptions,
} from "./sampler";
export { attachWindowHooks, type WindowTelemetryApi } from "./windowHooks";
export { safe } from "./safe";

// --- Wave 18 U2: frame timer + per-model renderer ring buffers ----

export {
  startFrameTimer,
  getFrameStats,
  type FrameStats,
  type FrameTimerOptions,
} from "./frameTimer";
export {
  createModelBuffers,
  getRendererReport,
  type RendererInfoLike,
  type ModelBuffers,
  type RendererReportInput,
} from "./modelBuffers";
// --- Wave 18 U3: context-loss events + escalation --------------------

export {
  attachContextEvents,
  CONTEXT_FLAPPING_REASON,
  CONTEXT_LOSS_ESCALATION_THRESHOLD,
  CONTEXT_LOST_EVENT,
  CONTEXT_RESTORED_ALIAS_EVENT,
  CONTEXT_RESTORED_EVENT,
  type ContextEscalationExtra,
  type ContextEscalationHandler,
  type ContextEventTarget,
  type ContextEventTelemetry,
  type ContextEventsDeps,
  type ContextListenerOptions,
} from "./contextEvents";

// --- Wave 18 U1: three-channel init + Channel A (Sentry) ------------

export type {
  TelemetryConfig,
  SentryConfig,
  SentryReplayConfig,
  AnalyticsConfig,
  IdentityConfig,
  StorageKind,
  FirebaseAppLike,
} from "./types";

export {
  initSentry,
} from "./sentry/index";
export {
  attachSentryBreadcrumbBridge,
  setSentryBreadcrumbSink,
  type SentryBreadcrumbSink,
} from "./sentry/breadcrumbs";
export {
  shouldDropEvent,
  scrubEvent,
  scrubBreadcrumb,
  scrubData,
  createRateLimiter,
  type IgnorableEvent,
  type IgnorableEventValue,
  type IgnorableBreadcrumb,
  type IgnoreFilterOptions,
  type RateLimiter,
} from "./sentry/ignoreFilter";

import { initSentry } from "./sentry/index";
import { startChannelA } from "./channelA";
import {
  setGlobalTelemetry,
  getGlobalTelemetry,
  setTelemetryStorageKind,
} from "./singleton";
import { initAnalytics } from "./analytics/index";
import type { TelemetryConfig } from "./types";

/**
 * Initialise field telemetry (spec §4.1) — all three channels.
 *
 *  - Channel A: `initSentry` (lazy SDK) + the U7 extension surface
 *    (`startChannelA`: report-on-every-event, error reporter, message
 *    capture). No-ops with a `console.warn` when `config.sentry` is
 *    absent or its DSN is empty — dev/offline builds stay local-only.
 *  - Channel B: the storage-kind selection (U4's IndexedDB persist
 *    adapter) is applied here from `config.storage`.
 *  - Channel C: `config.analytics` is forwarded to `initAnalytics`
 *    (fire-and-forget; the analytics module is lazy internally and
 *    fail-closed on Remote-Config fetch failure, spec §9.7).
 *  - `config.telemetry` (integration seam): registers the module
 *    singleton (§4.3 `getTelemetry()`) so the breadcrumb bridge,
 *    escalation sinks, the post-mortem and the Channel-A report
 *    attachment all resolve the SAME instance.
 *
 * Idempotent; never throws (every leg is safe()-guarded by its own
 * module; the async legs catch their own rejections).
 */
export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  if (config?.telemetry) setGlobalTelemetry(config.telemetry);
  if (config?.storage) setTelemetryStorageKind(config.storage);
  await initSentry(config, config.telemetry ?? getGlobalTelemetry() ?? undefined);
  if (config?.sentry?.dsn && config.sentry.dsn.trim() !== "") {
    // U7 wiring: without this the Channel-A capture surface
    // (attachments, error reporter, message capture) never activates.
    await startChannelA();
  }
  if (config?.analytics) {
    void initAnalytics(
      config.analytics,
      { telemetry: config.telemetry ?? getGlobalTelemetry() ?? undefined },
    );
  }
}

// --- Wave 18 U4: IndexedDB persist + launch-crash post-mortem --------

export {
  openForensicsStore,
  requestPersistentStorage,
  FORENSICS_DB_NAME,
  FORENSICS_STORE_NAME,
  FORENSICS_DB_VERSION,
  BUNDLE_IDB_KEY,
  type IdbStore,
  type IdbFactoryLike,
  type IdbPutCallback,
  type ForensicsStoreOptions,
} from "./postMortem/idbStore";
export {
  runPostMortem,
  readBundleFromStorage,
  clearBundleFromStorage,
  createPostMortemDeps,
  buildRendererReportFromBundle,
  type PostMortemReporter,
  type PostMortemDeps,
} from "./postMortem/forensics";
export {
  persistBundleToStorage,
  createBundleIdbStorage,
  truncateBundleToFit,
  utf8ByteLength,
  resetIdbPersistThrottle,
  MAX_BUNDLE_BYTES,
  type BundleStorage,
  type PersistedBundle,
} from "./boot";

// --- Wave 18 U5: Channel C — Firebase Analytics session rollups -------
//
// The Analytics SDK + Remote Config are lazy-loaded inside
// `initAnalytics` (never at module load), so the v1 local-only path
// keeps its zero-load-cost guarantee. `initTelemetry` above is NOT
// changed by this unit — wiring `config.analytics` into it is the
// Architect integration step (spec §7 U5).

export {
  initAnalytics,
  setAnalyticsOptIn,
  isAnalyticsOptIn,
  getAnalyticsSamplingPct,
  getAnalyticsUidHash,
  isSessionSampled,
  hasEmittedSessionRollup,
  setAnalyticsIdentity,
  refreshAnalyticsSamplingPct,
  buildSessionRollup,
  buildRollupEventParams,
  compactDeviceTags,
  logSessionRollup,
  recordFrameStats,
  recordFrameTick,
  noteModelLoadStart,
  noteModelLoadComplete,
  noteFragmentDecodeSpan,
  stopAnalytics,
  resetAnalyticsForTests,
  ROLLUP_EVENT_NAME,
  DEFAULT_SAMPLING_KEY,
  type SessionRollupSummary,
  type AnalyticsModuleLike,
  type RemoteConfigModuleLike,
  type RemoteConfigValueLike,
  type AnalyticsDeps,
  type AnalyticsInitOptions,
  type AnalyticsEventTargetLike,
  type AnalyticsDocumentLike,
} from "./analytics/index";

export {
  hashUid,
  sha256Hex,
  sha256HexAsync,
  hasWebCryptoSubtle,
  buildUidHashInput,
  dailySaltFor,
  utf8Bytes,
  UID_HASH_LENGTH,
} from "./analytics/hash";

export {
  createPerfStatsAccumulator,
  createSessionTimeline,
  percentileFromHistogram,
  bucketIndexFor,
  bucketLabels,
  DEFAULT_BUCKET_EDGES,
  type FramePercentiles,
  type PerfSample,
  type PerfStatsSnapshot,
  type PerfStatsAccumulator,
  type FrameStatsLike,
  type SessionTimeline,
} from "./analytics/perfStats";

// --- Wave 18 U6: route breadcrumb source ----------------------------
//
// Router navigation crumbs are produced HERE, in the telemetry
// package — one popstate listener plus a history.pushState /
// replaceState monkey-patch (spec §6: "never per-route edits"). The
// ff-tasks half of U6 (the outbox transition observer) lives in
// `@ff/tasks` and is wired by the app shell in U7.

export {
  startRouteCrumbs,
  routePathname,
  ROUTE_BREADCRUMB_CATEGORY,
  type RouteCrumbsTelemetry,
  type RouteCrumbsLocation,
  type RouteCrumbsHistory,
  type RouteCrumbsWindow,
  type RouteCrumbsSource,
  type RouteCrumbsDeps,
} from "./routeCrumbs";

// --- Wave 18 U7: integration surface (Architect-owned) --------------
//
// The module singleton accessor (§4.3) + the Channel-A capture surface
// that the viewer seam and app shell wire escalation, post-mortem and
// identity through. Additive tail block; nothing above changes.

export {
  setGlobalTelemetry,
  getGlobalTelemetry,
  setTelemetryStorageKind,
  getTelemetryStorageKind,
} from "./singleton";

export {
  channelAIsLive,
  buildRendererReport,
  startChannelA,
  captureTelemetryMessage,
  setTelemetryIdentity,
  bootPostMortem,
  resetChannelAForTests,
} from "./channelA";
