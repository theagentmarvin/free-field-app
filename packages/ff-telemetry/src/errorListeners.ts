// installErrorListeners — capture uncaught errors + rejections into
// the breadcrumb ring and immediately persist (so a crash leaves a
// forensic record even if the tab dies right after).
//
// `CustomIsIgnoredException` analogue: `ResizeObserver loop…`
// and `AbortError` messages are noise that fire benignly in every
// production viewer — they are ignored so the ring isn't drowned.
//
// Wave 18 U3 (spec §3 layout: "errorListeners.ts # (existing) + hook
// to Channel A reporter when installed"): the local v1 path below is
// unchanged, but once Channel A (Sentry) is installed the uncaught
// error must ALSO travel through it. U1 exposes exactly one live
// Channel-A endpoint — the breadcrumb bridge in `src/sentry/
// breadcrumbs.ts` — so we install that bridge on the telemetry
// instance here. The `error:Error` crumb written below is then
// mirrored into Sentry automatically, with no extra wiring.
//
// The bridge resolves the Sentry sink LAZILY (at breadcrumb time), so
// it works whether Channel A was installed before or after the error
// listeners, and it is an inert no-op when Channel A is off. The
// attach is idempotent per telemetry instance, so repeated
// `installErrorListeners` calls never double-mirror a crumb.
//
// No `@sentry/browser` import here: the bridge module is pure
// (structural sink), so the error path stays Sentry-free and the
// tests never need a DSN. An explicit reporter can still be injected
// (per install or globally via `setErrorReporter`) for callers that
// want a dedicated exception capture with the local detail attached.
//
// Survivability law: every body is `safe()`-wrapped — a throwing
// reporter (or bridge) can never break the local breadcrumb/persist
// path.

import { safe } from "./safe";
import { persist } from "./boot";
import { attachSentryBreadcrumbBridge } from "./sentry/breadcrumbs";
import type { Telemetry } from "./telemetry";

const MAX_MESSAGE_CHARS = 500;

/** Messages matching ANY of these (substring) are ignored. */
const IGNORED_PATTERNS: RegExp[] = [/ResizeObserver loop/i, /AbortError/i];

function isIgnored(message: string): boolean {
  return IGNORED_PATTERNS.some((re) => re.test(message));
}

/**
 * A Channel-A reporter hook — structurally compatible with Sentry's
 * `captureException(error, { extra })`. Kept structural so this
 * package never imports the SDK in the error path.
 */
export interface ErrorReporter {
  captureException(error: unknown, extra?: Record<string, unknown>): void;
}

/** Options accepted by {@link installErrorListeners}. */
export interface ErrorListenerOptions {
  /**
   * Explicit Channel-A reporter. When omitted, the reporter installed
   * via {@link setErrorReporter} is used (if any). `null` disables the
   * explicit capture for this listener regardless of the installed one.
   */
  reporter?: ErrorReporter | null;
  /** Extra, PII-free data attached to every explicit capture. */
  extra?: Record<string, unknown>;
}

/** The installed Channel-A reporter (null when none is installed). */
let installedReporter: ErrorReporter | null = null;

/**
 * Install (or clear, with `null`) the Channel-A reporter used by the
 * error listeners. Safe to call before/after listeners are attached;
 * never throws.
 */
export function setErrorReporter(reporter: ErrorReporter | null): void {
  safe(() => {
    installedReporter = reporter;
  }, "setErrorReporter failed");
}

/** The currently installed Channel-A reporter (`null` when none). */
export function getErrorReporter(): ErrorReporter | null {
  return safe(() => installedReporter, "getErrorReporter failed") ?? null;
}

/**
 * The minimal surface the Sentry breadcrumb bridge needs — it only
 * ever calls `breadcrumb(...)`.
 */
interface BridgeTarget {
  breadcrumb(
    category: string,
    action: string,
    data?: Record<string, unknown>,
  ): void;
}

/** Per-telemetry Channel-A bridge proxy. */
const channelAProxies = new WeakMap<object, BridgeTarget>();

/**
 * Install the Channel-A (Sentry) breadcrumb bridge for a telemetry
 * instance — idempotent per instance, so calling it from several
 * places never double-mirrors a breadcrumb into Sentry.
 *
 * The bridge is attached to a private PROXY that forwards to the real
 * telemetry, so the caller's telemetry instance is never mutated. That
 * keeps this additive: the viewer seam (and `initSentry`) may attach
 * its own bridge to the same instance without interfering.
 *
 * The bridge resolves the Sentry sink LAZILY (at breadcrumb time), so
 * it works whether Channel A was installed before or after the error
 * listeners — and it is an inert no-op when Channel A is off.
 *
 * Returns `true` when this call performed the attach.
 */
export function attachChannelAErrorBridge(telemetry: Telemetry): boolean {
  return (
    safe(() => {
      if (telemetry === null || telemetry === undefined) return false;
      const key = telemetry as unknown as object;
      if (typeof key !== "object") return false;
      if (channelAProxies.has(key)) return false;

      const proxy: BridgeTarget = {
        breadcrumb(category, action, data) {
          safe(
            () => telemetry.breadcrumb(category, action, data),
            "channel A proxy forward failed",
          );
        },
      };
      // The bridge wraps the proxy's breadcrumb: it mirrors into the
      // Channel-A sink AND forwards to the real telemetry's ring.
      attachSentryBreadcrumbBridge(proxy as unknown as Telemetry);
      channelAProxies.set(key, proxy);
      return true;
    }, "attachChannelAErrorBridge failed") ?? false
  );
}

