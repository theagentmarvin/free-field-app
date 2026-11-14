// Smoke test for the viewer telemetry seam (jsdom, no WebGL).
//
// Verifies:
//   - `ensureViewerTelemetry()` is a true module singleton
//   - `attachViewerTelemetry()` wires the context-lost/restored
//     listeners and the 1 Hz sampler, and its detach fn tears down
//   - nothing throws when the stub renderer/canvas is missing fields
//
// The seam never imports `three` (structural types only), so it
// loads cleanly beside the OBC mocks in the package setup.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  attachViewerTelemetry,
  ensureViewerTelemetry,
  type RendererInfoLike,
  type CanvasEventTargetLike,
} from "../viewerTelemetry";

// jsdom ships no canvas: the `deviceTags` GPU probe would emit a
// "Not implemented" error for every getContext call. Silence it so
// getBundle() (which lazily collects tags) stays quiet.
const originalGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext =
    () => null;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("viewerTelemetry seam", () => {
  it("ensureViewerTelemetry returns a module singleton", () => {
    const a = ensureViewerTelemetry();
    const b = ensureViewerTelemetry();
    expect(a).toBe(b);
    // Bundle is total: breadcrumbs, snapshots, counters, tags.
    const bundle = a.getBundle();
    expect(Array.isArray(bundle.breadcrumbs)).toBe(true);
    expect(Array.isArray(bundle.snapshots)).toBe(true);
    expect(typeof bundle.deviceLostCount).toBe("number");
    expect(typeof bundle.tags).toBe("object");
  });

  it("wires context-loss + sampler and returns a working detach fn", () => {
    const t = ensureViewerTelemetry();
    const lostBefore = t.deviceLostCount;

    const canvas: CanvasEventTargetLike = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const renderer: RendererInfoLike = {
      info: {
        render: { calls: 1, triangles: 2 },
        memory: { geometries: 3, textures: 4 },
      },
    };

    const detach = attachViewerTelemetry(renderer, canvas);

    // context-lost listener was registered
    const lostCb = (canvas.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "webglcontextlost",
    )?.[1] as (() => void) | undefined;
    expect(lostCb).toBeTypeOf("function");
    lostCb?.();
    expect(t.deviceLostCount).toBe(lostBefore + 1);

    // the 1 Hz sampler snapshot the "renderer" key (immediate first tick)
    expect(
      t.getBundle().snapshots.some((s) => s.key === "renderer"),
    ).toBe(true);

    detach();
    // Wave 18 U3/U7: context events now flow through attachContextEvents,
    // which removes with the same listenerOptions object it added with.
    expect(canvas.removeEventListener).toHaveBeenCalledWith(
      "webglcontextlost",
      lostCb,
      expect.anything(),
    );
  });

  it("does not throw when the stub is missing fields", () => {
    expect(() => attachViewerTelemetry(undefined, undefined)).not.toThrow();
    expect(() => attachViewerTelemetry({}, {})).not.toThrow();
    expect(() => attachViewerTelemetry(null, { addEventListener: vi.fn() })).not.toThrow();
  });

  it("passes Chrome heap watermarks through when performance.memory exists", () => {
    const t = ensureViewerTelemetry();
    // stub the Chrome-only performance.memory so the read() surfaces it
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 123456, jsHeapSizeLimit: 999999 },
    });
    const renderer: RendererInfoLike = { info: {} };
    const detach = attachViewerTelemetry(renderer, {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const rendererSnaps = t
      .getBundle()
      .snapshots.filter((s) => s.key === "renderer");
    const last = rendererSnaps[rendererSnaps.length - 1];
    expect(last?.data).toMatchObject({
      heapUsedB: 123456,
      heapLimitB: 999999,
    });

    detach();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (performance as any).memory;
  });
});