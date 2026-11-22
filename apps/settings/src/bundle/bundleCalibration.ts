// src/bundle/bundleCalibration.ts
//
// Pure conversion of a bundle viewport's two control points into a
// FreeField calibration.
//
//   bundle model space : IFC world, Z-up, metres  (modelX, modelY)
//   FreeField world    : worldX = modelX + bx
//                        worldZ = -modelY + bz
//                        worldY = modelZ + by
//   where b = getCoordinates()[0..2] of the building's base model.
//
// The Y negation removes the reflection between PDF (y down) and the
// model (y up), so the mapping is a proper similarity that
// `computeSimilarityTransform` can represent.

import { computeSimilarityTransform } from "@ff/data/calibration/similarity";
import type { CalibrationPointPair, CalibrationTransformParams } from "@ff/types";

import type { ControlPoint } from "./ffbundleTypes";

/** Coordinate shift of the building's base model: [bx, by, bz]. */
export type BaseShift = readonly [number, number, number];

export interface BundleCalibration {
  pointPairs: [CalibrationPointPair, CalibrationPointPair];
  transformParams: CalibrationTransformParams;
  warnings: string[];
}

export function modelToWorld(
  modelX: number,
  modelY: number,
  base: BaseShift,
): { x: number; z: number } {
  return { x: modelX + base[0], z: -modelY + base[2] };
}

export class CalibrationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationInputError";
  }
}

/** Mirrored/anisotropic pages are flagged, not rejected. */
const SCALE_TOLERANCE = 1e-3;

/**
 * Build the calibration for a viewport's control points.
 * Throws `CalibrationInputError` when the points cannot define one.
 */
export function buildCalibration(
  controlPoints: readonly ControlPoint[] | null | undefined,
  base: BaseShift,
  affine?: readonly [number, number, number, number, number, number] | null,
): BundleCalibration {
  if (!controlPoints || controlPoints.length < 2) {
    throw new CalibrationInputError("viewport has fewer than two control points");
  }
  const [a, b] = [controlPoints[0]!, controlPoints[1]!];
  if (a.pdfX === b.pdfX && a.pdfY === b.pdfY) {
    throw new CalibrationInputError("control points coincide on the page");
  }
  const wa = modelToWorld(a.modelX, a.modelY, base);
  const wb = modelToWorld(b.modelX, b.modelY, base);
  const transformParams = computeSimilarityTransform(
    { x: a.pdfX, y: a.pdfY },
    { x: b.pdfX, y: b.pdfY },
    wa,
    wb,
  );
  if (!(transformParams.scale > 0)) {
    throw new CalibrationInputError("control points map to the same model position");
  }
  // A mirrored or anisotropic page cannot be represented by a similarity: the two
  // control points would fit but everything else would be mirrored / skewed.
  const problems = affine ? affineWarnings(affine) : [];
  if (problems.length > 0) throw new CalibrationInputError(problems.join("; "));
  const warnings: string[] = [];
  return {
    pointPairs: [
      { pdfX: a.pdfX, pdfY: a.pdfY, worldX: wa.x, worldZ: wa.z },
      { pdfX: b.pdfX, pdfY: b.pdfY, worldX: wb.x, worldZ: wb.z },
    ],
    transformParams,
    warnings,
  };
}

/**
 * Check the viewport's affine for a mirrored or anisotropic page
 * (what a two-point similarity cannot express). Returns warnings.
 * `affine` = [a,b,c,d,e,f] with modelX = a*px+b*py+c, modelY = d*px+e*py+f.
 */
export function affineWarnings(
  affine: readonly [number, number, number, number, number, number],
): string[] {
  const [a, b, , d, e] = affine;
  // pdf -> (X, -Y): rows (a,b) and (-d,-e). Proper similarity has det > 0
  // and equal column norms.
  const det = a * -e - b * -d;
  const out: string[] = [];
  if (!(det > 0)) out.push("page appears mirrored in the model (determinant <= 0)");
  const sx = Math.hypot(a, d);
  const sy = Math.hypot(b, e);
  const s = Math.max(sx, sy);
  if (s > 0 && Math.abs(sx - sy) / s > SCALE_TOLERANCE) {
    out.push("page scale is not uniform; calibration uses the control-point distance");
  }
  return out;
}
