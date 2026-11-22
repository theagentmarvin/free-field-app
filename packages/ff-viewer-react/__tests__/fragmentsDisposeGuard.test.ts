import { describe, expect, it, vi } from "vitest";
import {
  DISPOSED_FRAGMENTS_CORE,
  disposeFragmentsManager,
  guardFragmentsManager,
  isFragmentsManagerDisposed,
} from "../src/fragmentsDisposeGuard";

/** Same shape as the engine's FragmentsManager: private `_core`, throwing `core` getter. */
class FakeManager {
  _core?: { models: { list: Map<string, unknown> }; dispose: () => void };
  coreDisposed = vi.fn();
  get initialized(): boolean {
    return !!this._core;
  }
  get core() {
    if (!this._core) throw new Error("FragmentsManager not initialized. Call init() first.");
    return this._core;
  }
  init(): void {
    this._core = { models: { list: new Map([["m", {}]]) }, dispose: this.coreDisposed };
  }
  dispose(): void {
    if (this._core) {
      this.core.dispose();
      this._core = undefined;
    }
  }
}

describe("guardFragmentsManager", () => {
  it("reproduces the bug unguarded: core throws after dispose", () => {
    const m = new FakeManager();
    m.init();
    m.dispose();
    expect(() => m.core).toThrow(/not initialized/);
  });

  it("returns the real core while live, an inert core after dispose", () => {
    const m = new FakeManager();
    m.init();
    guardFragmentsManager(m);
    expect(m.core.models.list.size).toBe(1);
    m.dispose();
    expect(m.coreDisposed).toHaveBeenCalledTimes(1);
    expect(m.core).toBe(DISPOSED_FRAGMENTS_CORE);
    expect((m.core as typeof DISPOSED_FRAGMENTS_CORE).models.list.size).toBe(0);
    expect(isFragmentsManagerDisposed(m)).toBe(true);
    return expect(m.core.update()).resolves.toBeUndefined();
  });

  it("dispose is idempotent and the engine still sees the real core during dispose", () => {
    const m = new FakeManager();
    m.init();
    guardFragmentsManager(m);
    m.dispose();
    expect(() => m.dispose()).not.toThrow();
    expect(m.coreDisposed).toHaveBeenCalledTimes(1);
  });

  it("an uninitialised (never disposed) manager still throws: a real error", () => {
    const m = new FakeManager();
    guardFragmentsManager(m);
    expect(() => m.core).toThrow(/not initialized/);
  });

  it("is idempotent and ignores shapes without a core accessor", () => {
    const m = new FakeManager();
    m.init();
    guardFragmentsManager(m);
    guardFragmentsManager(m);
    guardFragmentsManager({});
    guardFragmentsManager(null);
    expect(m.core.models.list.size).toBe(1);
  });
});

describe("disposeFragmentsManager", () => {
  it("disposes once, never rejects", async () => {
    const m = new FakeManager();
    m.init();
    await disposeFragmentsManager(m);
    await disposeFragmentsManager(m);
    expect(m.coreDisposed).toHaveBeenCalledTimes(1);
    await expect(
      disposeFragmentsManager({ dispose: () => Promise.reject(new Error("x")) }),
    ).resolves.toBeUndefined();
    await expect(disposeFragmentsManager(null)).resolves.toBeUndefined();
  });
});

describe("setBaseCoordinates (stale load after dispose)", () => {
  it("assigns on a live core", async () => {
    const { setBaseCoordinates } = await import("../src/fragmentsDisposeGuard");
    const core: { baseCoordinates: [number, number, number] | null } = { baseCoordinates: null };
    expect(setBaseCoordinates(core, [1, 2, 3])).toBe(true);
    expect(core.baseCoordinates).toEqual([1, 2, 3]);
  });

  it("is a no-op (not a TypeError) on the frozen disposed core", async () => {
    const { setBaseCoordinates, DISPOSED_FRAGMENTS_CORE } = await import("../src/fragmentsDisposeGuard");
    expect(() => setBaseCoordinates(DISPOSED_FRAGMENTS_CORE as never, [1, 2, 3])).not.toThrow();
    expect(setBaseCoordinates(DISPOSED_FRAGMENTS_CORE as never, [1, 2, 3])).toBe(false);
  });
});
