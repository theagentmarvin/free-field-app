// packages/ff-viewer-react/src/measure/measureFormat.ts
//
// Wave 67: display formatting shared by the toolbar readout, the
// measurements list and (via the handle) anything that shows a value.
// Pure, no engine imports.

/** One of the TOE measurement components available as a tool mode. */
export type MeasureVariant = "length" | "area" | "angle" | "volume";

/** Display symbols for the unit codes the OBCF components use. */
const UNIT_SYMBOLS: Record<string, string> = {
  mm: "mm",
  cm: "cm",
  m: "m",
  km: "km",
  mm2: "mm²",
  cm2: "cm²",
  m2: "m²",
  km2: "km²",
  mm3: "mm³",
  cm3: "cm³",
  m3: "m³",
  km3: "km³",
  deg: "°",
  rad: "rad",
};

/** Default unit code per variant (the component's own `units` wins). */
export const DEFAULT_MEASURE_UNITS: Record<MeasureVariant, string> = {
  length: "m",
  area: "m2",
  angle: "deg",
  volume: "m3",
};

/** Human label for a variant ("Length"). */
export const MEASURE_VARIANT_LABELS: Record<MeasureVariant, string> = {
  length: "Length",
  area: "Area",
  angle: "Angle",
  volume: "Volume",
};

/** `m2` -> `m²`, `deg` -> `°`; unknown codes pass through unchanged. */
export function unitSymbol(unit: string): string {
  return UNIT_SYMBOLS[unit] ?? unit;
}

/** Decimal places for a value in `unit` (sensible, not the raw engine rounding). */
export function measurePrecision(unit: string): number {
  switch (unit) {
    case "mm":
    case "mm2":
    case "mm3":
      return 0;
    case "cm":
    case "cm2":
    case "cm3":
    case "deg":
      return 1;
    case "rad":
      return 3;
    default:
      return 2;
  }
}

/**
 * Format a measurement value with its unit: `3.42 m`, `12.50 m²`,
 * `37.5°`, `0.85 m³`. Non-finite values give an em dash. Never prints
 * negative zero.
 */
export function formatMeasureValue(value: number | null | undefined, unit: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const digits = measurePrecision(unit);
  let text = value.toFixed(digits);
  if (/^-0(\.0+)?$/.test(text)) text = text.slice(1);
  const symbol = unitSymbol(unit);
  return unit === "deg" ? `${text}${symbol}` : `${text} ${symbol}`;
}
