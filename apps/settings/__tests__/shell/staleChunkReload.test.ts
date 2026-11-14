import { describe, expect, it, vi } from "vitest";

import {
  installStaleChunkReload,
  shouldReloadForStaleChunk,
} from "../../src/shell/staleChunkReload";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("stale chunk reload", () => {
  it("allows one reload, then blocks a loop within 30 s", () => {
    const s = memStorage();
    expect(shouldReloadForStaleChunk(1_000_000, s)).toBe(true);
    expect(shouldReloadForStaleChunk(1_010_000, s)).toBe(false);
    expect(shouldReloadForStaleChunk(1_031_000, s)).toBe(true);
  });

  it("still reloads once when storage is unavailable", () => {
    expect(shouldReloadForStaleChunk(5, null)).toBe(true);
  });

  it("reloads the page on vite:preloadError and suppresses the throw", () => {
    const reload = vi.fn();
    const target = new EventTarget();
    const win = Object.assign(target, {
      sessionStorage: memStorage(),
      location: { reload },
    }) as unknown as Window;
    installStaleChunkReload(win);
    const ev = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(ev);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    // a second failure right after does not loop
    const ev2 = new Event("vite:preloadError", { cancelable: true });
    win.dispatchEvent(ev2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev2.defaultPrevented).toBe(false);
  });
});
