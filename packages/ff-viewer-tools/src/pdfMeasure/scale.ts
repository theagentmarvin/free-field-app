// Real-world scale for a PDF page. Pure.

import { distance, type Point } from "./geometry";

export type ScaleSource = "calibrated" | "manual" | "none";

export interface PageScale {
  source: ScaleSource;
  /** Metres per page unit (PDF point); null when uncalibrated. */
  metresPerUnit: number | null;
}

export const UNCALIBRATED: PageScale = { source: "none", metresPerUnit: null };

export type LengthUnit = "m" | "cm" | "mm" | "ft" | "in";

const METRES_PER: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
};

export function toMetres(value: number, unit: LengthUnit): number {
  return value * METRES_PER[unit];
}

function validMpu(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * The similarity transform's `scale` is world-units (model metres) per
 * PDF point, so metres-per-unit is the scale itself. Rotation and
 * translation do not affect distances.
 */
export function scaleFromCalibration(
  params: { scale: number } | null | undefined,
): PageScale {
  if (params && validMpu(params.scale)) {
    return { source: "calibrated", metresPerUnit: params.scale };
  }
  return UNCALIBRATED;
}

/** Scale from two picked page points and the real length between them. */
export function scaleFromTwoPoints(
  a: Point,
  b: Point,
  knownMetres: number,
): PageScale | null {
  const d = distance(a, b);
  if (!(d > 0) || !validMpu(knownMetres)) return null;
  return { source: "manual", metresPerUnit: knownMetres / d };
}

/**
 * Pick the scale for a page. A user-set manual scale wins; otherwise the
 * calibration applies to page 1 only (that is the sheet calibrations are
 * defined on); everything else is uncalibrated.
 */
export function resolvePageScale(args: {
  page: number;
  manualMetresPerUnit?: number | null;
  calibrationMetresPerUnit?: number | null;
}): PageScale {
  if (validMpu(args.manualMetresPerUnit)) {
    return { source: "manual", metresPerUnit: args.manualMetresPerUnit };
  }
  if (args.page === 1 && validMpu(args.calibrationMetresPerUnit)) {
    return { source: "calibrated", metresPerUnit: args.calibrationMetresPerUnit };
  }
  return UNCALIBRATED;
}

/** Latest-updated calibration row for the project, or null. */
export function pickCalibrationScale(
  rows: readonly {
    projectId: string;
    updatedAt: number;
    transformParams: { scale: number };
  }[],
  projectId: string | null | undefined,
): number | null {
  if (!projectId) return null;
  let best: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (r.projectId !== projectId) continue;
    if (!validMpu(r.transformParams?.scale)) continue;
    if (!best || r.updatedAt > best.updatedAt) best = r;
  }
  return best ? best.transformParams.scale : null;
}
