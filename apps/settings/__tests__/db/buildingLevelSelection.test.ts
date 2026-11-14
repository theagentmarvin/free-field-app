// __tests__/db/buildingLevelSelection.test.ts
//
// CRUD tests for the Dexie v2 buildingLevelSelection table added in
// Task 3. See docs/TASK-3-UI.md "Data model additions" and
// src/core/db/tables/buildingLevelSelection.ts.

import { beforeEach, describe, expect, it } from "vitest";
import {
  putBuildingLevelSelection,
  putBuildingLevelSelections,
  listBuildingLevelSelections,
  getBuildingLevelSelection,
  deleteBuildingLevelSelections,
} from "@ff/data/db/tables/buildingLevelSelection";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";
import { resetDb } from "./helpers";

async function makeBuilding() {
  const p = await createProject({ name: "BLS", metadata: {} });
  return createBuilding({ projectId: p.id, name: "B", metadata: {} });
}

describe("buildingLevelSelection table", () => {
  beforeEach(async () => {
    await resetDb("buildingLevelSelection");
  });

  it("upserts a row by [buildingId+levelId]", async () => {
    const b = await makeBuilding();
    await putBuildingLevelSelection({
      buildingId: b.id,
      levelId: "L1",
      selected: false,
    });
    const got = await getBuildingLevelSelection(b.id, "L1");
    expect(got?.selected).toBe(false);
    expect(got?.buildingId).toBe(b.id);
    expect(got?.levelId).toBe("L1");
    expect(typeof got?.updatedAt).toBe("number");
  });

  it("re-putting the same key updates in place (no duplicate)", async () => {
    const b = await makeBuilding();
    await putBuildingLevelSelection({
      buildingId: b.id,
      levelId: "L1",
      selected: false,
    });
    await putBuildingLevelSelection({
      buildingId: b.id,
      levelId: "L1",
      selected: true,
    });
    const list = await listBuildingLevelSelections(b.id);
    expect(list).toHaveLength(1);
    expect(list[0].selected).toBe(true);
  });

  it("lists all rows for a building", async () => {
    const b = await makeBuilding();
    await putBuildingLevelSelections([
      { buildingId: b.id, levelId: "L1", selected: true },
      { buildingId: b.id, levelId: "L2", selected: false },
      { buildingId: b.id, levelId: "L3", selected: true },
    ]);
    const list = await listBuildingLevelSelections(b.id);
    expect(list.map((r) => r.levelId).sort()).toEqual(["L1", "L2", "L3"]);
  });

  it("isolates rows between buildings (same levelId, different building)", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    await putBuildingLevelSelections([
      { buildingId: b1.id, levelId: "L1", selected: false },
      { buildingId: b2.id, levelId: "L1", selected: true },
    ]);
    const list1 = await listBuildingLevelSelections(b1.id);
    const list2 = await listBuildingLevelSelections(b2.id);
    expect(list1).toHaveLength(1);
    expect(list2).toHaveLength(1);
    expect(list1[0].selected).toBe(false);
    expect(list2[0].selected).toBe(true);
  });

  it("returns undefined for a (building, level) pair with no row", async () => {
    const b = await makeBuilding();
    const got = await getBuildingLevelSelection(b.id, "L-none");
    expect(got).toBeUndefined();
  });

  it("deletes all rows for a building", async () => {
    const b = await makeBuilding();
    await putBuildingLevelSelections([
      { buildingId: b.id, levelId: "L1", selected: true },
      { buildingId: b.id, levelId: "L2", selected: true },
    ]);
    const removed = await deleteBuildingLevelSelections(b.id);
    expect(removed).toBe(2);
    expect(await listBuildingLevelSelections(b.id)).toEqual([]);
  });

  it("does not affect other buildings when one is deleted", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    await putBuildingLevelSelections([
      { buildingId: b1.id, levelId: "L1", selected: false },
      { buildingId: b2.id, levelId: "L1", selected: true },
    ]);
    await deleteBuildingLevelSelections(b1.id);
    const list2 = await listBuildingLevelSelections(b2.id);
    expect(list2).toHaveLength(1);
  });
});
