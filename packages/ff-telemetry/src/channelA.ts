// channelA.ts — Channel-A extension surface (Wave 18 U7, Architect
// integration).
//
// U1's `initSentry` owns SDK init + beforeSend/beforeBreadcrumb; this
// module layers on the integration-only pieces the seam and the app
// shell need AFTER a successful init:
//
//   - the renderer-diagnostics report on EVERY event (§5.2). U1's
//     `scrubEvent` truncates every >200-char string in `extra`/`data`,
//     so the report rides in `event.contexts.ff_renderer_report`
//     (contexts are NOT scrubbed — the web idiom of SetExtra
//     slot) via an addEventProcessor, and as a real hint attachment
//     file on every capture call we own;
//   - the U3 error-reporter hook (uncaught errors → captureException
//     with the renderer report attached);
//   - `captureTelemetryMessage` — escalation (§4.3
//     webgl-context-flapping) and post-mortem (§4.3
//     launch-crash-last-run) uploads through `captureEvent` (the typed
//     home of EventHint.attachments);
//   - `setTelemetryIdentity` — §6 AuthProvider-path uid/project tag
//     flip (hashes only — crash channels stay PII-free, §9.5).
//
// Everything is live-gated: when Channel A never started (no DSN),
// every export is an inert no-op and the SDK module is never resolved.
// Survivability law: `safe()` everywhere; async paths use explicit
// try/catch (safe() cannot catch rejections).

import { safe } from "./safe";
import { getGlobalTelemetry } from "./singleton";
import { setErrorReporter } from "./errorListeners";

type SentryLike = typeof import("@sentry/browser");
type CaptureAttachment = { filename: string; data: string };

let mod: SentryLike | null = null;
let live = false;

/** Size guard for the report shipped per event (the ring content is
 *  already capped; this is the belt-and-braces ceiling). */
const MAX_REPORT_CHARS = 64_000;

/** True when Channel A is live (DSN configured + init succeeded). */
export function channelAIsLive(): boolean {
  return safe(() => live, "channelAIsLive failed") ?? false;
}

/** The renderer-diagnostics report of the global telemetry singleton
 *  ("" when nothing is registered). */
export function buildRendererReport(): string {
  const report = safe(
    () => getGlobalTelemetry()?.getRendererReport() ?? "",
    "buildRendererReport failed",
  );
  return typeof report === "string" ? report.slice(0, MAX_REPORT_CHARS) : "";
}

/** `event.contexts` entry carrying the report — survives U1's scrub
 *  (which only touches extra/data/breadcrumbs). */
function reportContext(): Record<string, Record<string, unknown>> {
  const report = buildRendererReport();
  return report === ""
    ? {}
    : { ff_renderer_report: { chars: report.length, report } };
}

/** `hint.attachments` entries for the events we capture ourselves. */
function reportAttachments(extra?: CaptureAttachment[]): CaptureAttachment[] {
  const report = buildRendererReport();
  const own: CaptureAttachment[] =
    report === "" ? [] : [{ filename: "ff-renderer-report.txt", data: report }];
  return extra ? [...own, ...extra] : own;
}

/**
 * Mark Channel A live + install the extension surface. Called by
 * `initTelemetry` only when `config.sentry.dsn` was present and
 * `initSentry` resolved. Idempotent; never throws.
 */
export async function startChannelA(): Promise<void> {
  try {
    if (live && mod !== null) return;
    const m = await import("@sentry/browser");
    mod = m;

    // Report on EVERY event (incl. SDK auto-captured ones) via an
    // event processor writing to `contexts` — never `extra`, which
    // U1's 200-char scrub would gut.
    safe(() => {
      m.addEventProcessor((event) => {
        const contexts = safe(
          () => ({ ...(event.contexts ?? {}), ...reportContext() }),
          "event processor contexts failed",
        );
        if (contexts) event.contexts = contexts;
        return event;
      });
    }, "addEventProcessor failed");

    // U3 hook: route uncaught exceptions through captureException with
    // the renderer report attached. Local `extra` detail already lives
    // in the ring buffer (errorListeners keeps writing it there).
    safe(() => {
      setErrorReporter({
        captureException(error: unknown) {
          safe(() => {
            const mm = mod;
            if (!live || !mm) return;
            mm.captureException(error, { attachments: reportAttachments() });
          }, "captureTelemetryException failed");
        },
      });
    }, "error reporter wiring failed");

    live = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ff-telemetry] startChannelA failed:", err);
  }
}

