// src/core/calibration/similarity.ts
//
// Pure 2D similarity-transform math for the calibration wizard.
// No DOM, no React, no OBC, no THREE — these functions are unit
// testable in plain Node and are the single source of truth for
// the forward / inverse map between PDF page coords (in points)
// and 3D world floor-plan coords (X-Z plane).
//
// The transform is the standard 2D similarity:
//
//   world = scale * R(rotation) * pdf + translation
//
// where R(θ) is the 2D rotation matrix. 4 DOF: scale, rotation,
// translateX, translateZ. Two point pairs uniquely fix those four
// unknowns — the math in `computeSimilarityTransform` solves
// them analytically.
//
// Conventions (locked with Maintainer 2026-06-02):
//   - PDF origin is top-left, y-down (PDF.js convention).
//   - World origin is the OBC.Views plan view origin (varies
//     per model but always X-Z plane, Y is up).
//   - We map PDF (x, y) → world (X, Z). The PDF's y maps to
//     the world's Z axis (so a "right-side-up" PDF aligns with
//     a "looking-down-at-the-plan" 3D view). A future
//     calibration can add a y-flip if a particular PDF is
//     upside-down — that's why the math is parameterized by
//     `rotation` alone, not constrained to multiples of 90°.

import type {
  CalibrationPointPair,
  CalibrationTransformParams,
} from "@ff/types";

/**
 * 2D point in PDF page coords (in points, y-down).
 * Aliased for readability — same as the inline `{x, y}` shape
 * that the wizard's PdfOverlay click handler reports.
 */
export interface PdfPoint {
  x: number;
  y: number;
}

/** 2D point in world floor-plan coords (X-Z plane, Y is up). */
export interface WorldPoint {
  x: number;
  z: number;
}

/**
 * Compute the 2D similarity transform that maps
 * (pdfA → worldA) and (pdfB → worldB).
 *
 * The transform is:
 *   world = scale * R(θ) * pdf + translation
 *
 *   where R(θ) = [cosθ, -sinθ; sinθ, cosθ].
 *
 * Four unknowns (scale, θ, translateX, translateZ), four
 * equations (the two point pairs), unique solution.
 *
 * Returns the transform in `CalibrationTransformParams` shape.
 * Throws if the two PDF points coincide (the scale and rotation
 * become singular). Caller should guard against that in the
 * UI — the wizard's status bar should surface the hint
 * "Pick a different point" before the user gets here.
 */
export function computeSimilarityTransform(
  pdfA: PdfPoint,
  pdfB: PdfPoint,
  worldA: WorldPoint,
  worldB: WorldPoint,
): CalibrationTransformParams {
  // Vector form. The two pairs give us the PDF-basis vectors
  // and the world-basis vectors. The transform is the one
  // that maps the former to the latter.
  const pdfDx = pdfB.x - pdfA.x;
  const pdfDy = pdfB.y - pdfA.y;
  const worldDx = worldB.x - worldA.x;
  const worldDz = worldB.z - worldA.z;

  // Lengths of the basis vectors. If the two PDF points
  // coincide, the basis vector is zero and the rotation /
  // scale is undefined. The wizard UI should prevent this
  // case (the user has to click two distinct points), but
  // we defend here so a stray call doesn't silently produce
  // NaN.
  const pdfLen = Math.hypot(pdfDx, pdfDy);
  if (pdfLen === 0) {
    throw new Error(
      "computeSimilarityTransform: PDF points coincide — cannot determine scale or rotation",
    );
  }
  const worldLen = Math.hypot(worldDx, worldDz);

  // Scale = world-length / pdf-length. Sign convention: we
  // always emit a non-negative scale. The rotation absorbs the
  // sign (a 180° flip is a rotation, not a negative scale).
  const scale = worldLen / pdfLen;

  // The basis vectors after the rotation step (without
  // scale) must point the same way. R(θ) * (pdfDx, pdfDy) is
  // a unit-vector times `pdfLen`, but we can compute θ as
  // the signed angle from the PDF basis to the world basis.
  //
  //   θ_pdf = atan2(pdfDy, pdfDx)   (angle in PDF coords)
  //   θ_world = atan2(worldDz, worldDx) (angle in world coords)
  //   rotation = θ_world - θ_pdf
  //
  // The sign comes from atan2's convention (y-down for PDF
  // matches our z-down choice for the world plane — both are
  // "rotate the cursor 90° clockwise" from a math textbook).
  const thetaPdf = Math.atan2(pdfDy, pdfDx);
  const thetaWorld = Math.atan2(worldDz, worldDx);
  const rotation = thetaWorld - thetaPdf;

  // Translation: pick the A point. After rotation+scale, the
  // PDF point would land at (scale * R * pdfA). We translate
  // by (worldA - that).
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rotatedAx = scale * (cos * pdfA.x - sin * pdfA.y);
  const rotatedAz = scale * (sin * pdfA.x + cos * pdfA.y);
  const translateX = worldA.x - rotatedAx;
  const translateZ = worldA.z - rotatedAz;

  return { scale, rotation, translateX, translateZ };
}

/**
 * Apply the transform to a PDF point. Returns the world (X, Z).
 * Forward map (PDF → world).
 */
export function applyCalibration(
  params: CalibrationTransformParams,
  pdf: PdfPoint,
): WorldPoint {
  const { scale, rotation, translateX, translateZ } = params;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: scale * (cos * pdf.x - sin * pdf.y) + translateX,
    z: scale * (sin * pdf.x + cos * pdf.y) + translateZ,
  };
}

/**
 * Inverse map (world → PDF). Useful for hit-testing a 3D world
 * point against a PDF point — e.g. projecting a tapped 3D point
 * back into PDF page coords so we can draw a marker on the
 * overlay. The wizard doesn't use this in MVP (the 3D marker is
 * the screen-space SVG line, not a PDF-anchored glyph) but the
 * math is trivial and the test suite locks the round-trip
 * identity: apply(inverse(x)) === x.
 */
export function invertCalibration(
  params: CalibrationTransformParams,
  world: WorldPoint,
): PdfPoint {
  const { scale, rotation, translateX, translateZ } = params;
  if (scale === 0) {
    throw new Error("invertCalibration: scale is zero (non-invertible)");
  }
  // Translate, then rotate+scale inverse.
  const dx = world.x - translateX;
  const dz = world.z - translateZ;
  // Inverse rotation: -θ. cos(-θ) = cos(θ), sin(-θ) = -sin(θ).
  // Inverse scale: 1/scale.
  const invScale = 1 / scale;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: invScale * (cos * dx + sin * dz),
    y: invScale * (-sin * dx + cos * dz),
  };
}

/**
 * Compute the RMS residual between the point pairs after applying
 * the transform. For a 2-point calibration, this is always 0
 * (the transform is exact for both pairs). The function exists
 * so a future 3+ point fit can report a confidence score without
 * a schema change (the `confidence` field on CalibrationRecord
 * will become meaningful in that world).
 *
 * `pairs` may be 2 or more points. We accept an array (not a
 * tuple) so the call site can use the same function for both
 * the 2-point MVP and the future N-point case.
 */
export function calibrationResidual(
  params: CalibrationTransformParams,
  pairs: CalibrationPointPair[],
): number {
  if (pairs.length === 0) return 0;
  let sumSq = 0;
  for (const p of pairs) {
    const predicted = applyCalibration(params, { x: p.pdfX, y: p.pdfY });
    const dx = predicted.x - p.worldX;
    const dz = predicted.z - p.worldZ;
    sumSq += dx * dx + dz * dz;
  }
  return Math.sqrt(sumSq / pairs.length);
}
