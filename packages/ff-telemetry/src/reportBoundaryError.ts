// reportBoundaryError — route an error caught by a React error boundary
// into the same telemetry paths uncaught `window` errors take.
//
// React swallows render errors inside a boundary, so neither `window.onerror`
// nor `unhandledrejection` ever sees them; without this seam a render crash
// only reached `console.error`.
//
// Consent / enable flags are inherited, not re-invented:
//  - the local breadcrumb + persist happen only once a telemetry singleton is
//    registered (the viewer seam), exactly like uncaught errors;
//  - the remote capture happens only when a Channel-A reporter is installed,
//    which `initTelemetry` does ONLY when a Sentry DSN is configured (crash
//    channels are the no-consent-needed, on-by-DSN channels; analytics keeps
//    its separate opt-in and is untouched here).
//
// PII: only the module label, the error name/message (truncated, then scrubbed
// by the Sentry layer) and the React component stack (component names only) are
// sent. No props, state, user ids or URLs.
//
// Survivability law: never throws into the boundary.

import { persist } from "./boot";
import { getErrorReporter } from "./errorListeners";
import { safe } from "./safe";
import { getGlobalTelemetry } from "./singleton";

const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 2000;

export interface BoundaryErrorContext {
  /** Name of the module / region the boundary wraps ("Documents", "The 3D viewer"). */
  module?: string;
  /** `ErrorInfo.componentStack` from `componentDidCatch`. */
  componentStack?: string | null;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

export function reportBoundaryError(error: unknown, ctx: BoundaryErrorContext = {}): void {
  safe(() => {
    const err = error instanceof Error ? error : new Error(String(error));
    const module = ctx.module ?? "unknown";
    const componentStack = clip((ctx.componentStack ?? "").trim(), MAX_STACK_CHARS);
    const message = clip(`${err.name}: ${err.message}`, MAX_MESSAGE_CHARS);

    const telemetry = getGlobalTelemetry();
    if (telemetry) {
      telemetry.breadcrumb("error:react-boundary", "error", { module, message });
      persist(telemetry, undefined, true);
    }

    const reporter = getErrorReporter();
    if (reporter) {
      reporter.captureException(err, {
        category: "error:react-boundary",
        module,
        message,
        componentStack,
      });
    }
  }, "reportBoundaryError failed");
}
