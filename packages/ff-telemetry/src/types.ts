// Shared structural types for the three-channel field telemetry
// config (Wave 18). This file defines the public `TelemetryConfig`
// surface once so later units (U4 storage, U5 analytics) can slot in
// without re-declaring shapes here.
//
// Survivability law: these are structural types only — no runtime
// imports, no `three`, no DOM reads at module load. All heavy deps
// (Sentry, Firebase) are lazy-imported inside `initTelemetry`.

/** Channel A (Sentry) replay options. P4 — error-driven replay only. */
export interface SentryReplayConfig {
  enabled: boolean;
  errorSampleRate: number;
}

/** Channel A (Sentry) init options. */
export interface SentryConfig {
  dsn: string;
  environment: "production" | "development";
  release?: string;
  sampleRate?: number;
  replay?: SentryReplayConfig;
}

/**
 * Structural stand-in for a Firebase `App` — `ff-telemetry` never
 * imports `firebase`. Only the minimal shape Channel C (U5) needs.
 */
export interface FirebaseAppLike {
  name?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Channel C (Firebase Analytics) init options. Wired in U5. */
export interface AnalyticsConfig {
  firebaseApp: FirebaseAppLike;
  samplingRemoteConfigKey: string;
  optIn: boolean;
}

/** Scope identity tags (mirrored onto Sentry scope in U1). */
export interface IdentityConfig {
  uidHash?: string;
  projectHash?: string;
}

/** Post-mortem storage selection (U4). "local" keeps the v1 path. */
export type StorageKind = "local" | "indexeddb";

/** The three-channel init config (spec §4.1). */
export interface TelemetryConfig {
  sentry?: SentryConfig;
  analytics?: AnalyticsConfig;
  storage?: StorageKind;
  identity?: IdentityConfig;
  /** Integration seam (U7): register the module singleton (§4.3) at
   *  init so the breadcrumb bridge, escalation sinks, the post-mortem
   *  and the Channel-A renderer report resolve the SAME instance. */
  telemetry?: import("./telemetry").Telemetry;
}