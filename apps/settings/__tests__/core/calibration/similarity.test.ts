// __tests__/core/calibration/similarity.test.ts
//
// Unit tests for the 2D similarity-transform math. The fixtures
// are hand-calculated so a regression in the math would produce
// an obviously-wrong number (we don't fuzz — the test is about
// locking the formula, not about finding edge cases).

import { describe, expect, it } from "vitest";

import {
  applyCalibration,
  calibrationResidual,
  computeSimilarityTransform,
  invertCalibration,
} from "@ff/data/calibration/similarity";

describe("computeSimilarityTransform", () => {
  it("identity transform: same unit, no rotation, no translation", () => {
    // pdfA (0,0) → worldA (0,0), pdfB (1,0) → worldB (1,0)
    // Both unit vectors, both aligned with the +X axis, both
    // anchored at the origin. The transform should be the
    // identity (scale=1, rotation=0, no translation).
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    );
    expect(params.scale).toBeCloseTo(1, 10);
    expect(params.rotation).toBeCloseTo(0, 10);
    expect(params.translateX).toBeCloseTo(0, 10);
    expect(params.translateZ).toBeCloseTo(0, 10);
  });

  it("uniform scale 2× (no rotation, no translation)", () => {
    // pdfA (0,0) → worldA (0,0), pdfB (3,0) → worldB (6,0)
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, z: 0 },
      { x: 6, z: 0 },
    );
    expect(params.scale).toBeCloseTo(2, 10);
    expect(params.rotation).toBeCloseTo(0, 10);
    expect(params.translateX).toBeCloseTo(0, 10);
    expect(params.translateZ).toBeCloseTo(0, 10);
  });

  it("rotation 90° (no scale, no translation)", () => {
    // pdfA (0,0) → worldA (0,0), pdfB (1,0) → worldB (0,1)
    // In our convention, PDF +X maps to world +Z when rotated
    // 90° clockwise (atan2(0,1) = 0, atan2(1,0) = π/2).
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, z: 0 },
      { x: 0, z: 1 },
    );
    expect(params.scale).toBeCloseTo(1, 10);
    expect(params.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(params.translateX).toBeCloseTo(0, 10);
    expect(params.translateZ).toBeCloseTo(0, 10);
  });

  it("pure translation (no scale, no rotation)", () => {
    // pdfA (0,0) → worldA (10,5), pdfB (1,0) → worldB (11,5)
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 10, z: 5 },
      { x: 11, z: 5 },
    );
    expect(params.scale).toBeCloseTo(1, 10);
    expect(params.rotation).toBeCloseTo(0, 10);
    expect(params.translateX).toBeCloseTo(10, 10);
    expect(params.translateZ).toBeCloseTo(5, 10);
  });

  it("compound: scale 2× + rotate 90° + translate (10, 5)", () => {
    // pdfA (0,0) → worldA (10,5), pdfB (3,0) → worldB (10,11)
    // The PDF unit vector (3,0) (length 3) maps to a world
    // vector of length 6 rotated 90° (i.e. (0,6)). Adding the
    // translation (10,5) gives (10, 11). ✓
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 10, z: 5 },
      { x: 10, z: 11 },
    );
    expect(params.scale).toBeCloseTo(2, 10);
    expect(params.rotation).toBeCloseTo(Math.PI / 2, 10);
    expect(params.translateX).toBeCloseTo(10, 10);
    expect(params.translateZ).toBeCloseTo(5, 10);
  });

  it("round-trip: forward map reproduces the input pairs", () => {
    // Build a transform from a non-trivial case, then verify
    // that `applyCalibration(params, pdfA)` lands on worldA and
    // same for B. The two pairs uniquely fix the transform, so
    // the residuals must be exactly zero.
    const params = computeSimilarityTransform(
      { x: 5, y: 10 },
      { x: 25, y: 10 },
      { x: -3, z: 7 },
      { x: 37, z: 7 },
    );
    const a = applyCalibration(params, { x: 5, y: 10 });
    const b = applyCalibration(params, { x: 25, y: 10 });
    expect(a.x).toBeCloseTo(-3, 10);
    expect(a.z).toBeCloseTo(7, 10);
    expect(b.x).toBeCloseTo(37, 10);
    expect(b.z).toBeCloseTo(7, 10);
  });

  it("throws when the two PDF points coincide", () => {
    // The basis vector is zero — scale and rotation are
    // undefined. The wizard UI should prevent this case, but
    // we defend here so a stray call doesn't silently produce
    // NaN/Infinity.
    expect(() =>
      computeSimilarityTransform(
        { x: 1, y: 1 },
        { x: 1, y: 1 },
        { x: 0, z: 0 },
        { x: 1, z: 1 },
      ),
    ).toThrow(/coincide/i);
  });
});

