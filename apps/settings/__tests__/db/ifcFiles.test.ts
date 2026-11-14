// __tests__/db/ifcFiles.test.ts
//
// Version-key behavior: re-inserting the same name under the same
// building should be a "versioning" decision made by the caller. This
// table does NOT auto-upsert; it surfaces the existing row through
// `findIfcFileByName` so the pipeline can call `createIfcVersion`
// instead of `createIfcFile`. Inserting a duplicate throws.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createIfcFile,
  getIfcFile,
  listIfcFiles,
  findIfcFileByName,
  updateIfcFile,
  deleteIfcFile,
} from "@ff/data/db/tables/ifcFiles";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { resetDb } from "./helpers";

async function makeBuilding() {
  const p = await createProject({ name: "P", metadata: {} });
  return createBuilding({ projectId: p.id, name: "B", metadata: {} });
}

describe("ifcFiles table", () => {
  beforeEach(async () => {
    await resetDb("ifcFiles");
  });

  it("creates an IFC file row", async () => {
    const b = await makeBuilding();
    const f = await createIfcFile({
      buildingId: b.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    expect(f.id).toBeTruthy();
    expect(f.buildingId).toBe(b.id);
    expect(f.name).toBe("model.ifc");
    expect(f.currentVersionId).toBe("v-1");
  });

  it("reads an IFC file by id", async () => {
    const b = await makeBuilding();
    const f = await createIfcFile({
      buildingId: b.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    const got = await getIfcFile(f.id);
    expect(got?.id).toBe(f.id);
  });

  it("lists IFC files scoped to a building", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    await createIfcFile({ buildingId: b1.id, name: "a.ifc", currentVersionId: "v1" });
    await createIfcFile({ buildingId: b1.id, name: "b.ifc", currentVersionId: "v1" });
    await createIfcFile({ buildingId: b2.id, name: "c.ifc", currentVersionId: "v1" });
    const list = await listIfcFiles(b1.id);
    expect(list.map((f) => f.name).sort()).toEqual(["a.ifc", "b.ifc"]);
  });

  it("finds IFC files by [buildingId+name] (the version key)", async () => {
    const b = await makeBuilding();
    const f = await createIfcFile({
      buildingId: b.id,
      name: "dup.ifc",
      currentVersionId: "v-1",
    });
    const found = await findIfcFileByName(b.id, "dup.ifc");
    expect(found?.id).toBe(f.id);
  });

  it("version-key behavior: same name + same building → throws on insert", async () => {
    // The table does NOT auto-upsert. The pipeline is expected to call
    // findIfcFileByName first; if it finds a row it should create a new
    // version, not call createIfcFile. Here we assert the constraint.
    const b = await makeBuilding();
    await createIfcFile({ buildingId: b.id, name: "dup.ifc", currentVersionId: "v-1" });
    await expect(
      createIfcFile({ buildingId: b.id, name: "dup.ifc", currentVersionId: "v-2" }),
    ).rejects.toThrow();
  });

  it("same name across different buildings is allowed", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    const f1 = await createIfcFile({
      buildingId: b1.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    const f2 = await createIfcFile({
      buildingId: b2.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    expect(f1.id).not.toBe(f2.id);
  });

  it("updates currentVersionId", async () => {
    const b = await makeBuilding();
    const f = await createIfcFile({
      buildingId: b.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    await updateIfcFile(f.id, { currentVersionId: "v-2" });
    const got = await getIfcFile(f.id);
    expect(got?.currentVersionId).toBe("v-2");
  });

  it("deletes an IFC file and cascades to its versions, storeys, and blobs", async () => {
    const b = await makeBuilding();
    const f = await createIfcFile({
      buildingId: b.id,
      name: "model.ifc",
      currentVersionId: "v-1",
    });
    const { createIfcVersion, getIfcVersion } = await import(
      "@ff/data/db/tables/ifcVersions"
    );
    const v = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1024,
      contentHash: "abc",
      fragBlobKey: "blob-1",
      storeyCount: 0,
      isLatest: true,
    });
    const { putFragBlob, getFragBlob } = await import("@ff/data/db/tables/fragBlobs");
    await putFragBlob("blob-1", new Blob([new Uint8Array([1, 2, 3])]));

    await deleteIfcFile(f.id);
    expect(await getIfcFile(f.id)).toBeUndefined();
    expect(await getIfcVersion(v.id)).toBeUndefined();
    expect(await getFragBlob("blob-1")).toBeNull();
  });
});
