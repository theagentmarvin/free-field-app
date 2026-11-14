// Wave 18 U7 (spec §4.1/§6 row Mount): the app shell fires
// `initTelemetry(cfg)` EXACTLY ONCE — never the viewer (the viewer
// only calls ensureViewerTelemetry(), which registers the singleton
// this init mirrors into). Everything here is fire-and-forget and
// safe()-guarded inside the package: telemetry can never block or
// break first paint (§9.8 cold-start rule).
//
// No Sentry DSN exists in any committed env: `VITE_SENTRY_DSN` absent
// → Channel A stays its documented no-op-with-warn local-only path,
// byte-identical v1 behaviour. The value is a SecretRef placeholder
// in .env.example only — never real secret values in the repo (§8).

import {
  initTelemetry,
  bootPostMortem,
  startRouteCrumbs,
  requestPersistentStorage,
  setAnalyticsOptIn,
  getGlobalTelemetry,
} from "@ff/telemetry";

/** Analytics opt-in storage key. The UI toggle ships in a later wave
 *  (§5.6: "this spec exposes setAnalyticsOptIn(bool) only") — until
 *  then the persisted key stays absent → opt-in FALSE → Channel C
 *  silent, crash channels (A+B) unaffected either way. */
const ANALYTICS_OPT_IN_KEY = "ff.analytics.optIn";

export function bootTelemetry(): void {
  // Channel A + storage adapter. Idempotent, never rejects visibly
  // (initTelemetry + bootPostMortem are safe()/try-catch internally).
  const env = import.meta.env as unknown as Record<string, string | boolean | undefined>;
  const dsn = typeof env.VITE_SENTRY_DSN === "string" ? env.VITE_SENTRY_DSN : "";
  void initTelemetry({
    ...(dsn !== ""
      ? {
          sentry: {
            dsn,
            environment: env.PROD === true ? ("production" as const) : ("development" as const),
            ...(typeof env.VITE_SENTRY_RELEASE === "string"
              ? { release: env.VITE_SENTRY_RELEASE }
              : {}),
          },
        }
      : {}),
    storage: "indexeddb", // §5.3: bundle+watermarks ride IDB, localStorage fallback
  }).then(() => {
    // stale-boot-flag forensics (§4.3): ships last-run bundle + renderer
    // report as an error-level captureMessage ONCE, clears on ack.
    void bootPostMortem();
  });

  // §5.2 best-effort persistent-storage grant for ff-forensics.
  void requestPersistentStorage();

  // §6 row Router navigation: ONE history listener, pathname-only
  // crumbs, zero cost until the viewer singleton exists (lazy).
  startRouteCrumbs({ getTelemetry: () => getGlobalTelemetry() });

  // §5.6 Channel C gate (off until a persisted opt-in exists).
  try {
    setAnalyticsOptIn(window.localStorage.getItem(ANALYTICS_OPT_IN_KEY) === "true");
  } catch {
    setAnalyticsOptIn(false); // private mode → opt-out is the safe default
  }
}
