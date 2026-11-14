// breadcrumbs.ts — Telemetry → Sentry breadcrumb bridge.
//
// `telemetry.breadcrumb(...)` results are mirrored into
// `Sentry.addBreadcrumb(...)` for every category the viewer emits
// (model / section / viewpoint / route / outbox / session / context /
// perf / fetch). The bridge is non-invasive: it wraps the instance's
// public `breadcrumb` method (the only seam available today), so it
// works without extending `telemetry.ts`. When Sentry isn't installed
// (no DSN), the sink resolves to null and the wrap is a cheap no-op.
//
// Survivability law: every mirroring call is `safe()`-wrapped; the
// original breadcrumb write always runs first and is never affected.

import { safe } from "../safe";
import type { Telemetry } from "../telemetry";
import { scrubBreadcrumb } from "./ignoreFilter";

/** A `Sentry.addBreadcrumb`-shaped sink (structural — no import). */
export interface SentryBreadcrumbSink {
  addBreadcrumb(breadcrumb: {
    type?: string;
    category?: string;
    message?: string;
    data?: Record<string, unknown>;
  }): void;
}

type BreadcrumbFn = (
  category: string,
  action: string,
  data?: Record<string, unknown>,
) => void;

/** The currently-installed sink (set by `initSentry` after init). */
let activeSink: SentryBreadcrumbSink | null = null;

/** Set (or clear) the active Sentry sink. Internal — used by init. */
export function setSentryBreadcrumbSink(sink: SentryBreadcrumbSink | null): void {
  safe(() => {
    activeSink = sink;
  }, "setSentryBreadcrumbSink failed");
}

/**
 * Attach the Sentry breadcrumb bridge to a telemetry instance.
 *
 * `sink` may be passed explicitly (tests) or omitted — in which case
 * the bridge lazily resolves the sink installed by `initSentry`, so it
 * works whether the bridge is attached before or after init. Returns a
 * detach function that restores the original method.
 */
export function attachSentryBreadcrumbBridge(
  telemetry: Telemetry,
  sink?: SentryBreadcrumbSink | null,
): () => void {
  return safe(() => {
    const original = telemetry.breadcrumb.bind(telemetry);
    const given = sink ?? null;

    const wrapped: BreadcrumbFn = (category, action, data) => {
      // Original write first — the ring buffer is always updated.
      safe(() => original(category, action, data), "bridge: original breadcrumb failed");
      // Mirror to Sentry (best-effort; never affects the ring).
      safe(() => {
        const target = given ?? activeSink;
        if (!target) return;
        const crumb = scrubBreadcrumb({
          category: String(category),
          message: String(action),
          data,
        });
        if (crumb) target.addBreadcrumb(crumb);
      }, "bridge: sentry mirror failed");
    };

    telemetry.breadcrumb = wrapped;

    return () => {
      safe(() => {
        if (telemetry.breadcrumb === wrapped) {
          telemetry.breadcrumb = original;
        }
      }, "bridge: detach failed");
    };
  }, "attachSentryBreadcrumbBridge failed") ?? (() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
}