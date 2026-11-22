import { describe, expect, it } from "vitest";

import { applyCalibration } from "@ff/data/calibration/similarity";

import {
  affineWarnings,
  buildCalibration,
  CalibrationInputError,
  modelToWorld,
  type BaseShift,
} from "../../src/bundle/bundleCalibration";
import { controlPointsFor } from "../../src/bundle/importBundle";
import type { ViewportEntry } from "../../src/bundle/ffbundleTypes";
import { applyAffine, planAffine } from "./fixtures/syntheticBundle";

function cps(affine: number[], pts: Array<[number, number]>) {
  return pts.map(([px, py]) => {
    const m = applyAffine(affine, px, py);
    return { pdfX: px, pdfY: py, modelX: m.x, modelY: m.y };
  });
}

/** Round trip: every PDF point must land on the world position the formula gives. */
function expectRoundTrip(theta: number, base: BaseShift) {
  const affine = planAffine(theta);
  const cal = buildCalibration(
    cps(affine, [
      [100, 100],
      [900, 700],
    ]),
    base,
    affine as never,
  );
  for (const [px, py] of [
    [100, 100],
    [900, 700],
    [500, 40],
    [0, 800],
  ] as Array<[number, number]>) {
    const m = applyAffine(affine, px, py);
    const expected = modelToWorld(m.x, m.y, base);
    const got = applyCalibration(cal.transformParams, { x: px, y: py });
    expect(got.x).toBeCloseTo(expected.x, 6);
    expect(got.z).toBeCloseTo(expected.z, 6);
  }
  return cal;
}

describe("bundleCalibration", () => {
  it("modelToWorld applies worldX = X + bx, worldZ = -Y + bz", () => {
    expect(modelToWorld(10, 20, [1, 2, 3])).toEqual({ x: 11, z: -17 });
  });

  it("unrotated plan, zero shift: rotation 0, scale = metres per point", () => {
    const cal = expectRoundTrip(0, [0, 0, 0]);
    expect(cal.transformParams.rotation).toBeCloseTo(0, 9);
    expect(cal.transformParams.scale).toBeCloseTo((100 * 0.0254) / 72, 9);
    expect(cal.warnings).toEqual([]);
  });

  it("non-zero base shift (b != 0) moves the translation only", () => {
    const a = expectRoundTrip(0, [0, 0, 0]);
    const b = expectRoundTrip(0, [14.29, -6, 7.2]);
    expect(b.transformParams.rotation).toBeCloseTo(a.transformParams.rotation, 9);
    expect(b.transformParams.translateX - a.transformParams.translateX).toBeCloseTo(14.29, 9);
    expect(b.transformParams.translateZ - a.transformParams.translateZ).toBeCloseTo(7.2, 9);
  });

  it("rotated plan round-trips and exposes the rotation", () => {
    const theta = (30 * Math.PI) / 180;
    const cal = expectRoundTrip(theta, [-998.5, -6, 2000.15]);
    // model CCW by theta -> world X/-Y: rotation of -theta in the (X,Z) frame
    expect(Math.abs(cal.transformParams.rotation)).toBeCloseTo(theta, 9);
    expect(cal.pointPairs[0].worldX).toBeCloseTo(cal.pointPairs[0].worldX, 9);
  });

  it("falls back to the viewport crop corners when control points are absent", () => {
    const affine = planAffine(0.2);
    const vp = { pdfToModel: affine, pdfRegion: [10, 20, 300, 400], controlPoints: null } as unknown as ViewportEntry;
    const pts = controlPointsFor(vp)!;
    expect(pts).toHaveLength(2);
    expect(pts[1]!.modelX).toBeCloseTo(applyAffine(affine, 300, 400).x, 9);
  });

  it("rejects missing/coincident control points", () => {
    expect(() => buildCalibration(null, [0, 0, 0])).toThrow(CalibrationInputError);
    const p = { pdfX: 1, pdfY: 1, modelX: 1, modelY: 1 };
    expect(() => buildCalibration([p, { ...p }], [0, 0, 0])).toThrow(/coincide/);
  });

  it("flags mirrored and anisotropic affines", () => {
    expect(affineWarnings(planAffine(0))).toEqual([]);
    const mirrored = planAffine(0);
    mirrored[4] = -mirrored[4];
    expect(affineWarnings(mirrored).join()).toMatch(/mirrored/);
    const aniso = planAffine(0);
    aniso[0] *= 1.5;
    expect(affineWarnings(aniso).join()).toMatch(/not uniform/);
  });
});
