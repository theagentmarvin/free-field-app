// sentry/index.ts — Channel A (Sentry browser SDK) core.
//
// `initSentry()` lazy-imports `@sentry/browser` inside the function so
// the v1 local-only path keeps zero load-time cost, stays idempotent,
// and no-ops with a `console.warn` when no DSN is configured. It wires:
//   - `beforeSend`  → ignore-filter noise drop + PII scrub (§5.1/§5.6)
//   - `beforeBreadcrumb` → PII scrub
//   - scope tags    → user_hash / project_hash + device segmentation
//     (§4.1, mirroring CrashReporting.SetUserHash/SetProjectID)
//
// Survivability law: the whole async body is wrapped in try/catch so a
// failed dynamic import or a Sentry hiccup can never throw into app
// code. `safe()` cannot catch async rejections, so the async path uses
// an explicit try/catch — the same "never throw" contract.

import type {
  Breadcrumb,
  ErrorEvent,
  EventHint,
} from "@sentry/browser";
import { safe } from "../safe";
import { deviceTags } from "../deviceTags";
import type { Telemetry } from "../telemetry";
import type { TelemetryConfig } from "../types";
import {
  attachSentryBreadcrumbBridge,
  setSentryBreadcrumbSink,
  type SentryBreadcrumbSink,
} from "./breadcrumbs";
import {
  createRateLimiter,
  shouldDropEvent,
  scrubEvent,
  scrubBreadcrumb,
  type IgnorableEvent,
  type IgnorableBreadcrumb,
} from "./ignoreFilter";

/** The dynamic-import module shape (typing only; never statically loaded). */
type SentryModule = typeof import("@sentry/browser");

let initialized = false;
const eventRateLimiter = createRateLimiter(3);

/** `navigator.onLine`, defaulting to online when the API is absent. */
function readOnline(): boolean {
  try {
    return typeof navigator === "undefined" ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

/** Set a scope tag only when `value` is a non-empty primitive (never PII). */
function setTagSafely(module: SentryModule, key: string, value: unknown): void {
  safe(() => {
    if (value === undefined || value === null || value === "") return;
    module.setTag(key, String(value));
  }, `setTag ${key} failed`);
}

/** Mirror identity + device segmentation onto the Sentry scope (§4.1). */
function applyScopeTags(
  module: SentryModule,
  config: TelemetryConfig,
  tags: Record<string, unknown>,
): void {
  setTagSafely(module, "user_hash", config.identity?.uidHash);
  setTagSafely(module, "project_hash", config.identity?.projectHash);
  setTagSafely(module, "device_gpu", tags.gpu);
  setTagSafely(module, "device_memory_gb", tags.deviceMemory);
  setTagSafely(module, "cpu_cores", tags.hardwareConcurrency);
  setTagSafely(module, "webgl2", tags.webgl2);
}

/**
 * Initialise Channel A. Idempotent; no-op with a warn when
 * `config.sentry` is absent or its `dsn` is empty. When a `telemetry`
 * instance is supplied, the breadcrumb bridge is attached to it
 * (otherwise the bridge remains available via `attachSentryBreadcrumbBridge`
 * for the viewer seam to wire in U7).
 */
export async function initSentry(
  config: TelemetryConfig,
  telemetry?: Telemetry,
): Promise<void> {
  try {
    const sentry = config?.sentry;
    if (!sentry || !sentry.dsn || sentry.dsn.trim() === "") {
      // eslint-disable-next-line no-console
      console.warn(
        "[ff-telemetry] initTelemetry: no Sentry DSN configured — Channel A disabled (local-only).",
      );
      return;
    }
    if (initialized) return;

    const SentryMod = await import("@sentry/browser");

    const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
      const result = safe(() => {
        const drop = shouldDropEvent(event as unknown as IgnorableEvent, {
          online: readOnline(),
          now: () => Date.now(),
          rateLimiter: eventRateLimiter,
        });
        if (drop) return null;
        return scrubEvent(event as unknown as IgnorableEvent) as unknown as ErrorEvent;
      }, "beforeSend failed");
      // Fail-open: on our own bug, send the event unchanged rather than
      // silently dropping crash forensics.
      return result === undefined ? event : result;
    };

    const beforeBreadcrumb = (
      breadcrumb: Breadcrumb,
      _hint?: unknown,
    ): Breadcrumb | null => {
      const result = safe(
        () =>
          scrubBreadcrumb(breadcrumb as unknown as IgnorableBreadcrumb) as unknown as Breadcrumb | null,
        "beforeBreadcrumb failed",
      );
      // Fail-open: keep the original crumb if scrubbing itself breaks.
      return result === undefined ? breadcrumb : result;
    };

    SentryMod.init({
      dsn: sentry.dsn,
      environment: sentry.environment,
      ...(sentry.release !== undefined ? { release: sentry.release } : {}),
      ...(sentry.sampleRate !== undefined ? { sampleRate: sentry.sampleRate } : {}),
      beforeSend,
      beforeBreadcrumb,
    });

    const sink: SentryBreadcrumbSink = {
      addBreadcrumb(crumb) {
        safe(
          () => SentryMod.addBreadcrumb(crumb as Breadcrumb),
          "Sentry.addBreadcrumb failed",
        );
      },
    };
    setSentryBreadcrumbSink(sink);

    applyScopeTags(
      SentryMod,
      config,
      safe(() => deviceTags(), "deviceTags failed") ?? {},
    );

    if (telemetry) attachSentryBreadcrumbBridge(telemetry, sink);

    initialized = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ff-telemetry] initSentry failed:", err);
  }
}

/** Test/support helper: reset module-level init state between tests. */
export function resetSentryForTests(): void {
  initialized = false;
  setSentryBreadcrumbSink(null);
}