// Label formatting. Never shows metres for an uncalibrated page.

import type { PageScale } from "./scale";

export function formatLength(units: number, scale: PageScale): string {
  if (scale.metresPerUnit === null) return `${units.toFixed(1)} pt`;
  const m = units * scale.metresPerUnit;
  if (m >= 1) return `${m.toFixed(2)} m`;
  if (m >= 0.01) return `${(m * 100).toFixed(1)} cm`;
  return `${(m * 1000).toFixed(0)} mm`;
}

export function formatArea(unitsSq: number, scale: PageScale): string {
  if (scale.metresPerUnit === null) return `${Math.round(unitsSq)} pt²`;
  const m2 = unitsSq * scale.metresPerUnit * scale.metresPerUnit;
  return `${m2.toFixed(2)} m²`;
}

export function scaleBadgeText(scale: PageScale): string {
  switch (scale.source) {
    case "calibrated":
      return "Scale: calibrated";
    case "manual":
      return "Scale: manual";
    default:
      return "Uncalibrated (page units)";
  }
}
