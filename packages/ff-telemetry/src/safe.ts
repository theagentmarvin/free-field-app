// Safe-execution helper — the survivability law.
//
// Every exported telemetry function routes its body through `safe()`
// so telemetry can NEVER throw into app code. If an internal read
// fails (jsdom, quota, private-mode, a partially-disposed viewer,
// whatever) we log a warn and continue silently.

/**
 * Run `fn` and swallow any thrown error. Returns `undefined` on
 * failure. `label` (optional) is included in the warn so internal
 * failures are attributable without ever reaching the app.
 */
export function safe<T>(fn: () => T, label?: string): T | undefined {
  try {
    return fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    if (label !== undefined) console.warn(`[ff-telemetry] ${label}:`, err);
    return undefined;
  }
}