// singleton.ts — module-level Telemetry registry (spec §4.3:
// `getTelemetry(): Telemetry` module singleton accessor) + the §4.1
// storage-kind selection (`config.storage` → persist adapter switch).
//
// Wave 18 units each stayed write-scope-tight and nobody shipped this
// accessor (U6's routeCrumbs therefore accepts a lazy `getTelemetry`
// accessor; U4 kept v1's localStorage persist as the default). The
// seam registers its instance here the moment it is created, so late
// consumers (route crumbs, escalation sinks, post-mortem reporters,
// Channel-A report attachments) resolve the SAME singleton without
// importing the viewer package.
//
// Survivability law: safe()-wrapped; never throws, never holds DOM.

import { safe } from "./safe";
import type { Telemetry } from "./telemetry";
import type { StorageKind } from "./types";

let globalTelemetry: Telemetry | null = null;
let storageKind: StorageKind = "local";

/** Register (or clear, with `null`) the module singleton. Idempotent. */
export function setGlobalTelemetry(telemetry: Telemetry | null): void {
  safe(() => {
    globalTelemetry = telemetry;
  }, "setGlobalTelemetry failed");
}

/** The registered singleton — `null` until the app/seam initializes. */
export function getGlobalTelemetry(): Telemetry | null {
  return safe(() => globalTelemetry, "getGlobalTelemetry failed") ?? null;
}

/**
 * Select the bundle-persist adapter (§4.1 `config.storage`). 'local'
 * (default) keeps the v1 localStorage path untouched; 'indexeddb'
 * mirrors bundle+watermarks into the `ff-forensics` DB (U4) — the
 * quota-exceeded localStorage fallback is baked into
 * `persistBundleToStorage`, so the switch can never lose data.
 */
export function setTelemetryStorageKind(kind: StorageKind): void {
  safe(() => {
    if (kind === "indexeddb" || kind === "local") storageKind = kind;
  }, "setTelemetryStorageKind failed");
}

/** The active bundle-persist adapter selection. */
export function getTelemetryStorageKind(): StorageKind {
  return safe(() => storageKind, "getTelemetryStorageKind failed") ?? "local";
}
