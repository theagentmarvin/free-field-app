// __tests__/calibration/state.test.ts
//
// Unit tests for the calibration wizard's state machine. The
// reducer is pure; these tests pin every transition documented
// in docs/TASK-12a-CALIBRATION-WIZARD.md "State machine".

import { describe, expect, it } from "vitest";

import {
  initialCalibrationFlow,
  nextStep,
  previousStepFor,
  reduceFlow,
  type CalibrationAction,
  type CalibrationFlow,
} from "@calibration/state";

function makeFlow(overrides: Partial<CalibrationFlow> = {}): CalibrationFlow {
  return {
    pdfFileId: "pdf-1",
    storeyName: "Level 1",
    step: "PICK_PDF_A",
    pdfA: null,
    pdfB: null,
    worldA: null,
    worldB: null,
    ...overrides,
  };
}

describe("initialCalibrationFlow", () => {
  it("seeds a fresh flow with the given pdfFileId and storeyName", () => {
    const flow = initialCalibrationFlow("pdf-42", "Level 7");
    expect(flow.pdfFileId).toBe("pdf-42");
    expect(flow.storeyName).toBe("Level 7");
    expect(flow.step).toBe("PICK_PDF_A");
    expect(flow.pdfA).toBeNull();
    expect(flow.pdfB).toBeNull();
    expect(flow.worldA).toBeNull();
    expect(flow.worldB).toBeNull();
  });
});

describe("nextStep forward transitions", () => {
  it("PICK_PDF_A → PICK_PDF_B", () => {
    expect(nextStep("PICK_PDF_A", false, false)).toBe("PICK_PDF_B");
  });
  it("PICK_PDF_B → PICK_WORLD_A (only when pdfA is recorded)", () => {
    expect(nextStep("PICK_PDF_B", true, false)).toBe("PICK_WORLD_A");
  });
  it("PICK_PDF_B stays put if pdfA is missing (defensive)", () => {
    expect(nextStep("PICK_PDF_B", false, false)).toBe("PICK_PDF_B");
  });
  it("PICK_WORLD_A → PICK_WORLD_B (only when both pdf picks are set)", () => {
    expect(nextStep("PICK_WORLD_A", true, true)).toBe("PICK_WORLD_B");
  });
  it("PICK_WORLD_B → REVIEW (only when both pdf picks are set)", () => {
    expect(nextStep("PICK_WORLD_B", true, true)).toBe("REVIEW");
  });
  it("REVIEW stays at REVIEW (no forward advance)", () => {
    expect(nextStep("REVIEW", true, true)).toBe("REVIEW");
  });
  it("SAVED stays at SAVED (no forward advance)", () => {
    expect(nextStep("SAVED", true, true)).toBe("SAVED");
  });
});

describe("previousStepFor", () => {
  it("maps each re-pick target to its corresponding picking step", () => {
    expect(previousStepFor("pdfA")).toBe("PICK_PDF_A");
    expect(previousStepFor("pdfB")).toBe("PICK_PDF_B");
    expect(previousStepFor("worldA")).toBe("PICK_WORLD_A");
    expect(previousStepFor("worldB")).toBe("PICK_WORLD_B");
  });
});

describe("reduceFlow — SET_PDF_PICK", () => {
  it("PICK_PDF_A + SET_PDF_PICK records pdfA and advances to PICK_PDF_B", () => {
    const out = reduceFlow(makeFlow(), {
      type: "SET_PDF_PICK",
      point: { x: 1, y: 2 },
    });
    expect(out.pdfA).toEqual({ x: 1, y: 2 });
    expect(out.pdfB).toBeNull();
    expect(out.step).toBe("PICK_PDF_B");
  });

  it("PICK_PDF_B + SET_PDF_PICK records pdfB and advances to PICK_WORLD_A", () => {
    const out = reduceFlow(
      makeFlow({ step: "PICK_PDF_B", pdfA: { x: 0, y: 0 } }),
      { type: "SET_PDF_PICK", point: { x: 5, y: 6 } },
    );
    expect(out.pdfB).toEqual({ x: 5, y: 6 });
    expect(out.step).toBe("PICK_WORLD_A");
  });

  it("SET_PDF_PICK outside a PDF-pick step is a no-op", () => {
    const before = makeFlow({
      step: "PICK_WORLD_A",
      pdfA: { x: 1, y: 1 },
      pdfB: { x: 2, y: 2 },
    });
    const out = reduceFlow(before, {
      type: "SET_PDF_PICK",
      point: { x: 99, y: 99 },
    });
    expect(out).toBe(before);
  });
});

