// src/calibration/state.ts
//
// Pure state machine for the calibration wizard. The wizard
// drives the user through 4 picks → a review state → a saved
// state. The reducer is deliberately pure (no Dexie, no OBC,
// no React) so it's trivially testable in plain Node.
//
// See docs/TASK-12a-CALIBRATION-WIZARD.md "State machine" for
// the full transition table and re-pick semantics.

/** One of the 6 logical steps in the wizard. */
export type CalibrationStep =
  | "PICK_PDF_A"
  | "PICK_PDF_B"
  | "PICK_WORLD_A"
  | "PICK_WORLD_B"
  | "REVIEW"
  | "SAVED";

/** The wizard's working state — 4 picks + the current step. */
export interface CalibrationFlow {
  /** Which PDF the wizard is calibrating (the row the user clicked Map on). */
  pdfFileId: string;
  /** Which storey the wizard is calibrating (the currently-open level). */
  storeyName: string;
  step: CalibrationStep;
  pdfA: { x: number; y: number } | null;
  pdfB: { x: number; y: number } | null;
  /** World points are in floor-plan coords: x + z (y is up). */
  worldA: { x: number; z: number } | null;
  worldB: { x: number; z: number } | null;
}

/** Discriminated union of every action the wizard can dispatch. */
export type CalibrationAction =
  | { type: "SET_PDF_PICK"; point: { x: number; y: number } }
  | { type: "SET_WORLD_PICK"; point: { x: number; z: number } }
  | { type: "RE_PICK"; target: "pdfA" | "pdfB" | "worldA" | "worldB" }
  | { type: "RESET" }
  | { type: "MARK_SAVED" };

/**
 * Initial state for a fresh wizard session. Caller fills in
 * pdfFileId + storeyName (those are set by the Map button click,
 * not by an action).
 */
export function initialCalibrationFlow(
  pdfFileId: string,
  storeyName: string,
): CalibrationFlow {
  return {
    pdfFileId,
    storeyName,
    step: "PICK_PDF_A",
    pdfA: null,
    pdfB: null,
    worldA: null,
    worldB: null,
  };
}

/**
 * Compute the next forward step given the current step and the
 * post-pick state of the two PDF picks. The "current step" is
 * the step the wizard was in BEFORE the pick was recorded; the
 * has-flags are the post-pick state. The wizard always advances
 * forward by one step on a successful pick — defensive guards
 * (e.g. "pdfA wasn't recorded before pdfB") are the caller's
 * responsibility.
 *
 * Returns the same step when called from REVIEW or SAVED (the
 * forward chain is exhausted).
 */
export function nextStep(
  current: CalibrationStep,
  hasPdfA: boolean,
  hasPdfB: boolean,
): CalibrationStep {
  switch (current) {
    case "PICK_PDF_A":
      return "PICK_PDF_B";
    case "PICK_PDF_B":
      // Need pdfA recorded before we can ask the user to
      // pick in the 3D view. If the flag is somehow false
      // (shouldn't happen if the wizard drove us here), stay
      // put.
      if (!hasPdfA) return current;
      return "PICK_WORLD_A";
    case "PICK_WORLD_A":
      if (!hasPdfA || !hasPdfB) return current;
      return "PICK_WORLD_B";
    case "PICK_WORLD_B":
      if (!hasPdfA || !hasPdfB) return current;
      return "REVIEW";
    case "REVIEW":
    case "SAVED":
      return current;
  }
}

/**
 * Reverse mapping: which step should the wizard return to when
 * the user clicks a marker to re-pick that point during REVIEW?
 * Pairs: pdfA re-pick → PICK_PDF_A, etc.
 */
export function previousStepFor(
  target: "pdfA" | "pdfB" | "worldA" | "worldB",
): CalibrationStep {
  switch (target) {
    case "pdfA":
      return "PICK_PDF_A";
    case "pdfB":
      return "PICK_PDF_B";
    case "worldA":
      return "PICK_WORLD_A";
    case "worldB":
      return "PICK_WORLD_B";
  }
}

/**
 * The reducer. Pure function of (flow, action) → new flow.
 * No side effects, no I/O. The MappingView calls this from
 * useViewerStore.dispatchCalibrationAction.
 */
/**
 * After a pick, a flow whose four slots are all filled goes straight
 * to REVIEW. This is what makes a re-pick cheap: re-picking pdfA from
 * REVIEW clears only pdfA, and once it is set again the wizard jumps
 * back to REVIEW instead of walking through every later step.
 */
function settleAfterPick(flow: CalibrationFlow): CalibrationFlow {
  if (flow.pdfA && flow.pdfB && flow.worldA && flow.worldB) {
    return flow.step === "REVIEW" ? flow : { ...flow, step: "REVIEW" };
  }
  return flow;
}

