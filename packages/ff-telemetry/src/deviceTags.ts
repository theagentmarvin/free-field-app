// deviceTags — one-shot device fingerprint for crash forensics.
//
// Every field is collected in its OWN try/catch so a single broken
// API (jsdom, a browser without WebGL2, a privacy browser without
// deviceMemory) can never take down the whole tag collection. The
// result is a flat `Record<string, unknown>` that lands in the
// bundle's `tags` entry.

/** Read the GPU string via `WEBGL_debug_renderer_info` on a
 *  throwaway 1×1 webgl context. Returns `"unknown"` when WebGL or
 *  the extension is unavailable. Defensive throughout. */
function readGpuString(): string {
  if (typeof document === "undefined") return "unknown";
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  // Structural cast — no WebGL types required (and none wanted;
  // this package must not import `three` or the webgl typings' full
  // surface). Every probe is optional-chained and defensively read.
  const gl = (canvas.getContext("webgl") ??
    canvas.getContext("experimental-webgl")) as unknown as {
    getExtension?: (name: string) => unknown;
    getParameter?: (p: unknown) => unknown;
    RENDERER?: unknown;
  } | null;
  if (!gl) return "unknown";
  const ext = gl.getExtension?.("WEBGL_debug_renderer_info") as
    | { UNMASKED_RENDERER_WEBGL?: unknown }
    | undefined;
  const value = ext?.UNMASKED_RENDERER_WEBGL
    ? gl.getParameter?.(ext.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter?.(gl.RENDERER);
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** Assign `key = fn()` on `tags`, guarded by its own try/catch.
 *  On failure the key is recorded as `null` so the bundle shape is
 *  stable (a missing key reads the same as "we couldn't get it"). */
function collect(
  tags: Record<string, unknown>,
  key: string,
  fn: () => unknown,
): void {
  try {
    tags[key] = fn();
  } catch {
    tags[key] = null;
  }
}

/** Cross-browser env access. Avoids a hard dependency on
 *  `vite/client` types (`import.meta.env` is only typed when that
 *  reference is present), so the package compiles standalone. */
function readEnv(name: string): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> })
      .env;
    const value = env?.[name];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the app is running in demo (offline) mode. Read from
 *  `VITE_FF_DEMO_AUTH` — any truthy string counts. */
function readDemoMode(): boolean {
  const flag = readEnv("VITE_FF_DEMO_AUTH");
  if (flag === undefined) return false;
  return !(flag === "" || flag === "0" || flag === "false");
}

/** Collect device tags once. Every field individually try/catch. */
export function deviceTags(): Record<string, unknown> {
  const tags: Record<string, unknown> = {};

  collect(tags, "gpu", readGpuString);
  collect(tags, "webgl2", () => {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  });
  collect(tags, "deviceMemory", () =>
    typeof navigator === "undefined" ? null : (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  );
  collect(tags, "hardwareConcurrency", () =>
    typeof navigator === "undefined" ? null : navigator.hardwareConcurrency,
  );
  collect(tags, "userAgent", () =>
    typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
  );
  collect(tags, "screen", () => {
    if (typeof screen === "undefined") return "unknown";
    return `${screen.width}x${screen.height}`;
  });
  collect(tags, "isDemoMode", readDemoMode);

  return tags;
}