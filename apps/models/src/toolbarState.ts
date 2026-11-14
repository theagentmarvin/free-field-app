// apps/models/src/toolbarState.ts
//
// Wave 13 — pure state machine for the bottom viewer toolbar
// (Measure split + the measure variant menu + the save-view /
// saved-views menu). Wave 50 removed the Select + Section buttons:
// navigation is the default mode (no toggle), and sectioning now lives
// only in the right-click context toolbar (wave 47/49).
//
// ZERO React: this module holds only types, constants, and pure
// transition functions. The <ViewerToolbar> component composes these
// with `useState`, and the resulting mode/menu is applied onto the
// IfcViewerHandle (`setMeasureMode` / `clearMeasurements` /
// `onMeasureReadout`). Keeping the transitions here means every arrow
// (Escape, re-tap-active-variant, save-view actions) is unit-testable
// without mounting React.

import { formatMeasureValue } from "@ff/viewer-react";

/**
 * The measurement variants. The installed @thatopen/components-front
 * 3.4.3 ships all four (Length/Area/Angle/VolumeMeasurement) with no
 * extra dependencies, so the menu lists all of them.
 */
export type MeasureVariant = "length" | "area" | "angle" | "volume";

/**
 * Tool mode:
 *  - "select"  → default navigation (no toggle button — wave 50)
 *  - "measure" → a measurement variant is armed (click → measure)
 */
export type ToolbarMode = "select" | "measure";

/**
 * Which dropdown is open. `"save"` is the save-view menu (Save view…
 * / Saved views ▸), `"views"` is the saved-viewpoints sub-menu
 * (nested inside the save menu). `null` = no menu.
 */
export type ToolbarMenu = "measure" | "save" | "views" | "list" | null;

/** Immutable UI state for the toolbar. */
export interface ToolbarState {
  mode: ToolbarMode;
  variant: MeasureVariant;
  menu: ToolbarMenu;
}

/** Menu order (source of truth for the caret menu + the toolbar). */
export const MEASURE_VARIANTS: readonly MeasureVariant[] = [
  "length",
  "area",
  "angle",
  "volume",
];

/** Display labels for the variant menu rows. */
export const VARIANT_LABELS: Record<MeasureVariant, string> = {
  length: "Length",
  area: "Area",
  angle: "Angle",
  volume: "Volume",
};

/** Initial state: Select (navigation) mode, default variant = length, no menu. */
export function initialToolbarState(): ToolbarState {
  return { mode: "select", variant: "length", menu: null };
}

/** Return to navigation (cancel any active tool). */
export function selectTool(state: ToolbarState): ToolbarState {
  return { ...state, mode: "select", menu: null };
}

/** Tap the "Measure" main button: toggle the variant menu. */
export function toggleMeasureMenu(state: ToolbarState): ToolbarState {
  return { ...state, menu: state.menu === "measure" ? null : "measure" };
}

/** Tap the measurements-list button: toggle the list popover (wave 67). */
export function toggleListMenu(state: ToolbarState): ToolbarState {
  return { ...state, menu: state.menu === "list" ? null : "list" };
}

/** Tap the "Save view" main button: toggle the save-view menu. */
export function toggleSaveMenu(state: ToolbarState): ToolbarState {
  return { ...state, menu: state.menu === "save" ? null : "save" };
}

/** Open the saved-viewpoints sub-menu (from the save-view menu). */
export function openViewsMenu(state: ToolbarState): ToolbarState {
  return { ...state, menu: "views" };
}

/** Close whatever menu is open (click outside / action chosen). */
export function closeToolMenu(state: ToolbarState): ToolbarState {
  return { ...state, menu: null };
}

/**
 * Choose a measure variant. Re-tapping the already-active variant
 * while in measure mode is a no-op (menu just closes); choosing a
 * different variant switches the active measurer.
 */
export function chooseVariant(
  state: ToolbarState,
  variant: MeasureVariant,
): ToolbarState {
  if (state.mode === "measure" && state.variant === variant) {
    return { ...state, menu: null };
  }
  return { ...state, mode: "measure", variant, menu: null };
}

/**
 * Escape: cancel any active tool + close the menu (back to navigation).
 * Kept for the pure state-machine surface; the toolbar now dispatches
 * Escape through a two-stage measure flow (the viewer owns the
 * cancel-vs-exit decision), but the terminal state is the same.
 */
export function escapeTool(state: ToolbarState): ToolbarState {
  return { ...state, mode: "select", menu: null };
}

/**
 * Format a readout value with its unit symbol and a sensible precision:
 * "12.40 m", "5.00 m²", "37.5°". Null for no / non-finite readout.
 */
export function formatMeasureReadout(
  readout: { value: number; unit: string } | null,
): string | null {
  if (!readout || !Number.isFinite(readout.value)) return null;
  return formatMeasureValue(readout.value, readout.unit);
}

/** One-line "how do I finish this" hint for the armed variant (wave 67). */
export function measureHint(variant: MeasureVariant): string {
  switch (variant) {
    case "length":
      return "Click two points";
    case "angle":
      return "Click three points";
    case "area":
      return "Click corners, double-click or Enter to finish";
    case "volume":
      return "Click elements, Enter to finish";
  }
}

/** Area / Volume are open-ended: they need an explicit "Done". */
export function measureNeedsFinish(variant: MeasureVariant): boolean {
  return variant === "area" || variant === "volume";
}