export function reduceFlow(
  flow: CalibrationFlow,
  action: CalibrationAction,
): CalibrationFlow {
  const next = reduceFlowStep(flow, action);
  if (
    next !== flow &&
    (action.type === "SET_PDF_PICK" || action.type === "SET_WORLD_PICK")
  ) {
    return settleAfterPick(next);
  }
  return next;
}

function reduceFlowStep(
  flow: CalibrationFlow,
  action: CalibrationAction,
): CalibrationFlow {
  switch (action.type) {
    case "SET_PDF_PICK": {
      // The "which PDF slot" is determined by the current step.
      // PICK_PDF_A → pdfA, PICK_PDF_B → pdfB. From REVIEW,
      // SET_PDF_PICK is a no-op (re-picks must go through
      // RE_PICK so the state machine knows to rewind the step).
      if (flow.step === "PICK_PDF_A") {
        // Record pdfA, then ask nextStep for the next step
        // from the CURRENT (pre-pick) state, with hasPdfA=true
        // (post-pick) and the previous hasPdfB.
        const hasPdfAAfter = true;
        const hasPdfBAfter = flow.pdfB !== null;
        const next: CalibrationFlow = {
          ...flow,
          pdfA: action.point,
          step: nextStep("PICK_PDF_A", hasPdfAAfter, hasPdfBAfter),
        };
        return next;
      }
      if (flow.step === "PICK_PDF_B") {
        const hasPdfAAfter = flow.pdfA !== null;
        const hasPdfBAfter = true;
        const next: CalibrationFlow = {
          ...flow,
          pdfB: action.point,
          step: nextStep("PICK_PDF_B", hasPdfAAfter, hasPdfBAfter),
        };
        return next;
      }
      // Defensive: SET_PDF_PICK outside the PDF-pick states is
      // a no-op. The wizard UI shouldn't surface that case.
      return flow;
    }

    case "SET_WORLD_PICK": {
      if (flow.step === "PICK_WORLD_A") {
        const hasPdfAAfter = flow.pdfA !== null;
        const hasPdfBAfter = flow.pdfB !== null;
        const next: CalibrationFlow = {
          ...flow,
          worldA: action.point,
          step: nextStep("PICK_WORLD_A", hasPdfAAfter, hasPdfBAfter),
        };
        return next;
      }
      if (flow.step === "PICK_WORLD_B") {
        const hasPdfAAfter = flow.pdfA !== null;
        const hasPdfBAfter = flow.pdfB !== null;
        const next: CalibrationFlow = {
          ...flow,
          worldB: action.point,
          step: nextStep("PICK_WORLD_B", hasPdfAAfter, hasPdfBAfter),
        };
        return next;
      }
      return flow;
    }

    case "RE_PICK": {
      // Only valid during REVIEW. From any other state, RE_PICK
      // is a no-op (the user can't click a marker that doesn't
      // exist yet).
      if (flow.step !== "REVIEW") return flow;
      // Clear the targeted pick and rewind to the step that
      // collects it. The subsequent SET_*_PICK action will
      // re-advance. We use a const map (not a switch) so the
      // function is exhaustively type-narrowed by TS without
      // an inner switch's fallthrough warning.
      const rewinds: Record<typeof action.target, CalibrationStep> = {
        pdfA: "PICK_PDF_A",
        pdfB: "PICK_PDF_B",
        worldA: "PICK_WORLD_A",
        worldB: "PICK_WORLD_B",
      };
      const step = rewinds[action.target];
      const cleared: CalibrationFlow = { ...flow, step };
      if (action.target === "pdfA") cleared.pdfA = null;
      if (action.target === "pdfB") cleared.pdfB = null;
      if (action.target === "worldA") cleared.worldA = null;
      if (action.target === "worldB") cleared.worldB = null;
      return cleared;
    }

    case "RESET": {
      // Clear all picks and rewind to the beginning. Keep
      // pdfFileId + storeyName (those are user intent, not
      // wizard state).
      return {
        ...flow,
        step: "PICK_PDF_A",
        pdfA: null,
        pdfB: null,
        worldA: null,
        worldB: null,
      };
    }

    case "MARK_SAVED": {
      // Only valid in REVIEW. From any other step, MARK_SAVED
      // is a no-op (the wizard won't offer a Save button until
      // all 4 picks are recorded).
      if (flow.step !== "REVIEW") return flow;
      return { ...flow, step: "SAVED" };
    }
  }
}

/**
 * Friendly step labels for the status bar. Kept here (not in
 * MappingView) so the same strings can be reused for tests and
 * any future telemetry.
 */
export const STEP_LABELS: Record<CalibrationStep, string> = {
  PICK_PDF_A: "Pick point A in the PDF",
  PICK_PDF_B: "Pick point B in the PDF",
  PICK_WORLD_A: "Pick point A in the 3D view",
  PICK_WORLD_B: "Pick point B in the 3D view",
  REVIEW: "Review — click a marker to re-pick, or Save",
  SAVED: "Saved",
};
