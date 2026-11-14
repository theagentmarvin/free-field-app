// __tests__/db/buildings.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  createBuilding,
  getBuilding,
  listBuildings,
  findBuildingByName,
  updateBuilding,
  deleteBuilding,
} from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { resetDb } from "./helpers";

async function makeProject() {
  return createProject({ name: "P", metadata: {} });
}

describe("buildings table", () => {
  beforeEach(async () => {
    await resetDb("buildings");
  });

  it("creates a building with defaults", async () => {
    const p = await makeProject();
    const b = await createBuilding({ projectId: p.id, name: "Tower A", metadata: {} });
    expect(b.id).toBeTruthy();
    expect(b.projectId).toBe(p.id);
    expect(b.name).toBe("Tower A");
  });

  it("reads a building by id", async () => {
    const p = await makeProject();
    const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
    const got = await getBuilding(b.id);
    expect(got?.id).toBe(b.id);
  });

  it("lists buildings scoped to a project", async () => {
    const p1 = await makeProject();
    const p2 = await makeProject();
    await createBuilding({ projectId: p1.id, name: "A1", metadata: {} });
    await createBuilding({ projectId: p1.id, name: "A2", metadata: {} });
    await createBuilding({ projectId: p2.id, name: "B1", metadata: {} });

    const p1Buildings = await listBuildings(p1.id);
    expect(p1Buildings.map((b) => b.name).sort()).toEqual(["A1", "A2"]);
  });

  it("finds a building by [projectId+name]", async () => {
    const p = await makeProject();
    await createBuilding({ projectId: p.id, name: "Tower A", metadata: {} });
    const found = await findBuildingByName(p.id, "Tower A");
    expect(found?.projectId).toBe(p.id);
    expect(await findBuildingByName(p.id, "Nope")).toBeUndefined();
  });

  it("enforces unique [projectId+name] index", async () => {
    const p = await makeProject();
    await createBuilding({ projectId: p.id, name: "Tower A", metadata: {} });
    await expect(
      createBuilding({ projectId: p.id, name: "Tower A", metadata: {} }),
    ).rejects.toThrow();
  });

  it("allows the same name across different projects", async () => {
    const p1 = await makeProject();
    const p2 = await makeProject();
    const b1 = await createBuilding({ projectId: p1.id, name: "Tower A", metadata: {} });
    const b2 = await createBuilding({ projectId: p2.id, name: "Tower A", metadata: {} });
    expect(b1.id).not.toBe(b2.id);
  });

  it("updates a building", async () => {
    const p = await makeProject();
    const b = await createBuilding({ projectId: p.id, name: "Old", metadata: {} });
    await updateBuilding(b.id, { name: "New" });
    const got = await getBuilding(b.id);
    expect(got?.name).toBe("New");
  });

  it("deletes a building and cascades to its IFCs", async () => {
    const p = await makeProject();
    const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
    const f = await createIfcFile({
      buildingId: b.id,
      name: "model.ifc",
      currentVersionId: "v-placeholder",
    });
    await deleteBuilding(b.id);
    expect(await getBuilding(b.id)).toBeUndefined();
    const { getIfcFile } = await import("@ff/data/db/tables/ifcFiles");
    expect(await getIfcFile(f.id)).toBeUndefined();
  });
});
