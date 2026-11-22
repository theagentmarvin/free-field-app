// computeOverlayPlacement: the overlay uses the FULL similarity transform
// (rotation included), not the corner AABB.
import { describe, expect, it } from "vitest";

import { applyCalibration, computeSimilarityTransform } from "@ff/data/calibration/similarity";

import { computeOverlayPlacement } from "../../src/hooks/useFloorPlanOverlay";

describe("computeOverlayPlacement", () => {
  it("equals the corner AABB when rotation is 0", () => {
    const params = { scale: 0.05, rotation: 0, translateX: 3, translateZ: -2 };
    const { worldBounds, rotation } = computeOverlayPlacement(params, 1000, 800);
    expect(rotation).toBe(0);
    expect(worldBounds.minX).toBeCloseTo(3, 9);
    expect(worldBounds.maxX).toBeCloseTo(53, 9);
    expect(worldBounds.minZ).toBeCloseTo(-2, 9);
    expect(worldBounds.maxZ).toBeCloseTo(38, 9);
  });

  it("keeps scale*size extents and the page-centre image when rotated", () => {
    const params = computeSimilarityTransform(
      { x: 100, y: 100 },
      { x: 900, y: 700 },
      { x: 10, z: 5 },
      { x: 10 + 30, z: 5 + 28 },
    );
    expect(Math.abs(params.rotation)).toBeGreaterThan(0.01);
    const { worldBounds, rotation } = computeOverlayPlacement(params, 1000, 800);
    expect(rotation).toBe(params.rotation);
    expect(worldBounds.maxX - worldBounds.minX).toBeCloseTo(params.scale * 1000, 9);
    expect(worldBounds.maxZ - worldBounds.minZ).toBeCloseTo(params.scale * 800, 9);
    const c = applyCalibration(params, { x: 500, y: 400 });
    expect((worldBounds.minX + worldBounds.maxX) / 2).toBeCloseTo(c.x, 9);
    expect((worldBounds.minZ + worldBounds.maxZ) / 2).toBeCloseTo(c.z, 9);
  });
});
