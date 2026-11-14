// src/store/useViewerStore.ts
//
// Zustand slice for:
//   - activeStoreyName (Task 16 — level plan view, replaces
//     OBC.Views activeViewId)
//   - activePdfVersionId (Task 11 — PDF canvas swap)
//   - calibrationFlow (Task 12a Part 2 — calibration wizard state)
//
// The Mapped section reads `activeStoreyName` to highlight the
// active level row; the calibration slice drives <MappingView>
// mounting (when calibrationFlow !== null, the right panel
// renders the wizard in place of the regular PDF canvas / 3D
// viewer).
//
// All three slices are independent. Setting one must never
// touch the others. Tiny by design — no persistence, no
// middleware, no selectors beyond the trivial.

import { create } from "zustand";

import {
  initialCalibrationFlow,
  reduceFlow,
  type CalibrationAction,
  type CalibrationFlow,
} from "@calibration/state";

export interface ViewerState {
  /**
   * Name of the currently open level plan, or `null` if the
   * world is in default 3D perspective mode.
   */
  activeStoreyName: string | null;
  setActiveStoreyName: (name: string | null) => void;
  /**
   * Id of the PdfVersionRecord currently open in the right-panel
   * PDF canvas, or `null` if the 3D viewer should be shown.
   */
  activePdfVersionId: string | null;
  setActivePdfVersionId: (id: string | null) => void;
  // ─── Calibration wizard (Task 12a Part 2) ──────────────────────
  /**
   * Current wizard state, or `null` when no calibration is in
   * progress. The MappingView reads this and renders only when
   * it's non-null.
   */
  calibrationFlow: CalibrationFlow | null;
  /** Open the wizard for the given (pdfFileId, storeyName). */
  startCalibration: (pdfFileId: string, storeyName: string) => void;
  /** Close the wizard without saving. */
  cancelCalibration: () => void;
  /**
   * Dispatch a CalibrationAction against the current flow. If
   * the flow is null, the action is a no-op (the wizard
   * shouldn't be dispatching in that state, but we defend
   * against stale events).
   */
  dispatchCalibrationAction: (action: CalibrationAction) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  activeStoreyName: null,
  setActiveStoreyName: (name) => set({ activeStoreyName: name }),
  activePdfVersionId: null,
  setActivePdfVersionId: (id) => set({ activePdfVersionId: id }),

  // Calibration wizard initial state. The flow is null when no
  // wizard is open; the MappingView only mounts in that branch.
  calibrationFlow: null,
  startCalibration: (pdfFileId, storeyName) =>
    set({ calibrationFlow: initialCalibrationFlow(pdfFileId, storeyName) }),
  cancelCalibration: () => set({ calibrationFlow: null }),
  dispatchCalibrationAction: (action) =>
    set((state) => {
      if (state.calibrationFlow === null) return state;
      return { calibrationFlow: reduceFlow(state.calibrationFlow, action) };
    }),
}));
