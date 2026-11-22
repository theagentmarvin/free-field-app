// Sensitivity presets -> low-level DiffThresholds.
// Spec: docs/specs/documents-compare-revisions.md ("Presets").

import type {
  CompareSettings,
  DiffThresholds,
  SensitivityPreset,
} from "../types";

type PresetValues = Pick<
  DiffThresholds,
  "colorThreshold" | "proximityPx" | "gridSize" | "minPixelsPerCell"
>;

export const PRESET_VALUES: Record<SensitivityPreset, PresetValues> = {
  vector: { colorThreshold: 48, proximityPx: 1, gridSize: 16, minPixelsPerCell: 6 },
  scanned: { colorThreshold: 80, proximityPx: 2, gridSize: 24, minPixelsPerCell: 20 },
  fine: { colorThreshold: 32, proximityPx: 0, gridSize: 8, minPixelsPerCell: 3 },
};

/** Default cell distance within which flagged components are merged. */
export const DEFAULT_MERGE_DISTANCE = 1;

export function resolveThresholds(settings: CompareSettings): DiffThresholds {
  const preset = PRESET_VALUES[settings.preset] ?? PRESET_VALUES.vector;
  const base: DiffThresholds = {
    ...preset,
    mergeDistance: DEFAULT_MERGE_DISTANCE,
    marginPx: settings.marginPx,
  };
  const overrides = settings.thresholds ?? {};
  const out = { ...base };
  for (const key of Object.keys(overrides) as (keyof DiffThresholds)[]) {
    const v = overrides[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}
