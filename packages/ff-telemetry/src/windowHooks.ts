// attachWindowHooks — the v1 off-tablet data path (console, not
// network). Sets `window.__ffTelemetry` with get/copy/dump/export.
// Callers guard with `import.meta.env.DEV` — this function just
// installs the object.

import { safe } from "./safe";
import type { Telemetry, TelemetryBundle } from "./telemetry";

export interface WindowTelemetryApi {
  get: () => TelemetryBundle;
  copy: () => Promise<void>;
  dump: () => void;
  export: () => void;
}

/** Install `window.__ffTelemetry`. Returns a detach fn (sets the
 *  global back to undefined). Never throws. */
export function attachWindowHooks(telemetry: Telemetry): () => void {
  return safe(() => {
    if (typeof window === "undefined") return () => {}; // eslint-disable-line @typescript-eslint/no-empty-function

    const api: WindowTelemetryApi = {
      get() {
        return telemetry.getBundle();
      },
      async copy() {
        await safe(async () => {
          const json = JSON.stringify(telemetry.getBundle(), null, 2);
          // Fall back to a hidden textarea copy when the async
          // Clipboard API is unavailable (non-secure context).
          try {
            if (navigator?.clipboard?.writeText) {
              await navigator.clipboard.writeText(json);
              return;
            }
          } catch {
            // fall through to textarea fallback
          }
          const ta = document.createElement("textarea");
          ta.value = json;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }, "copy failed");
      },
      dump() {
        safe(() => {
          // eslint-disable-next-line no-console
          console.table(telemetry.getBundle().breadcrumbs);
        }, "dump failed");
      },
      export() {
        safe(() => {
          const json = JSON.stringify(telemetry.getBundle(), null, 2);
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `ff-telemetry-${Date.now()}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, "export failed");
      },
    };

    const w = window as unknown as { __ffTelemetry?: WindowTelemetryApi };
    w.__ffTelemetry = api;

    return () => {
      safe(() => {
        const ww = window as unknown as { __ffTelemetry?: WindowTelemetryApi };
        if (ww.__ffTelemetry === api) ww.__ffTelemetry = undefined;
      }, "detach window hooks failed");
    };
  }, "attachWindowHooks failed") ?? (() => {}); // eslint-disable-line @typescript-eslint/no-empty-function
}