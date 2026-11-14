// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import {
  clearPhotoUrlCache,
  resolvePhotoUrlCached,
  usePhotoUrl,
  PHOTO_URL_CACHE_LIMIT,
} from "../src/usePhotoUrl";

/**
 * Wave 1A · the shared Storage-path → download-URL cache.
 *
 * Fifty rows with the same photo must cost ONE lookup, so the cache is
 * module-level and shared. Failures resolve to `null` (never a
 * rejection) — a missing photo is "no thumb", not an error.
 */

beforeEach(() => {
  clearPhotoUrlCache();
});

describe("resolvePhotoUrlCached", () => {
  it("resolves a path once and reuses the same promise", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    const first = resolvePhotoUrlCached(resolve, "p/a.jpg");
    const second = resolvePhotoUrlCached(resolve, "p/a.jpg");
    expect(second).toBe(first); // same promise → one lookup
    await first;
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("a rejection becomes null (never an unhandled rejection)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(resolvePhotoUrlCached(resolve, "p/bad.jpg")).resolves.toBeNull();
  });

  it("an empty / non-string result becomes null", async () => {
    await expect(resolvePhotoUrlCached(async () => "", "p/empty.jpg")).resolves.toBeNull();
    await expect(
      resolvePhotoUrlCached(async () => null as unknown as string, "p/null.jpg")
    ).resolves.toBeNull();
  });

  it("different paths resolve independently", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    await Promise.all([
      resolvePhotoUrlCached(resolve, "p/a.jpg"),
      resolvePhotoUrlCached(resolve, "p/b.jpg"),
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("evicts the OLDEST entry past the cap (FIFO)", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    await resolvePhotoUrlCached(resolve, "p/old.jpg");
    const callsForOld = () => resolve.mock.calls.filter((c) => c[0] === "p/old.jpg").length;
    expect(callsForOld()).toBe(1);
    for (let i = 0; i < PHOTO_URL_CACHE_LIMIT; i++) {
      await resolvePhotoUrlCached(resolve, `p/fill-${i}.jpg`);
    }
    await resolvePhotoUrlCached(resolve, "p/old.jpg");
    expect(callsForOld()).toBe(2); // evicted → resolved again
  });

  it("clearPhotoUrlCache drops everything", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    await resolvePhotoUrlCached(resolve, "p/a.jpg");
    clearPhotoUrlCache();
    await resolvePhotoUrlCached(resolve, "p/a.jpg");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("usePhotoUrl", () => {
  it("returns the resolved URL", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    const { result } = renderHook(() => usePhotoUrl(resolve, "p/a.jpg"));
    await waitFor(() => expect(result.current).toBe("url:p/a.jpg"));
  });

  it("stays null without a resolver", async () => {
    const { result } = renderHook(() => usePhotoUrl(undefined, "p/a.jpg"));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });

  it("stays null without a path", async () => {
    const resolve = vi.fn(async (p: string) => `url:${p}`);
    const { result } = renderHook(() => usePhotoUrl(resolve, undefined));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a failed resolution stays null (no crash, no error state)", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("nope");
    });
    const { result } = renderHook(() => usePhotoUrl(resolve, "p/bad.jpg"));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });
});

describe("resolvePhotoUrlCached — misses are not remembered (w68)", () => {
  it("retries after a null result but caches hits", async () => {
    const { resolvePhotoUrlCached, clearPhotoUrlCache } = await import("../src/usePhotoUrl");
    clearPhotoUrlCache();
    let n = 0;
    const resolve = async () => (++n < 2 ? null : "data:ok");
    expect(await resolvePhotoUrlCached(resolve, "p")).toBeNull();
    await Promise.resolve();
    expect(await resolvePhotoUrlCached(resolve, "p")).toBe("data:ok");
    expect(await resolvePhotoUrlCached(resolve, "p")).toBe("data:ok");
    expect(n).toBe(2);
  });
});