describe("reduceFlow — SET_WORLD_PICK", () => {
  it("PICK_WORLD_A + SET_WORLD_PICK records worldA and advances to PICK_WORLD_B", () => {
    const out = reduceFlow(
      makeFlow({
        step: "PICK_WORLD_A",
        pdfA: { x: 1, y: 1 },
        pdfB: { x: 2, y: 2 },
      }),
      { type: "SET_WORLD_PICK", point: { x: 10, z: 20 } },
    );
    expect(out.worldA).toEqual({ x: 10, z: 20 });
    expect(out.step).toBe("PICK_WORLD_B");
  });

  it("PICK_WORLD_B + SET_WORLD_PICK records worldB and advances to REVIEW", () => {
    const out = reduceFlow(
      makeFlow({
        step: "PICK_WORLD_B",
        pdfA: { x: 1, y: 1 },
        pdfB: { x: 2, y: 2 },
      }),
      { type: "SET_WORLD_PICK", point: { x: 30, z: 40 } },
    );
    expect(out.worldB).toEqual({ x: 30, z: 40 });
    expect(out.step).toBe("REVIEW");
  });

  it("SET_WORLD_PICK outside a world-pick step is a no-op", () => {
    const before = makeFlow({ step: "PICK_PDF_A" });
    const out = reduceFlow(before, {
      type: "SET_WORLD_PICK",
      point: { x: 99, z: 99 },
    });
    expect(out).toBe(before);
  });
});

describe("reduceFlow — RE_PICK", () => {
  // Common REVIEW-state setup: all 4 picks recorded.
  function reviewState(): CalibrationFlow {
    return makeFlow({
      step: "REVIEW",
      pdfA: { x: 1, y: 1 },
      pdfB: { x: 2, y: 2 },
      worldA: { x: 10, z: 20 },
      worldB: { x: 30, z: 40 },
    });
  }

  it("REVIEW + RE_PICK pdfA clears pdfA and rewinds to PICK_PDF_A", () => {
    const out = reduceFlow(reviewState(), { type: "RE_PICK", target: "pdfA" });
    expect(out.pdfA).toBeNull();
    expect(out.step).toBe("PICK_PDF_A");
  });
  it("REVIEW + RE_PICK pdfB clears pdfB and rewinds to PICK_PDF_B", () => {
    const out = reduceFlow(reviewState(), { type: "RE_PICK", target: "pdfB" });
    expect(out.pdfB).toBeNull();
    expect(out.step).toBe("PICK_PDF_B");
  });
  it("REVIEW + RE_PICK worldA clears worldA and rewinds to PICK_WORLD_A", () => {
    const out = reduceFlow(reviewState(), {
      type: "RE_PICK",
      target: "worldA",
    });
    expect(out.worldA).toBeNull();
    expect(out.step).toBe("PICK_WORLD_A");
  });
  it("REVIEW + RE_PICK worldB clears worldB and rewinds to PICK_WORLD_B", () => {
    const out = reduceFlow(reviewState(), {
      type: "RE_PICK",
      target: "worldB",
    });
    expect(out.worldB).toBeNull();
    expect(out.step).toBe("PICK_WORLD_B");
  });

  // Wave 63: a re-pick only redoes the cleared point, then jumps back
  // to REVIEW instead of forcing every later step again.
  it.each(["pdfA", "pdfB", "worldA", "worldB"] as const)(
    "re-picking %s returns straight to REVIEW, keeping the other picks",
    (target) => {
      const before = reviewState();
      const cleared = reduceFlow(before, { type: "RE_PICK", target });
      const out =
        target === "pdfA" || target === "pdfB"
          ? reduceFlow(cleared, { type: "SET_PDF_PICK", point: { x: 7, y: 7 } })
          : reduceFlow(cleared, { type: "SET_WORLD_PICK", point: { x: 7, z: 7 } });
      expect(out.step).toBe("REVIEW");
      for (const key of ["pdfA", "pdfB", "worldA", "worldB"] as const) {
        if (key === target) continue;
        expect(out[key]).toEqual(before[key]);
      }
      expect(out[target]).toEqual(
        target.startsWith("pdf") ? { x: 7, y: 7 } : { x: 7, z: 7 },
      );
    },
  );

  it("RE_PICK outside REVIEW is a no-op", () => {
    const before = makeFlow({ step: "PICK_PDF_A" });
    const out = reduceFlow(before, { type: "RE_PICK", target: "pdfA" });
    expect(out).toBe(before);
  });
});