describe("applyCalibration", () => {
  it("applies the identity transform (scale=1, rot=0, translate=0,0)", () => {
    const out = applyCalibration(
      { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
      { x: 5, y: 7 },
    );
    expect(out).toEqual({ x: 5, z: 7 });
  });

  it("applies a uniform scale 2×", () => {
    const out = applyCalibration(
      { scale: 2, rotation: 0, translateX: 0, translateZ: 0 },
      { x: 3, y: -4 },
    );
    expect(out).toEqual({ x: 6, z: -8 });
  });

  it("applies a 90° rotation (PDF +X → world +Z)", () => {
    const out = applyCalibration(
      { scale: 1, rotation: Math.PI / 2, translateX: 0, translateZ: 0 },
      { x: 1, y: 0 },
    );
    expect(out.x).toBeCloseTo(0, 10);
    expect(out.z).toBeCloseTo(1, 10);
  });

  it("combines scale + rotation + translation", () => {
    const out = applyCalibration(
      {
        scale: 2,
        rotation: Math.PI / 2,
        translateX: 10,
        translateZ: 5,
      },
      { x: 3, y: 0 },
    );
    // (3,0) → after scale+rot → (0,6) → after translate → (10,11)
    expect(out.x).toBeCloseTo(10, 10);
    expect(out.z).toBeCloseTo(11, 10);
  });
});

describe("invertCalibration", () => {
  it("inverts the identity transform", () => {
    const params = { scale: 1, rotation: 0, translateX: 0, translateZ: 0 };
    const out = invertCalibration(params, { x: 5, z: 7 });
    expect(out).toEqual({ x: 5, y: 7 });
  });

  it("round-trip identity: invert(apply(p)) === p", () => {
    const params = {
      scale: 3,
      rotation: Math.PI / 3,
      translateX: -2,
      translateZ: 4,
    };
    const pdf = { x: 7, y: 11 };
    const world = applyCalibration(params, pdf);
    const back = invertCalibration(params, world);
    expect(back.x).toBeCloseTo(pdf.x, 10);
    expect(back.y).toBeCloseTo(pdf.y, 10);
  });

  it("throws when scale is zero (non-invertible)", () => {
    expect(() =>
      invertCalibration(
        { scale: 0, rotation: 0, translateX: 0, translateZ: 0 },
        { x: 1, z: 1 },
      ),
    ).toThrow(/scale is zero/i);
  });
});

describe("calibrationResidual", () => {
  it("is 0 for the 2-point case (the transform is exact)", () => {
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 0, z: 0 },
      { x: 10, z: 0 },
    );
    const residual = calibrationResidual(params, [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 5, pdfY: 0, worldX: 10, worldZ: 0 },
    ]);
    expect(residual).toBeCloseTo(0, 10);
  });

  it("returns 0 for an empty pair list (no points = no error)", () => {
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    );
    expect(calibrationResidual(params, [])).toBe(0);
  });

  it("returns a non-negative number for a 3-point list (future 3+ point use)", () => {
    // The function is shape-correct for n>=3. The 2-point
    // MVP always feeds 2 pairs (residual 0 by definition),
    // so this test only pins the contract that "give it 3
    // pairs and you get a non-negative number back".
    const params = computeSimilarityTransform(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    );
    const residual = calibrationResidual(params, [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 0, worldX: 1, worldZ: 0 },
      { pdfX: 0.5, pdfY: 0.5, worldX: 0.5, worldZ: 0.5 },
    ]);
    expect(typeof residual).toBe("number");
    expect(Number.isFinite(residual)).toBe(true);
    expect(residual).toBeGreaterThanOrEqual(0);
  });
});
