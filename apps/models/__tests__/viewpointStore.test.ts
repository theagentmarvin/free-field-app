// apps/models/__tests__/viewpointStore.test.ts
//
// Wave 13 — pure save/restore + serialization logic for 3D saved
// viewpoints. No React, no Dexie: a stubbed IfcViewerHandle is enough
// to prove the capture → encode → decode → restore round-trip.

import { describe, expect, it, vi } from "vitest";

import type { IfcViewerHandle } from "@ff/viewer-react";

import {
  MAX_VIEWPOINTS_PER_PROJECT,
  cameraDirectionFromPose,
  captureViewpointSnapshot,
  decodeViewpointBlob,
  deserializeVisibility,
  encodeViewpointBlob,
  restoreViewpoint,
} from "../src/viewpointStore";

function stubHandle(overrides: Partial<IfcViewerHandle> = {}): IfcViewerHandle {
  return {
    getPose: vi.fn(() => null),
    getSectionPlanes: vi.fn(() => []),
    setViewPose: vi.fn(),
    clearSectionPlanes: vi.fn(),
    addSectionPlane: vi.fn(() => true),
    ...overrides,
  } as unknown as IfcViewerHandle;
}

describe("cameraDirectionFromPose", () => {
  it("returns the normalized (target − eye) direction", () => {
    const dir = cameraDirectionFromPose({
      pos: [0, 0, 10],
      target: [0, 0, 0],
      fov: 45,
      isOrtho: false,
    });
    expect(dir).toEqual({ x: 0, y: 0, z: -1 });
  });

  it("normalizes a diagonal direction", () => {
    const dir = cameraDirectionFromPose({
      pos: [0, 0, 0],
      target: [2, 0, 0],
      fov: 45,
      isOrtho: false,
    });
    expect(dir.x).toBeCloseTo(1);
    expect(dir.y).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(0);
  });

  it("falls back to (0, 0, −1) when pose is null or degenerate", () => {
    expect(cameraDirectionFromPose(null)).toEqual({ x: 0, y: 0, z: -1 });
    expect(
      cameraDirectionFromPose({
        pos: [1, 1, 1],
        target: [1, 1, 1],
        fov: 45,
        isOrtho: false,
      }),
    ).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe("captureViewpointSnapshot", () => {
  it("captures the pose and section planes in order", () => {
    const h = stubHandle({
      getPose: vi.fn(() => ({
        pos: [1, 2, 3] as [number, number, number],
        target: [4, 5, 6] as [number, number, number],
        fov: 50,
        isOrtho: true,
      })),
      getSectionPlanes: vi.fn(() => [
        { point: { x: 1, y: 1, z: 1 }, normal: { x: 0, y: 0, z: -1 } },
        { point: { x: 2, y: 2, z: 2 }, normal: { x: 0, y: -1, z: 0 } },
      ]),
    });

    const snap = captureViewpointSnapshot(h);
    expect(snap.pose).toEqual({
      pos: [1, 2, 3],
      target: [4, 5, 6],
      fov: 50,
      isOrtho: true,
    });
    expect(snap.sectionPlanes).toHaveLength(2);
    expect(snap.sectionPlanes[1].normal).toEqual({ x: 0, y: -1, z: 0 });
  });

  it("captures a null pose when the world is not ready", () => {
    const h = stubHandle({ getPose: vi.fn(() => null) });
    expect(captureViewpointSnapshot(h).pose).toBeNull();
  });
});

describe("restoreViewpoint", () => {
  it("restores the pose then clears + re-adds planes in order", () => {
    const h = stubHandle();
    const order: string[] = [];
    (h.setViewPose as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("pose"),
    );
    (h.clearSectionPlanes as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("clear"),
    );
    (h.addSectionPlane as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("add");
      return true;
    });

    restoreViewpoint(h, {
      pose: {
        pos: [0, 0, 9],
        target: [0, 0, 0],
        fov: 45,
        isOrtho: false,
      },
      sectionPlanes: [
        { point: { x: 1, y: 1, z: 1 }, normal: { x: 0, y: 0, z: -1 } },
        { point: { x: 2, y: 2, z: 2 }, normal: { x: 0, y: -1, z: 0 } },
      ],
    });

    expect(order).toEqual(["pose", "clear", "add", "add"]);
    expect(h.addSectionPlane).toHaveBeenNthCalledWith(
      1,
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 0, z: -1 },
    );
    expect(h.addSectionPlane).toHaveBeenNthCalledWith(
      2,
      { x: 2, y: 2, z: 2 },
      { x: 0, y: -1, z: 0 },
    );
  });

  it("skips the pose when it is null but still clears planes", () => {
    const h = stubHandle();
    restoreViewpoint(h, { pose: null, sectionPlanes: [] });
    expect(h.setViewPose).not.toHaveBeenCalled();
    expect(h.clearSectionPlanes).toHaveBeenCalledTimes(1);
  });
});

describe("viewpoint blob serialization", () => {
  it("round-trips a snapshot through encode/decode", () => {
    const snap = {
      pose: {
        pos: [1, 2, 3] as [number, number, number],
        target: [3, 2, 1] as [number, number, number],
        fov: 45,
        isOrtho: false,
      },
      sectionPlanes: [{ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }],
    };
    expect(
      decodeViewpointBlob(encodeViewpointBlob(snap)),
    ).toEqual(snap);
  });

  it("returns null for malformed blobs", () => {
    expect(decodeViewpointBlob("not-json")).toBeNull();
    expect(decodeViewpointBlob('{"pose":null}')).toBeNull();
    expect(decodeViewpointBlob("42")).toBeNull();
  });

  it("documents the 12-per-project cap constant", () => {
    expect(MAX_VIEWPOINTS_PER_PROJECT).toBe(12);
  });
});
// ── Wave 54 — hide/isolate captured with saved viewpoints ──────────────
describe("wave 54 — visibility in viewpoints", () => {
  it("capture serializes the manual overlay (Maps/Sets → arrays)", () => {
    const h = stubHandle();
    const snap = captureViewpointSnapshot(h, {
      hidden: new Map([["m1", new Set([1, 2])]]),
      isolate: { visible: new Map([["m2", new Set([5])]]) },
    });
    expect(snap.visibility).toEqual({
      hidden: [{ modelId: "m1", ids: [1, 2] }],
      isolate: { visible: [{ modelId: "m2", ids: [5] }] },
    });
  });

  it("capture with no/empty overlay yields null visibility", () => {
    const h = stubHandle();
    expect(captureViewpointSnapshot(h).visibility).toBeNull();
    expect(
      captureViewpointSnapshot(h, { hidden: new Map(), isolate: null }).visibility,
    ).toBeNull();
  });

  it("visibility round-trips through encode/decode", () => {
    const h = stubHandle();
    const snap = captureViewpointSnapshot(h, {
      hidden: new Map([["m1", new Set([7])]]),
      isolate: null,
    });
    const decoded = decodeViewpointBlob(encodeViewpointBlob(snap));
    expect(decoded?.visibility).toEqual({
      hidden: [{ modelId: "m1", ids: [7] }],
      isolate: null,
    });
  });

  it("legacy blobs without visibility decode with visibility absent", () => {
    const legacy = JSON.stringify({ pose: null, sectionPlanes: [] });
    expect(decodeViewpointBlob(legacy)?.visibility).toBeUndefined();
  });

  it("a clean view (visibility: null) round-trips as null (wave 63)", () => {
    const snap = captureViewpointSnapshot(stubHandle(), {
      hidden: new Map(),
      isolate: null,
    });
    expect(decodeViewpointBlob(encodeViewpointBlob(snap))?.visibility).toBeNull();
  });

  it("restoring a clean view applies null so hidden elements come back (wave 63)", () => {
    const apply = vi.fn();
    restoreViewpoint(
      stubHandle(),
      { pose: null, sectionPlanes: [], visibility: null },
      apply,
    );
    expect(apply).toHaveBeenCalledWith(null);
  });

  it("restore applies visibility AFTER geometry when provided", () => {
    const h = stubHandle();
    const order: string[] = [];
    (h.clearSectionPlanes as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("clear"),
    );
    (h.addSectionPlane as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push("add");
      return true;
    });
    const apply = vi.fn(() => order.push("visibility"));
    restoreViewpoint(
      h,
      {
        pose: null,
        sectionPlanes: [{ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } }],
        visibility: { hidden: [{ modelId: "m1", ids: [3] }], isolate: null },
      },
      apply,
    );
    expect(order).toEqual(["clear", "add", "visibility"]);
    expect(apply).toHaveBeenCalledWith({
      hidden: [{ modelId: "m1", ids: [3] }],
      isolate: null,
    });
  });

  it("restore without visibility (legacy) never calls applyVisibility", () => {
    const h = stubHandle();
    const apply = vi.fn();
    restoreViewpoint(h, { pose: null, sectionPlanes: [] }, apply);
    expect(apply).not.toHaveBeenCalled();
  });

  it("deserializeVisibility rebuilds the store's Map/Set shape", () => {
    const out = deserializeVisibility({
      hidden: [{ modelId: "m1", ids: [1, 2] }],
      isolate: { visible: [{ modelId: "m2", ids: [9] }] },
    });
    expect(out.hidden.get("m1")).toEqual(new Set([1, 2]));
    expect(out.isolate?.visible.get("m2")).toEqual(new Set([9]));
    expect(deserializeVisibility({ hidden: [], isolate: null }).isolate).toBeNull();
  });
});
