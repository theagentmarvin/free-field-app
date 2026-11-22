// Building scope for viewer task pins/lists (2026-11-14).
import { describe, expect, it } from "vitest";

import {
  effectiveTaskBuildingId,
  tasksForBuilding,
  withEffectiveBuilding,
  taskBuildingLabel,
  resolveCreateBuildingId,
  type TaskBuildingIndex,
} from "../src/taskBuilding";
import { pinsForBuilding } from "../src/callouts";

const index: TaskBuildingIndex = {
  modelToBuilding: new Map([["m1", "bA"], ["m2", "bB"]]),
  pdfToBuilding: new Map([["p1", "bA"]]),
};
const onModel = (modelId: string) => ({ bim: { elements: [{ modelId }] } });

describe("effectiveTaskBuildingId", () => {
  it("prefers the task's own building", () => {
    expect(effectiveTaskBuildingId({ buildingId: "bB", location: onModel("m1") }, index)).toBe("bB");
  });
  it("falls back to the model it is pinned to, then the PDF", () => {
    expect(effectiveTaskBuildingId({ location: onModel("m1") }, index)).toBe("bA");
    expect(effectiveTaskBuildingId({ buildingId: null, location: { pdf: { pdfFileId: "p1" } } }, index)).toBe("bA");
  });
  it("is null for an unassigned, unlocated (or unknown-file) task", () => {
    expect(effectiveTaskBuildingId({}, index)).toBeNull();
    expect(effectiveTaskBuildingId({ location: onModel("gone") }, index)).toBeNull();
  });
});

describe("tasksForBuilding", () => {
  const tasks = [
    { id: "a", buildingId: "bA" },
    { id: "b", buildingId: "bB" },
    { id: "legacyA", location: onModel("m1") },
    { id: "orphan" },
  ];
  it("keeps only the active building's tasks and stamps the resolved building", () => {
    const out = tasksForBuilding(tasks, "bA", index);
    expect(out.map((t) => t.id)).toEqual(["a", "legacyA"]);
    expect(out.find((t) => t.id === "legacyA")?.buildingId).toBe("bA");
  });
  it("returns nothing when no building is selected", () => {
    expect(tasksForBuilding(tasks, null, index)).toEqual([]);
  });
});

describe("pinsForBuilding (strict)", () => {
  const pins = [
    { taskId: "a", buildingId: "bA" },
    { taskId: "b", buildingId: "bB" },
    { taskId: "legacy3d", elements: [{ modelId: "m1" }] },
    { taskId: "legacyPdf", pdfFileId: "p1" },
    { taskId: "orphan" },
  ];
  it("keeps the active building's pins, resolving unstamped ones by location", () => {
    expect(pinsForBuilding(pins, "bA", index).map((p) => p.taskId)).toEqual(["a", "legacy3d", "legacyPdf"]);
  });
  it("hides every pin when no building is selected", () => {
    expect(pinsForBuilding(pins, null, index)).toEqual([]);
  });
  it("leaves pins unscoped when the host passes no building at all", () => {
    expect(pinsForBuilding(pins, undefined, index)).toHaveLength(5);
  });
});

describe("withEffectiveBuilding / taskBuildingLabel (old tasks show a building)", () => {
  it("fills buildingId from where the task is pinned, keeps stamped ones", () => {
    const out = withEffectiveBuilding(
      [{ id: "old", location: onModel("m2") }, { id: "stamped", buildingId: "bA" }, { id: "none" }],
      index,
    );
    expect(out.map((t) => t.buildingId ?? null)).toEqual(["bB", "bA", null]);
  });
  it("labels with the building name, falling back to nothing for unknown ids", () => {
    const names = [{ id: "bA", name: "Tower A" }];
    expect(taskBuildingLabel({ location: onModel("m1") }, index, names)).toBe("Tower A");
    expect(taskBuildingLabel({ buildingId: "bA" }, index, names)).toBe("Tower A");
    expect(taskBuildingLabel({ buildingId: "bZ" }, index, names)).toBeNull();
    expect(taskBuildingLabel({}, index, names)).toBeNull();
  });
});

describe("resolveCreateBuildingId", () => {
  it("explicit choice wins, then the creation context, then the pinned location", () => {
    const loc = onModel("m2");
    expect(resolveCreateBuildingId({ explicit: "bX", context: "bA", location: loc }, index)).toBe("bX");
    expect(resolveCreateBuildingId({ explicit: null, context: "bA", location: loc }, index)).toBe("bA");
    expect(resolveCreateBuildingId({ explicit: null, context: null, location: loc }, index)).toBe("bB");
    expect(resolveCreateBuildingId({ explicit: null, context: null, location: null }, index)).toBeNull();
  });
});
