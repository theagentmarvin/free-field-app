import { describe, expect, it } from "vitest";
import {
  formatMeasureValue,
  measurePrecision,
  unitSymbol,
} from "../../src/measure/measureFormat";

describe("unitSymbol", () => {
  it("maps engine unit codes to display symbols", () => {
    expect(unitSymbol("m")).toBe("m");
    expect(unitSymbol("m2")).toBe("m²");
    expect(unitSymbol("m3")).toBe("m³");
    expect(unitSymbol("deg")).toBe("°");
    expect(unitSymbol("rad")).toBe("rad");
    expect(unitSymbol("furlong")).toBe("furlong");
  });
});

describe("formatMeasureValue", () => {
  it("formats each variant with a sensible precision and unit", () => {
    expect(formatMeasureValue(3.4167, "m")).toBe("3.42 m");
    expect(formatMeasureValue(12.5, "m2")).toBe("12.50 m²");
    expect(formatMeasureValue(0.854, "m3")).toBe("0.85 m³");
    expect(formatMeasureValue(37.46, "deg")).toBe("37.5°");
    expect(formatMeasureValue(1.2346, "rad")).toBe("1.235 rad");
    expect(formatMeasureValue(1234.56, "mm")).toBe("1235 mm");
  });
  it("never prints negative zero or NaN", () => {
    expect(formatMeasureValue(-0.0001, "m")).toBe("0.00 m");
    expect(formatMeasureValue(Number.NaN, "m")).toBe("—");
    expect(formatMeasureValue(null, "m")).toBe("—");
    expect(formatMeasureValue(undefined, "deg")).toBe("—");
  });
  it("precision table", () => {
    expect(measurePrecision("m")).toBe(2);
    expect(measurePrecision("cm")).toBe(1);
    expect(measurePrecision("mm")).toBe(0);
  });
});
