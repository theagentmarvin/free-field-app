// __tests__/db/ifcVersions.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  createIfcVersion,
  getIfcVersion,
  listVersions,
  getLatestVersion,
  setAsLatest,
  deleteIfcVersion,
} from "@ff/data/db/tables/ifcVersions";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { resetDb } from "./helpers";

async function makeIfcFile() {
  const p = await createProject({ name: "P", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return createIfcFile({ buildingId: b.id, name: "model.ifc", currentVersionId: "x" });
}

describe("ifcVersions table", () => {
  beforeEach(async () => {
    await resetDb("ifcVersions");
  });

  it("creates a version row", async () => {
    const f = await makeIfcFile();
    const v = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 2048,
      contentHash: "deadbeef",
      fragBlobKey: "blob-1",
      storeyCount: 3,
      isLatest: true,
    });
    expect(v.id).toBeTruthy();
    expect(v.versionNumber).toBe(1);
    expect(v.isLatest).toBe(true);
  });

  it("reads a version by id", async () => {
    const f = await makeIfcFile();
    const v = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h",
      fragBlobKey: "k",
      storeyCount: 0,
      isLatest: true,
    });
    const got = await getIfcVersion(v.id);
    expect(got?.id).toBe(v.id);
  });

  it("lists versions for an IFC file ordered by versionNumber", async () => {
    const f = await makeIfcFile();
    await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 2,
      ifcFileSize: 1,
      contentHash: "h2",
      fragBlobKey: "k2",
      storeyCount: 0,
      isLatest: true,
    });
    await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h1",
      fragBlobKey: "k1",
      storeyCount: 0,
      isLatest: false,
    });
    const list = await listVersions(f.id);
    expect(list.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it("getLatestVersion returns the row with isLatest=true", async () => {
    const f = await makeIfcFile();
    const old = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h1",
      fragBlobKey: "k1",
      storeyCount: 0,
      isLatest: false,
    });
    const latest = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 2,
      ifcFileSize: 1,
      contentHash: "h2",
      fragBlobKey: "k2",
      storeyCount: 0,
      isLatest: true,
    });
    const got = await getLatestVersion(f.id);
    expect(got?.id).toBe(latest.id);
    expect(got?.id).not.toBe(old.id);
  });

  it("setAsLatest toggles the flag and updates the parent pointer", async () => {
    const f = await makeIfcFile();
    const v1 = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h1",
      fragBlobKey: "k1",
      storeyCount: 0,
      isLatest: true,
    });
    const v2 = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 2,
      ifcFileSize: 1,
      contentHash: "h2",
      fragBlobKey: "k2",
      storeyCount: 0,
      isLatest: false,
    });
    await setAsLatest(v2.id);

    const v1After = await getIfcVersion(v1.id);
    const v2After = await getIfcVersion(v2.id);
    expect(v1After?.isLatest).toBe(false);
    expect(v2After?.isLatest).toBe(true);

    const { getIfcFile } = await import("@ff/data/db/tables/ifcFiles");
    const fAfter = await getIfcFile(f.id);
    expect(fAfter?.currentVersionId).toBe(v2.id);
  });

  it("latest-flag invariant: only one isLatest per ifcFileId after toggling", async () => {
    const f = await makeIfcFile();
    await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h1",
      fragBlobKey: "k1",
      storeyCount: 0,
      isLatest: true,
    });
    const v2 = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 2,
      ifcFileSize: 1,
      contentHash: "h2",
      fragBlobKey: "k2",
      storeyCount: 0,
      isLatest: true,
    });
    // Fix the violation explicitly.
    await setAsLatest(v2.id);
    const list = await listVersions(f.id);
    const latestCount = list.filter((v) => v.isLatest).length;
    expect(latestCount).toBe(1);
  });

  it("deleting the latest version promotes the previous one", async () => {
    const f = await makeIfcFile();
    await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 1,
      ifcFileSize: 1,
      contentHash: "h1",
      fragBlobKey: "k1",
      storeyCount: 0,
      isLatest: false,
    });
    const v2 = await createIfcVersion({
      ifcFileId: f.id,
      versionNumber: 2,
      ifcFileSize: 1,
      contentHash: "h2",
      fragBlobKey: "k2",
      storeyCount: 0,
      isLatest: true,
    });
    await deleteIfcVersion(v2.id);
    const { getIfcFile } = await import("@ff/data/db/tables/ifcFiles");
    const fAfter = await getIfcFile(f.id);
    const list = await listVersions(f.id);
    expect(list.length).toBe(1);
    expect(list[0].versionNumber).toBe(1);
    expect(list[0].isLatest).toBe(true);
    expect(fAfter?.currentVersionId).toBe(list[0].id);
  });
});
