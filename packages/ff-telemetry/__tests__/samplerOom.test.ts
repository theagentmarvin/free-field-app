// §5.4 OOM-prediction closure tests (integration commit 285f43d).
// V1 crossing semantics (geometries >150k / textures >80, once per
// rising crossing) are covered by telemetry.test.ts and stay
// untouched; this file only exercises the NEW dimensions: heap-ratio
// crossing, deviceMemory<=4 texture-threshold halving, and the
// injected onOomRisk sink.

import { describe, expect, it, vi } from "vitest";

import { createTelemetry } from "../src/telemetry";
import {
  startRendererSampler,
  OOM_GEOMETRY_THRESHOLD,
  OOM_TEXTURE_THRESHOLD,
  OOM_HEAP_RATIO_THRESHOLD,
  type RendererRead,
} from "../src/sampler";

function readFrom(sample: RendererRead): () => RendererRead {
  return () => sample;
}

describe("§5.4 heap-ratio crossing", () => {
  it("crosses once at >= 0.85 heap ratio and fires the sink + crumb", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({
        drawCalls: 1,
        triangles: 1,
        geometries: 1,
        textures: 1,
        heapUsedB: Math.ceil(OOM_HEAP_RATIO_THRESHOLD * 1000),
        heapLimitB: 1000,
      }),
      intervalMs: 10,
      onOomRisk: sink,
    });
    // the immediate first tick already crossed; stop before any interval tick
    stop();

    const crumbs = t
      .getBundle()
      .breadcrumbs.filter((b) => b.category === "perf" && b.action === "oom-risk");
    expect(crumbs.length).toBe(1); // immediate tick; crossing edge once
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({
      reason: "heap",
      heapRatio: expect.closeTo(OOM_HEAP_RATIO_THRESHOLD, 5),
    });
  });

  it("stays silent below the ratio", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({ geometries: 1, textures: 1, heapUsedB: 800, heapLimitB: 1000 }),
      intervalMs: 10,
      onOomRisk: sink,
    });
    stop();
    expect(sink).not.toHaveBeenCalled();
    expect(
      t.getBundle().breadcrumbs.filter((b) => b.action === "oom-risk").length,
    ).toBe(0);
  });

  it("missing heap watermarks (iOS/Safari) never cross", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({ geometries: 1, textures: 1 }),
      intervalMs: 10,
      onOomRisk: sink,
    });
    stop();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("§5.4 low-deviceMemory texture threshold halving", () => {
  it("deviceMemory <= 4 GB halves the texture threshold", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({
        geometries: 1,
        textures: OOM_TEXTURE_THRESHOLD / 2 + 10, // 50 — under v1's 80
      }),
      intervalMs: 10,
      deviceMemoryGB: 2,
      onOomRisk: sink,
    });
    stop();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({
      reason: "textures",
      textureThreshold: OOM_TEXTURE_THRESHOLD / 2,
      deviceMemoryGB: 2,
    });
  });

  it("normal-memory device keeps the v1 threshold (50 textures = no crossing)", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({ geometries: 1, textures: OOM_TEXTURE_THRESHOLD / 2 + 10 }),
      intervalMs: 10,
      deviceMemoryGB: 8,
      onOomRisk: sink,
    });
    stop();
    expect(sink).not.toHaveBeenCalled();
  });

  it("v1 geometries crossing still fires and reports both dims", () => {
    const t = createTelemetry();
    const sink = vi.fn();
    const stop = startRendererSampler(t, {
      read: readFrom({ geometries: OOM_GEOMETRY_THRESHOLD + 1, textures: 1 }),
      intervalMs: 10,
      onOomRisk: sink,
    });
    stop();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ reason: "geometries" });
  });

  it("a throwing sink can never break the sampler (survivability)", () => {
    const t = createTelemetry();
    const stop = startRendererSampler(t, {
      read: readFrom({ geometries: OOM_GEOMETRY_THRESHOLD + 1, textures: 1 }),
      intervalMs: 10,
      onOomRisk: () => {
        throw new Error("sink exploded");
      },
    });
    expect(() => stop()).not.toThrow();
    // crumb still landed despite the sink throwing
    expect(
      t.getBundle().breadcrumbs.some((b) => b.category === "perf" && b.action === "oom-risk"),
    ).toBe(true);
  });
});
