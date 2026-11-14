// Test setup for @ff/telemetry (jsdom).

// Register an in-memory IndexedDB implementation for the U4 forensic
// store tests. `fake-indexeddb/auto` installs `indexedDB` (and the
// IDB* constructors) onto the jsdom window, so `openForensicsStore`
// can be exercised without touching a real browser DB.
import "fake-indexeddb/auto";

// jsdom ships no canvas implementation, and every `getContext(...)`
// call (webgl / webgl2 / 2d) fires a noisy "Not implemented" error at
// the virtual console. `deviceTags()` legitimately probes a throwaway
// 1×1 canvas for the GPU string and WebGL2 support; in jsdom that
// probe should degrade cleanly (`gpu → "unknown"`, `webgl2 → false`)
// instead of spamming stderr. Stub the method to return null.

const proto = HTMLCanvasElement.prototype as unknown as {
  getContext: (...args: unknown[]) => unknown;
};
proto.getContext = () => null;