/** Test/support helper: full teardown of the extension surface. */
export function resetChannelAForTests(): void {
  safe(() => setErrorReporter(null), "clear error reporter failed");
  live = false;
  mod = null;
}

/**
 * Capture a telemetry-driven message event (§4.3:
 * webgl-context-flapping escalation at level warning;
 * launch-crash-last-run post-mortem at level error with the bundle
 * attached). Routed through `captureEvent` so `EventHint.attachments`
 * is the payload home. No-ops when Channel A is not live. Returns the
 * event id ("" when nothing was sent) so callers (post-mortem ack) can
 * tell delivery apart.
 */
export function captureTelemetryMessage(
  message: string,
  level: "warning" | "error" | "info" = "warning",
  extra?: Record<string, unknown>,
  attachments?: CaptureAttachment[],
): string {
  const id = safe(() => {
    const m = mod;
    if (!live || !m) return "";
    return m.captureEvent(
      {
        message,
        level,
        extra: { ...(extra ?? {}) },
        contexts: reportContext(),
      },
      { attachments: reportAttachments(attachments) },
    );
  }, "captureTelemetryMessage failed");
  return typeof id === "string" ? id : "";
}

/** §6 AuthProvider path: flip uid/project tags anonymous → signed-in.
 *  Hashes only — never raw uid/email (§9.5). */
export function setTelemetryIdentity(identity: {
  userHash?: string;
  projectHash?: string;
}): void {
  safe(() => {
    if (!live || !mod) return;
    if (identity.userHash) mod.setTag("user_hash", identity.userHash);
    if (identity.projectHash) mod.setTag("project_hash", identity.projectHash);
  }, "setTelemetryIdentity failed");
}

/**
 * One-call launch-crash forensics (§4.3 runPostMortem wired to U1):
 * reads the boot flag (localStorage, synchronous), the last persisted
 * bundle (IDB → localStorage fallback), ships
 * `launch-crash-last-run` at level error with bundle + renderer
 * report as attachments — exactly once, cleared only on delivery —
 * and never throws.
 */
export async function bootPostMortem(): Promise<void> {
  try {
    const [{ runPostMortem, createPostMortemDeps }, boot, { openForensicsStore }] =
      await Promise.all([
        import("./postMortem/forensics"),
        import("./boot"),
        import("./postMortem/idbStore"),
      ]);
    const bundleStorage = boot.createBundleIdbStorage(
      openForensicsStore(),
      boot.localStorageStorage(),
    );
    const deps = createPostMortemDeps(
      boot.localStorageStorage(),
      bundleStorage,
      {
        async report(bundle, report) {
          const id = captureTelemetryMessage(
            "launch-crash-last-run",
            "error",
            {
              deviceLostCount: bundle.deviceLostCount,
              breadcrumbCount: bundle.breadcrumbs.length,
              snapshotCount: bundle.snapshots.length,
            },
            [
              {
                filename: "ff-last-bundle.json",
                data: JSON.stringify(bundle),
              },
              { filename: "ff-renderer-report.txt", data: report },
            ],
          );
          if (id === "") {
            // Channel A off → NOT acked; the bundle stays for the
            // next boot (once a DSN ships).
            throw new Error("channel-a-inactive");
          }
        },
      },
    );
    await runPostMortem(deps);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ff-telemetry] bootPostMortem failed:", err);
  }
}
