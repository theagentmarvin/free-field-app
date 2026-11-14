// Wave 30: the fragments worker resolution rules, tested without
// mounting the viewer.
//
// The regression this file exists for: the old code cached the
// in-flight Promise at module scope and cleared it only on success, so
// ONE transient fetch failure permanently poisoned every later mount
// in that tab (each awaited the same already-rejected Promise). A
// second, quieter bug rode along: the worker URL was a hardcoded
// `fragments@3.4.5` string on unpkg while the dependency is `^3.4.5`,
// so a routine package bump would pair a new main thread with an old
// worker protocol.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAGMENTS_WORKER_BUNDLE_URL,
  FRAGMENTS_WORKER_CDN,
  FRAGMENTS_WORKER_SOURCES,
  getFragmentsWorkerBlobUrl,
  resetFragmentsWorkerCache,
} from "../../src/worker/fragmentsWorkerUrl";

type Fetcher = (input: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function stubFetch(impl: Fetcher) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

const okBody = (body: string): Fetcher => async () => ({
  ok: true,
  status: 200,
  text: async () => body,
});

describe("fragmentsWorkerUrl", () => {
  beforeEach(() => {
    resetFragmentsWorkerCache();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, {
      createObjectURL: vi.fn(() => "blob:mock-worker"),
      revokeObjectURL: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetFragmentsWorkerCache();
  });

  it("resolves the bundled worker first, CDN only as fallback", async () => {
    // The asset import must be the LOCAL file, not a CDN string: that
    // is what makes the worker version-locked to the installed package.
    expect(FRAGMENTS_WORKER_BUNDLE_URL).toBeTruthy();
    expect(FRAGMENTS_WORKER_BUNDLE_URL).not.toMatch(/^https?:/);
    expect(FRAGMENTS_WORKER_SOURCES[0]).toBe(FRAGMENTS_WORKER_BUNDLE_URL);
    expect(FRAGMENTS_WORKER_SOURCES[1]).toBe(FRAGMENTS_WORKER_CDN);

    stubFetch(okBody("/* worker */"));
    await getFragmentsWorkerBlobUrl();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(FRAGMENTS_WORKER_BUNDLE_URL);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("falls back to the CDN when the bundled asset cannot be fetched", async () => {
    stubFetch(async (input) =>
      input === FRAGMENTS_WORKER_BUNDLE_URL
        ? { ok: false, status: 404, text: async () => "" }
        : { ok: true, status: 200, text: async () => "/* worker */" },
    );
    await expect(getFragmentsWorkerBlobUrl()).resolves.toBe("blob:mock-worker");
    expect(vi.mocked(fetch).mock.calls.map((c) => c[0])).toEqual([
      FRAGMENTS_WORKER_BUNDLE_URL,
      FRAGMENTS_WORKER_CDN,
    ]);
  });

  it("shares one fetch between concurrent callers", async () => {
    stubFetch(okBody("/* worker */"));
    const [a, b] = await Promise.all([
      getFragmentsWorkerBlobUrl(),
      getFragmentsWorkerBlobUrl(),
    ]);
    expect(a).toBe(b);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("reuses the resolved blob URL across remounts", async () => {
    stubFetch(okBody("/* worker */"));
    await getFragmentsWorkerBlobUrl();
    await getFragmentsWorkerBlobUrl();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  // ── THE regression: a failure must not be remembered ─────────────
  it("retries after a failed attempt instead of wedging forever", async () => {
    // Attempt 1: both sources fail (flaky network / offline).
    stubFetch(async () => {
      throw new Error("network down");
    });
    await expect(getFragmentsWorkerBlobUrl()).rejects.toThrow("network down");

    // Attempt 2: the network is fine now. The old code returned the
    // cached rejected Promise here, so every model load in the tab
    // failed permanently until a reload.
    stubFetch(okBody("/* worker */"));
    await expect(getFragmentsWorkerBlobUrl()).resolves.toBe("blob:mock-worker");
  });

  it("caches a success that arrives after a failure", async () => {
    // The identity guard in the failure cleanup: a caller that retries
    // and succeeds must not have its fresh handle dropped by the
    // older attempt's (late) rejection handler.
    stubFetch(async () => {
      throw new Error("down");
    });
    await expect(getFragmentsWorkerBlobUrl()).rejects.toThrow("down");
    stubFetch(okBody("/* worker */"));
    await getFragmentsWorkerBlobUrl(); // succeeds and caches
    // A third call must hit the cache, not fetch again.
    stubFetch(async () => {
      throw new Error("must not be fetched");
    });
    await expect(getFragmentsWorkerBlobUrl()).resolves.toBe("blob:mock-worker");
  });
});
