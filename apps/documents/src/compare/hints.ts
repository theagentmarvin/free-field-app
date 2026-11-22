// Pure helpers for result hints shown in the panel.

import type { CompareResult } from "./types";

export const MISALIGNED_TOTAL_FRACTION = 0.4;
export const MISALIGNED_SINGLE_FRACTION = 0.5;
export const MISALIGNED_MESSAGE = "Drawings look misaligned — turn on Auto-align or adjust the nudge";

/**
 * True when auto-align is off and the changes cover more than 40 % of the
 * page area (sum of region boxes) or one region covers more than 50 %.
 */
export function looksMisaligned(
  result: Pick<CompareResult, "regions" | "pageWidthPt" | "pageHeightPt">,
  autoAlign: boolean,
): boolean {
  if (autoAlign) return false;
  const page = result.pageWidthPt * result.pageHeightPt;
  if (!(page > 0) || result.regions.length === 0) return false;
  let total = 0;
  for (const r of result.regions) {
    const a = r.bbox.w * r.bbox.h;
    if (a / page > MISALIGNED_SINGLE_FRACTION) return true;
    total += a;
  }
  return total / page > MISALIGNED_TOTAL_FRACTION;
}
