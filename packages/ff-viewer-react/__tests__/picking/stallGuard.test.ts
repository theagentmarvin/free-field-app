import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  withStallGuard,
  pickElementIdFastTolerant,
  PICK_STALL_BUDGET_MS,
  PICK_PROBE_RPC_BUDGET_MS,
} from "../../src/picking/pickSeam";
import type { BatchedIdPassReader } from "../../src/picking/idPassInterop";

describe("withStallGuard (wave 27)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through a pick that wins the race", async () => {
    const onStall = vi.fn();
    const p = withStallGuard<string>(
      Promise.resolve("hit"),
      onStall,
      "fallback",
      100,
    );
    await expect(p).resolves.toBe("hit");
    await vi.advanceTimersByTimeAsync(500);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires onStall once and resolves the fallback for a hung pick", async () => {
    const onStall = vi.fn();
    const p = withStallGuard<string>(
      new Promise<string>(() => {
        /* never settles — the boss's real-scene signature */
      }),
      onStall,
      "fallback",
      100,
    );
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toBe("fallback");
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("propagates rejections untouched (the seam owns the degrade)", async () => {
    const onStall = vi.fn();
    const p = withStallGuard<string>(
      Promise.reject(new Error("drift")),
      onStall,
      "fallback",
      100,
    );
    await expect(p).rejects.toThrow("drift");
    await vi.advanceTimersByTimeAsync(500);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("budget covers the legitimate 33-probe worst case", () => {
    expect(PICK_STALL_BUDGET_MS).toBeGreaterThanOrEqual(3000);
  });
});

describe("pickElementIdFastTolerant onDegrade (wave 27)", () => {
  it("reports the batched throw when it degrades to the per-probe loop", async () => {
    const picker = {
      getItemAt: async () => ({ modelId: "m", localId: 42 }),
    };
    const batched = {
      totalRenders: 0,
      read: async () => {
        throw new Error("renderer drifted");
      },
    };
    const onDegrade = vi.fn();
    const hit = await pickElementIdFastTolerant(
      picker as never,
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      batched as never,
      onDegrade,
    );
    expect(hit).toMatchObject({ modelId: "m", expressId: 42 });
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(String(onDegrade.mock.calls[0][0])).toContain("renderer drifted");
  });

  it("stays silent when the batched path works — and never touches getItemAt", async () => {
    const getItemAt = vi.fn(async () => null);
    const picker = { getItemAt };
    const batched: BatchedIdPassReader = {
      totalRenders: 1,
      read: async (ndcs) => ({
        items: [
          { modelId: "m", localId: 7 },
          ...Array.from({ length: ndcs.length - 1 }, () => null),
        ],
        inconclusive: false,
        stats: {
          probes: ndcs.length,
          rawHits: 1,
          rpcs: 1,
          cacheHits: 0,
          readbacks: 1,
          boxRead: true,
          translateTimeouts: 0,
          ms: 1,
        },
      }),
    };
    const onDegrade = vi.fn();
    const hit = await pickElementIdFastTolerant(
      picker as never,
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      batched,
      onDegrade,
    );
    expect(hit).toMatchObject({ modelId: "m", expressId: 7 });
    expect(onDegrade).not.toHaveBeenCalled();
    // The wave-25 contract this test used to miss entirely: a working
    // batched read must NOT pay a single per-probe round-trip.
    expect(getItemAt).not.toHaveBeenCalled();
  });
});

// ── Wave 28: UNKNOWN is not empty space ──────────────────────────
// The chain treats `null` as "the user clicked void" (clear the
// selection) and `undefined` as "we do not know" (no-op). Mixing them
// up wipes a real selection and can persist a wrong task anchor, so
// both directions are pinned here.

describe("pickElementIdFastTolerant inconclusive contract (wave 28)", () => {
  const stats = (probes: number) => ({
    probes,
    rawHits: 1,
    rpcs: 1,
    cacheHits: 0,
    readbacks: 1,
    boxRead: true,
    translateTimeouts: 1,
    ms: 1,
  });

  it("maps an inconclusive batched read to undefined, never to null", async () => {
    const getItemAt = vi.fn(async () => null);
    const batched: BatchedIdPassReader = {
      totalRenders: 1,
      read: async (ndcs) => ({
        items: ndcs.map(() => null),
        inconclusive: true,
        stats: stats(ndcs.length),
      }),
    };
    const res = await pickElementIdFastTolerant(
      { getItemAt } as never,
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      batched,
    );
    expect(res).toBeUndefined();
    expect(getItemAt).not.toHaveBeenCalled();
  });

  it("a confirmed void batched read still resolves to null (clear selection)", async () => {
    const batched: BatchedIdPassReader = {
      totalRenders: 1,
      read: async (ndcs) => ({
        items: ndcs.map(() => null),
        inconclusive: false,
        stats: { ...stats(ndcs.length), rawHits: 0, rpcs: 0, translateTimeouts: 0 },
      }),
    };
    const res = await pickElementIdFastTolerant(
      { getItemAt: async () => null } as never,
      { x: 0, y: 0 },
      { x: 800, y: 600 },
      batched,
    );
    expect(res).toBeNull();
  });

  it("a wedged getItemAt stops at the per-call budget, not the 4 s chain guard", async () => {
    vi.useFakeTimers();
    try {
      const getItemAt = vi.fn(
        () => new Promise<never>(() => undefined /* wedged worker */),
      );
      const onDegrade = vi.fn();
      const pending = pickElementIdFastTolerant(
        { getItemAt } as never,
        { x: 0, y: 0 },
        { x: 800, y: 600 },
        null,
        onDegrade,
      );
      await vi.advanceTimersByTimeAsync(PICK_PROBE_RPC_BUDGET_MS + 10);
      await expect(pending).resolves.toBeUndefined();
      // One bounded call, then stop: the wedge is proven by the FIRST
      // timeout, so later probes are not worth a second guess.
      expect(getItemAt).toHaveBeenCalledTimes(1);
      // A stall is NOT a private-internals drift: `degrades` stays clean
      // so wave-27's Sentry signal keeps its meaning.
      expect(onDegrade).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slow-but-alive degraded scan still finishes (rings are not cut off)", async () => {
    // Wave 27 documented ~120 ms per getItemAt on the field device, so a
    // full 33-probe void scan legitimately takes seconds. Bounding the
    // whole scan would have silently removed the thin-MEP tolerance
    // rings exactly on the degraded backend that still needs them.
    vi.useFakeTimers();
    try {
      const getItemAt = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 120));
        return null;
      });
      const pending = pickElementIdFastTolerant(
        { getItemAt } as never,
        { x: 0, y: 0 },
        { x: 800, y: 600 },
        null,
      );
      await vi.advanceTimersByTimeAsync(33 * 120 + 600);
      await expect(pending).resolves.toBeNull();
      expect(getItemAt).toHaveBeenCalledTimes(33);
    } finally {
      vi.useRealTimers();
    }
  });
});
