// __tests__/store/useViewerStore.test.ts
//
// Unit tests for the Zustand slice backing the active level plan
// name (Task 16, replaces OBC.Views activeStoreyName) and the active
// PDF version id. Tiny store on purpose — these tests just pin
// the initial state and the set/clear transitions for both fields.
// We don't test subscribers (those are exercised in
// MappedStoreysSection.test.tsx via `data-active`).

import { beforeEach, describe, expect, it } from "vitest";

import { useViewerStore } from "@store/useViewerStore";

describe("useViewerStore", () => {
  beforeEach(() => {
    useViewerStore.getState().setActiveStoreyName(null);
    useViewerStore.getState().setActivePdfVersionId(null);
  });

  it("starts with activeStoreyName === null", () => {
    const name = useViewerStore.getState().activeStoreyName;
    expect(name).toBeNull();
  });

  it("setActiveStoreyName stores the name", () => {
    useViewerStore.getState().setActiveStoreyName("101 FIRST FLOOR");
    expect(useViewerStore.getState().activeStoreyName).toBe(
      "101 FIRST FLOOR",
    );
  });

  it("setActiveStoreyName(null) clears the name", () => {
    useViewerStore.getState().setActiveStoreyName("ROOF");
    expect(useViewerStore.getState().activeStoreyName).toBe("ROOF");
    useViewerStore.getState().setActiveStoreyName(null);
    expect(useViewerStore.getState().activeStoreyName).toBeNull();
  });

  it("starts with activePdfVersionId === null", () => {
    const id = useViewerStore.getState().activePdfVersionId;
    expect(id).toBeNull();
  });

  it("setActivePdfVersionId stores the id", () => {
    useViewerStore.getState().setActivePdfVersionId("v-42");
    expect(useViewerStore.getState().activePdfVersionId).toBe("v-42");
  });

  it("setActivePdfVersionId(null) clears the id", () => {
    useViewerStore.getState().setActivePdfVersionId("v-42");
    expect(useViewerStore.getState().activePdfVersionId).toBe("v-42");
    useViewerStore.getState().setActivePdfVersionId(null);
    expect(useViewerStore.getState().activePdfVersionId).toBeNull();
  });

  it("activeStoreyName and activePdfVersionId are independent", () => {
    useViewerStore.getState().setActiveStoreyName("ROOF");
    useViewerStore.getState().setActivePdfVersionId("v-1");
    expect(useViewerStore.getState().activeStoreyName).toBe("ROOF");
    expect(useViewerStore.getState().activePdfVersionId).toBe("v-1");
    // Clearing one must not clear the other.
    useViewerStore.getState().setActivePdfVersionId(null);
    expect(useViewerStore.getState().activeStoreyName).toBe("ROOF");
    expect(useViewerStore.getState().activePdfVersionId).toBeNull();
  });
});

// ─── Task 12a Part 2: calibrationFlow state + actions ─────

describe("useViewerStore — calibrationFlow (Task 12a Part 2)", () => {
  beforeEach(() => {
    useViewerStore.getState().setActiveStoreyName(null);
    useViewerStore.getState().setActivePdfVersionId(null);
    useViewerStore.getState().cancelCalibration();
  });

  it("starts with calibrationFlow === null", () => {
    expect(useViewerStore.getState().calibrationFlow).toBeNull();
  });

  it("startCalibration creates a fresh flow in PICK_PDF_A", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    const flow = useViewerStore.getState().calibrationFlow;
    expect(flow).not.toBeNull();
    expect(flow?.pdfFileId).toBe("pdf-1");
    expect(flow?.storeyName).toBe("Level 1");
    expect(flow?.step).toBe("PICK_PDF_A");
    expect(flow?.pdfA).toBeNull();
    expect(flow?.pdfB).toBeNull();
    expect(flow?.worldA).toBeNull();
    expect(flow?.worldB).toBeNull();
  });

  it("cancelCalibration clears the flow", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    expect(useViewerStore.getState().calibrationFlow).not.toBeNull();
    useViewerStore.getState().cancelCalibration();
    expect(useViewerStore.getState().calibrationFlow).toBeNull();
  });

  it("dispatchCalibrationAction advances through the wizard", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    useViewerStore.getState().dispatchCalibrationAction({
      type: "SET_PDF_PICK",
      point: { x: 1, y: 1 },
    });
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("PICK_PDF_B");
    useViewerStore.getState().dispatchCalibrationAction({
      type: "SET_PDF_PICK",
      point: { x: 2, y: 2 },
    });
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("PICK_WORLD_A");
    useViewerStore.getState().dispatchCalibrationAction({
      type: "SET_WORLD_PICK",
      point: { x: 0, z: 0 },
    });
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("PICK_WORLD_B");
    useViewerStore.getState().dispatchCalibrationAction({
      type: "SET_WORLD_PICK",
      point: { x: 1, z: 1 },
    });
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("REVIEW");
    useViewerStore.getState().dispatchCalibrationAction({ type: "MARK_SAVED" });
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("SAVED");
  });

  it("dispatchCalibrationAction is a no-op when the flow is null", () => {
    useViewerStore.getState().dispatchCalibrationAction({
      type: "SET_PDF_PICK",
      point: { x: 1, y: 1 },
    });
    expect(useViewerStore.getState().calibrationFlow).toBeNull();
  });

  it("calibrationFlow and activePdfVersionId are independent", () => {
    useViewerStore.getState().setActivePdfVersionId("v-1");
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    expect(useViewerStore.getState().activePdfVersionId).toBe("v-1");
    useViewerStore.getState().cancelCalibration();
    expect(useViewerStore.getState().activePdfVersionId).toBe("v-1");
  });
});