/** The Channel-A bridge proxy for a telemetry instance (if attached). */
function channelAProxy(telemetry: Telemetry): BridgeTarget | null {
  return safe(
    () => channelAProxies.get(telemetry as unknown as object) ?? null,
    "channel A proxy lookup failed",
  ) ?? null;
}

/** Truncate a combined message+stack to 500 chars, cleaning up
 *  stack indentation/linebreaks so the breadcrumb stays compact. */
function truncateDetail(message: string, stack?: string): string {
  const detail = `${message}${stack ? `\n${stack}` : ""}`.trim();
  if (detail.length <= MAX_MESSAGE_CHARS) return detail;
  return `${detail.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}

/**
 * Resolve the reporter to use for an explicit capture: an explicit one
 * wins, then the installed Channel-A reporter. Returns `null` when no
 * reporter is available.
 */
function resolveReporter(
  explicit: ErrorReporter | null | undefined,
): ErrorReporter | null {
  if (explicit === null) return null; // explicitly disabled
  if (explicit) return explicit;
  return getErrorReporter();
}

/**
 * Send an uncaught error to an explicitly-provided Channel-A
 * reporter. Never throws — a broken reporter must not affect the
 * local path.
 */
function reportToChannelA(
  reporter: ErrorReporter | null,
  rawError: unknown,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  if (!reporter) return;
  safe(() => {
    const error =
      rawError instanceof Error ? rawError : new Error(detail || "unknown error");
    reporter.captureException(error, {
      category: "error:Error",
      message: detail,
      ...(extra ?? {}),
    });
  }, "channel A reporter failed");
}

/**
 * Record an uncaught error: local breadcrumb + immediate persist
 * (v1 behaviour, unchanged), then — when a Channel-A reporter is
 * available — the remote capture. The breadcrumb itself is mirrored
 * into Channel A by the bridge installed in `installErrorListeners`.
 */
function recordUncaught(
  telemetry: Telemetry,
  detail: string,
  rawError: unknown,
  reporter: ErrorReporter | null,
  bridge: BridgeTarget | null,
  extra?: Record<string, unknown>,
): void {
  const name = "Error";
  if (isIgnored(detail)) return;
  // Through the Channel-A proxy when available: the crumb lands in the
  // local ring AND is mirrored into the remote channel. Falls back to
  // the plain local path when no proxy is attached.
  if (bridge) {
    bridge.breadcrumb(`error:${name}`, "error", { message: detail });
  } else {
    telemetry.breadcrumb(`error:${name}`, "error", { message: detail });
  }
  // Immediate, un-throttled persist — a hard crash must leave a record.
  persist(telemetry, undefined, true);
  // Channel A (optional): route the uncaught error through the
  // installed reporter. Best-effort, never throws.
  reportToChannelA(reporter, rawError, detail, extra);
}

/**
 * Wire `window` `error` + `unhandledrejection` listeners. Returns a
 * detach function. The ignore-filter drops `ResizeObserver loop` /
 * `AbortError` before any breadcrumb is written.
 *
 * The Channel-A bridge is installed here so that, once Sentry is
 * installed, the uncaught error is mirrored into the remote channel
 * too. `options.reporter` (or a reporter installed via
 * {@link setErrorReporter}) additionally enables an explicit exception
 * capture carrying the local forensic detail.
 */
export function installErrorListeners(
  telemetry: Telemetry,
  options: ErrorListenerOptions = {},
): () => void {
  return (
    safe(() => {
      if (typeof window === "undefined") {
        return () => {
          /* no window — nothing to detach */
        };
      }

      // Hook the installed Channel-A reporter (if any) — uncaught
      // errors then travel through the bridge as well.
      attachChannelAErrorBridge(telemetry);
      const bridge = channelAProxy(telemetry);

      const extra = options.extra;

      const onError = (event: ErrorEvent): void => {
        safe(() => {
          const message = event.message ?? "unknown error";
          recordUncaught(
            telemetry,
            truncateDetail(message, event.error?.stack ?? undefined),
            event.error,
            resolveReporter(options.reporter),
            bridge,
            extra,
          );
        }, "window error handler failed");
      };

      const onRejection = (event: PromiseRejectionEvent): void => {
        safe(() => {
          const reason = event.reason;
          let message = "unhandled promise rejection";
          let stack: string | undefined;
          if (reason instanceof Error) {
            message = reason.message;
            stack = reason.stack;
          } else if (reason !== undefined && reason !== null) {
            message = typeof reason === "string" ? reason : String(reason);
          }
          recordUncaught(
            telemetry,
            truncateDetail(message, stack),
            reason,
            resolveReporter(options.reporter),
            bridge,
            extra,
          );
        }, "unhandledrejection handler failed");
      };

      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);

      return () => {
        safe(() => {
          window.removeEventListener("error", onError);
          window.removeEventListener("unhandledrejection", onRejection);
        }, "remove error listeners failed");
      };
    }, "installErrorListeners failed") ??
    (() => {
      /* no-op detach */
    })
  );
}
