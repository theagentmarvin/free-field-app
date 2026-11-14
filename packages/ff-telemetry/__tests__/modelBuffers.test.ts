import { describe, it, expect } from "vitest";

import {
  createModelBuffers,
  getRendererReport,
  type RendererInfoLike,
} from "../src/modelBuffers";

describe("createModelBuffers", () => {
  it("opens/records/closes per modelId with a capacity-2 ring", () => {
    const mb = createModelBuffers(2);
    expect(mb.has("m1")).toBe(false);
    mb.open("m1");
    expect(mb.has("m1")).toBe(true);

    mb.record("m1", {
      drawCalls: 10,
      triangles: 1000,
      geometries: 500,
      textures: 2,
      frameEmaMs: 16.7,
      frameMaxMs: 22.1,
      heapUsedB: 123,
      heapLimitB: 999,
    });
    mb.record("m1", { drawCalls: 11, triangles: 1100, geometries: 501, textures: 2 });
    mb.record("m1", { drawCalls: 12, triangles: 1200, geometries: 502, textures: 3 });

    const reports = mb.get("m1");
    expect(reports).toHaveLength(2); // oldest (10) dropped
    expect(reports?.[0].drawCalls).toBe(11);
    expect(reports?.[1].drawCalls).toBe(12);
    // missing fields normalized to 0
    expect(reports?.[1].textures).toBe(3);
    expect(reports?.[1].heapUsedB).toBe(0);

    mb.close("m1");
    expect(mb.has("m1")).toBe(false);
    expect(mb.get("m1")).toBeUndefined();
  });

  it("record into an unopened/closed model is a no-op (no leak, no throw)", () => {
    const mb = createModelBuffers();
    expect(() => mb.record("ghost", { drawCalls: 1 })).not.toThrow();
    expect(mb.get("ghost")).toBeUndefined();

    mb.open("m");
    mb.close("m");
    mb.record("m", { drawCalls: 1 });
    expect(mb.get("m")).toBeUndefined();
  });

  it("open→close→open same modelId starts a fresh buffer (§9 risk 3)", () => {
    const mb = createModelBuffers(2);
    mb.open("m");
    mb.record("m", { drawCalls: 1 });
    mb.close("m");
    mb.open("m");
    // stale report must NOT bleed into the reopened buffer
    expect(mb.get("m")).toEqual([]);
    mb.record("m", { drawCalls: 2 });
    const reports = mb.get("m");
    expect(reports).toHaveLength(1);
    expect(reports?.[0].drawCalls).toBe(2);
  });

  it("normalizes garbage input defensively (never throws)", () => {
    const mb = createModelBuffers();
    mb.open("m");
    expect(() => mb.record("m", undefined as unknown as RendererInfoLike)).not.toThrow();
    const reports = mb.get("m");
    expect(reports?.[0]).toMatchObject({
      drawCalls: 0,
      triangles: 0,
      geometries: 0,
      textures: 0,
      frameEmaMs: 0,
      frameMaxMs: 0,
      heapUsedB: 0,
      heapLimitB: 0,
    });
  });
});

describe("getRendererReport (byte-stable)", () => {
  it("renders header + (Latest) marker + snapshots, deterministically", () => {
    const mb = createModelBuffers(2);
    mb.open("zmodel");
    mb.open("amodel");
    mb.record("amodel", {
      drawCalls: 10,
      triangles: 1000,
      geometries: 500,
      textures: 2,
      frameEmaMs: 16.6667,
      frameMaxMs: 22,
      heapUsedB: 123,
      heapLimitB: 999,
    });
    mb.record("zmodel", {
      drawCalls: 20,
      triangles: 2000,
      geometries: 600,
      textures: 4,
      frameEmaMs: 16.7,
      frameMaxMs: 30,
      heapUsedB: 456,
      heapLimitB: 1024,
    });
    mb.record("zmodel", {
      drawCalls: 21,
      triangles: 2100,
      geometries: 601,
      textures: 4,
      frameEmaMs: 17.1,
      frameMaxMs: 25,
      heapUsedB: 500,
      heapLimitB: 1024,
    });

    const report = getRendererReport({
      deviceLostCount: 2,
      buffers: mb,
      snapshots: [
        { ts: 999_999, key: "renderer", data: { drawCalls: 5, frameEmaMs: 16.7 } },
        { ts: 999_999, key: "renderer:amodel", data: { drawCalls: 10 } },
      ],
    });

    expect(report).toBe(
      [
        "Lost device: 2 times / Active views: 2",
        "",
        "model:amodel",
        "[0] (Latest) drawCalls=10 triangles=1000 geometries=500 textures=2 frameEmaMs=16.67 frameMaxMs=22.00 heapUsed=123/999",
        "",
        "model:zmodel",
        "[0] drawCalls=20 triangles=2000 geometries=600 textures=4 frameEmaMs=16.70 frameMaxMs=30.00 heapUsed=456/1024",
        "[1] (Latest) drawCalls=21 triangles=2100 geometries=601 textures=4 frameEmaMs=17.10 frameMaxMs=25.00 heapUsed=500/1024",
        "",
        "snapshots:",
        '  renderer: {"drawCalls":5,"frameEmaMs":16.7}',
        '  renderer:amodel: {"drawCalls":10}',
      ].join("\n"),
    );
  });

  it("renders a header with zero buffers + no snapshots (still byte-stable)", () => {
    const report = getRendererReport({
      deviceLostCount: 0,
      buffers: createModelBuffers(),
      snapshots: [],
    });
    expect(report).toBe(
      ["Lost device: 0 times / Active views: 0", "", "snapshots:"].join("\n"),
    );
  });
});