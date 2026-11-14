// apps/models/__tests__/toolbarState.test.ts
//
// Wave 13 — pure state-machine tests for the bottom viewer toolbar.
// Wave 50 removed the Select + Section buttons: only Measure + Save
// view remain, so these cover mode transitions, menu toggles, variant
// choice, Escape, and the readout formatter. No React.

import { describe, expect, it } from "vitest";

import {
  MEASURE_VARIANTS,
  chooseVariant,
  escapeTool,
  formatMeasureReadout,
  measureHint,
  measureNeedsFinish,
  toggleListMenu,
  initialToolbarState,
  openViewsMenu,
  selectTool,
  toggleMeasureMenu,
  toggleSaveMenu,
  type ToolbarState,
} from "../src/toolbarState";

function state(overrides: Partial<ToolbarState> = {}): ToolbarState {
  return { ...initialToolbarState(), ...overrides };
}

describe("toolbarState", () => {
  it("starts in Select (navigation) mode, length variant, no menu", () => {
    expect(initialToolbarState()).toEqual({
      mode: "select",
      variant: "length",
      menu: null,
    });
  });

  it("lists all four measure variants in order", () => {
    expect(MEASURE_VARIANTS).toEqual(["length", "area", "angle", "volume"]);
  });

  it("selectTool cancels measure and closes the menu", () => {
    const s = state({ mode: "measure", variant: "area", menu: "measure" });
    expect(selectTool(s)).toEqual({
      mode: "select",
      variant: "area",
      menu: null,
    });
  });

  it("toggleMeasureMenu flips the measure menu open/closed", () => {
    const closed = state({ menu: null });
    expect(toggleMeasureMenu(closed).menu).toBe("measure");
    expect(toggleMeasureMenu(toggleMeasureMenu(closed)).menu).toBeNull();
  });

  it("toggleSaveMenu flips the save-view menu open/closed", () => {
    const closed = state({ menu: null });
    expect(toggleSaveMenu(closed).menu).toBe("save");
    expect(toggleSaveMenu(toggleSaveMenu(closed)).menu).toBeNull();
  });

  it("openViewsMenu opens the saved-views sub-menu", () => {
    expect(openViewsMenu(state({ menu: "save" })).menu).toBe("views");
  });

  it("chooseVariant switches to measure + records the variant", () => {
    const next = chooseVariant(state({ mode: "select", variant: "length" }), "area");
    expect(next.mode).toBe("measure");
    expect(next.variant).toBe("area");
    expect(next.menu).toBeNull();
  });

  it("re-tapping the active variant is a no-op (menu just closes)", () => {
    const next = chooseVariant(
      state({ mode: "measure", variant: "area", menu: "measure" }),
      "area",
    );
    expect(next.mode).toBe("measure");
    expect(next.variant).toBe("area");
    expect(next.menu).toBeNull();
  });

  it("choosing a different variant while measuring switches it", () => {
    const next = chooseVariant(state({ mode: "measure", variant: "area" }), "angle");
    expect(next.mode).toBe("measure");
    expect(next.variant).toBe("angle");
  });

  it("escapeTool returns to Select and closes the menu", () => {
    expect(escapeTool(state({ mode: "measure", menu: "save" }))).toEqual({
      mode: "select",
      variant: "length",
      menu: null,
    });
  });

  it("formatMeasureReadout renders value + unit symbol with sensible precision", () => {
    expect(formatMeasureReadout({ value: 12.4, unit: "m" })).toBe("12.40 m");
    expect(formatMeasureReadout({ value: 12.4000001, unit: "m" })).toBe("12.40 m");
    expect(formatMeasureReadout({ value: 45, unit: "deg" })).toBe("45.0°");
    expect(formatMeasureReadout({ value: 5, unit: "m2" })).toBe("5.00 m²");
    expect(formatMeasureReadout({ value: 0.5, unit: "m3" })).toBe("0.50 m³");
    expect(formatMeasureReadout(null)).toBeNull();
    expect(formatMeasureReadout({ value: NaN, unit: "m" })).toBeNull();
  });

  it("toggleListMenu opens and closes the measurements list (wave 67)", () => {
    const open = toggleListMenu(state());
    expect(open.menu).toBe("list");
    expect(toggleListMenu(open).menu).toBeNull();
    // Opening it replaces another open menu.
    expect(toggleListMenu(state({ menu: "save" })).menu).toBe("list");
  });

  it("area / volume need an explicit finish, length / angle do not", () => {
    expect(measureNeedsFinish("area")).toBe(true);
    expect(measureNeedsFinish("volume")).toBe(true);
    expect(measureNeedsFinish("length")).toBe(false);
    expect(measureNeedsFinish("angle")).toBe(false);
    expect(measureHint("area")).toMatch(/double-click or Enter/);
  });
});
