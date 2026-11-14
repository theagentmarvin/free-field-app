// __tests__/db/storeys.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  createStorey,
  createStoreys,
  getStorey,
  listStoreys,
  listStoreysByVersion,
  deleteStoreysByVersion,
} from "@ff/data/db/tables/storeys";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { resetDb } from "./helpers";

async function makeContext() {
  const p = await createProject({ name: "P", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  const f = await createIfcFile({ buildingId: b.id, name: "model.ifc", currentVersionId: "x" });
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 0,
    isLatest: true,
  });
  return { project: p, building: b, file: f, version: v };
}

describe("storeys table", () => {
  beforeEach(async () => {
    await resetDb("storeys");
  });

  it("creates a single storey", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Ground Floor",
      elevation: 0,
      expressId: 42,
      height: 3.0,
    });
    expect(s.id).toBeTruthy();
    expect(s.elevation).toBe(0);
  });

  it("bulk creates storeys", async () => {
    const { building, file, version } = await makeContext();
    const records = await createStoreys([
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "L1",
        elevation: 0,
        expressId: 1,
        height: 3.0,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "L2",
        elevation: 3.0,
        expressId: 2,
        height: 3.0,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "L3",
        elevation: 6.0,
        expressId: 3,
        height: null,
      },
    ]);
    expect(records.length).toBe(3);
    expect(records[2].height).toBeNull();
  });

  it("reads a storey by id", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L1",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const got = await getStorey(s.id);
    expect(got?.id).toBe(s.id);
  });

  it("lists storeys scoped to a building", async () => {
    const ctx = await makeContext();
    const other = await createBuilding({
      projectId: ctx.project.id,
      name: "Other",
      metadata: {},
    });
    const otherFile = await createIfcFile({
      buildingId: other.id,
      name: "x.ifc",
      currentVersionId: "x",
    });
    const otherVersion = await createIfcVersion({
      ifcFileId: otherFile.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h",
      fragBlobKey: "k",
      storeyCount: 0,
      isLatest: true,
    });
    await createStorey({
      buildingId: ctx.building.id,
      ifcVersionId: ctx.version.id,
      sourceIfcFileId: ctx.file.id,
      name: "A",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    await createStorey({
      buildingId: other.id,
      ifcVersionId: otherVersion.id,
      sourceIfcFileId: otherFile.id,
      name: "B",
      elevation: 0,
      expressId: 2,
      height: null,
    });
    const list = await listStoreys(ctx.building.id);
    expect(list.map((s) => s.name)).toEqual(["A"]);
  });

  it("lists storeys by version", async () => {
    const { building, file, version } = await makeContext();
    await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L1",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const list = await listStoreysByVersion(version.id);
    expect(list.length).toBe(1);
  });

  it("cascades: deleting a version's storeys returns the count", async () => {
    const { building, file, version } = await makeContext();
    await createStoreys([
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "L1",
        elevation: 0,
        expressId: 1,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "L2",
        elevation: 3,
        expressId: 2,
        height: null,
      },
    ]);
    const deleted = await deleteStoreysByVersion(version.id);
    expect(deleted).toBe(2);
    const list = await listStoreysByVersion(version.id);
    expect(list.length).toBe(0);
  });

  it("deleteIfcVersion cascades to its storeys", async () => {
    const { building, file, version } = await makeContext();
    await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L1",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const { deleteIfcVersion } = await import("@ff/data/db/tables/ifcVersions");
    await deleteIfcVersion(version.id);
    const list = await listStoreysByVersion(version.id);
    expect(list.length).toBe(0);
  });
});