describe("reduceFlow — RESET and MARK_SAVED", () => {
  it("RESET clears all picks and rewinds to PICK_PDF_A (keeps identity)", () => {
    const before = makeFlow({
      step: "REVIEW",
      pdfA: { x: 1, y: 1 },
      pdfB: { x: 2, y: 2 },
      worldA: { x: 10, z: 20 },
      worldB: { x: 30, z: 40 },
    });
    const out = reduceFlow(before, { type: "RESET" });
    expect(out.pdfFileId).toBe(before.pdfFileId);
    expect(out.storeyName).toBe(before.storeyName);
    expect(out.step).toBe("PICK_PDF_A");
    expect(out.pdfA).toBeNull();
    expect(out.pdfB).toBeNull();
    expect(out.worldA).toBeNull();
    expect(out.worldB).toBeNull();
  });

  it("MARK_SAVED from REVIEW advances to SAVED", () => {
    const out = reduceFlow(
      makeFlow({
        step: "REVIEW",
        pdfA: { x: 1, y: 1 },
        pdfB: { x: 2, y: 2 },
        worldA: { x: 10, z: 20 },
        worldB: { x: 30, z: 40 },
      }),
      { type: "MARK_SAVED" },
    );
    expect(out.step).toBe("SAVED");
  });

  it("MARK_SAVED outside REVIEW is a no-op", () => {
    const before = makeFlow({ step: "PICK_PDF_A" });
    const out = reduceFlow(before, { type: "MARK_SAVED" });
    expect(out).toBe(before);
  });
});

describe("reduceFlow — full happy path", () => {
  it("walks PICK_PDF_A → PICK_PDF_B → PICK_WORLD_A → PICK_WORLD_B → REVIEW → SAVED", () => {
    let flow = initialCalibrationFlow("pdf-1", "Level 1");
    const dispatch = (action: CalibrationAction) => {
      flow = reduceFlow(flow, action);
    };
    dispatch({ type: "SET_PDF_PICK", point: { x: 0, y: 0 } });
    expect(flow.step).toBe("PICK_PDF_B");
    dispatch({ type: "SET_PDF_PICK", point: { x: 1, y: 1 } });
    expect(flow.step).toBe("PICK_WORLD_A");
    dispatch({ type: "SET_WORLD_PICK", point: { x: 0, z: 0 } });
    expect(flow.step).toBe("PICK_WORLD_B");
    dispatch({ type: "SET_WORLD_PICK", point: { x: 1, z: 1 } });
    expect(flow.step).toBe("REVIEW");
    expect(flow.pdfA).toEqual({ x: 0, y: 0 });
    expect(flow.pdfB).toEqual({ x: 1, y: 1 });
    expect(flow.worldA).toEqual({ x: 0, z: 0 });
    expect(flow.worldB).toEqual({ x: 1, z: 1 });
    dispatch({ type: "MARK_SAVED" });
    expect(flow.step).toBe("SAVED");
  });
});
