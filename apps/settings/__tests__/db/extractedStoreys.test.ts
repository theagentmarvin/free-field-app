// __tests__/db/extractedStoreys.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  setExtracted,
  listExtracted,
  deleteExtracted,
  syncExtractedStoreys,
} from "@ff/data/db/tables/extractedStoreys";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createStorey } from "@ff/data/db/tables/storeys";
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

describe("extractedStoreys table", () => {
  beforeEach(async () => {
    await resetDb("extractedStoreys");
  });

  it("setExtracted(true) creates a row", async () => {
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
    const row = await setExtracted(building.id, s.id, true);
    expect(row).not.toBeNull();
    expect(row?.buildingId).toBe(building.id);
    expect(row?.storeyId).toBe(s.id);
  });

  it("setExtracted(false) removes the row", async () => {
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
    await setExtracted(building.id, s.id, true);
    const row = await setExtracted(building.id, s.id, false);
    expect(row).toBeNull();
    const list = await listExtracted(building.id);
    expect(list).toEqual([]);
  });

  it("setExtracted(true) is idempotent — same storeyId in same building keeps one row", async () => {
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
    await setExtracted(building.id, s.id, true);
    await setExtracted(building.id, s.id, true);
    const list = await listExtracted(building.id);
    expect(list.length).toBe(1);
  });

  it("listExtracted scopes by building", async () => {
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
    const s1 = await createStorey({
      buildingId: ctx.building.id,
      ifcVersionId: ctx.version.id,
      sourceIfcFileId: ctx.file.id,
      name: "A",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const s2 = await createStorey({
      buildingId: other.id,
      ifcVersionId: otherVersion.id,
      sourceIfcFileId: otherFile.id,
      name: "B",
      elevation: 0,
      expressId: 2,
      height: null,
    });
    await setExtracted(ctx.building.id, s1.id, true);
    await setExtracted(other.id, s2.id, true);
    const listA = await listExtracted(ctx.building.id);
    const listB = await listExtracted(other.id);
    expect(listA.map((r) => r.storeyId)).toEqual([s1.id]);
    expect(listB.map((r) => r.storeyId)).toEqual([s2.id]);
  });

  it("deleteExtracted removes a single row", async () => {
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
    const row = await setExtracted(building.id, s.id, true);
    await deleteExtracted(row!.id);
    const list = await listExtracted(building.id);
    expect(list).toEqual([]);
  });
});

describe("syncExtractedStoreys", () => {
  beforeEach(async () => {
    await resetDb("syncExtractedStoreys");
  });

  it("adds a row for a level that should be extracted and is not", async () => {
    const { building } = await makeContext();
    const result = await syncExtractedStoreys(building.id, [
      { levelId: "L1", isExtracted: true },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.deleted).toBe(0);
    const list = await listExtracted(building.id);
    expect(list).toHaveLength(1);
    expect(list[0].storeyId).toBe("L1");
    expect(list[0].buildingId).toBe(building.id);
  });

  it("deletes a row for a level that should not be extracted and is", async () => {
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
    await setExtracted(building.id, s.id, true);
    const result = await syncExtractedStoreys(building.id, [
      { levelId: s.id, isExtracted: false },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.deleted).toBe(1);
    const list = await listExtracted(building.id);
    expect(list).toEqual([]);
  });

  it("is idempotent — running twice with the same updates is a no-op", async () => {
    const { building } = await makeContext();
    const first = await syncExtractedStoreys(building.id, [
      { levelId: "L1", isExtracted: true },
      { levelId: "L2", isExtracted: true },
    ]);
    expect(first.inserted).toBe(2);
    expect(first.deleted).toBe(0);
    const second = await syncExtractedStoreys(building.id, [
      { levelId: "L1", isExtracted: true },
      { levelId: "L2", isExtracted: true },
    ]);
    expect(second.inserted).toBe(0);
    expect(second.deleted).toBe(0);
    const list = await listExtracted(building.id);
    expect(list).toHaveLength(2);
  });

  it("handles a mix of inserts and deletes in one call", async () => {
    const { building, file, version } = await makeContext();
    // Pre-write L1 and L2 as already-extracted.
    const l1 = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L1",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const l2 = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L2",
      elevation: 1,
      expressId: 2,
      height: null,
    });
    const l3 = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "L3",
      elevation: 2,
      expressId: 3,
      height: null,
    });
    await setExtracted(building.id, l1.id, true);
    await setExtracted(building.id, l2.id, true);
    // L3 doesn't exist in the table yet (only the storey record is
    // created above) — we sync with [+L3, -L1]. L2 is not mentioned
    // in this sync and must be left alone.
    const result = await syncExtractedStoreys(building.id, [
      { levelId: l3.id, isExtracted: true },
      { levelId: l1.id, isExtracted: false },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.deleted).toBe(1);
    const list = await listExtracted(building.id);
    const storeyIds = list.map((r) => r.storeyId).sort();
    expect(storeyIds).toEqual([l2.id, l3.id].sort());
  });

  it("isolates per building — sync on A does not touch B", async () => {
    const ctx = await makeContext();
    const other = await createBuilding({
      projectId: ctx.project.id,
      name: "Other",
      metadata: {} });
    // Use the same levelId value in both buildings — they must
    // remain independent rows.
    const sharedLevelId = "shared-level";
    await syncExtractedStoreys(ctx.building.id, [
      { levelId: sharedLevelId, isExtracted: true },
    ]);
    await syncExtractedStoreys(other.id, [
      { levelId: sharedLevelId, isExtracted: true },
    ]);
    // Each building should have one row, tagged with its own
    // buildingId.
    const listA = await listExtracted(ctx.building.id);
    const listB = await listExtracted(other.id);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0].buildingId).toBe(ctx.building.id);
    expect(listB[0].buildingId).toBe(other.id);
    expect(listA[0].id).not.toBe(listB[0].id);

    // Now delete on A only — B's row must remain.
    const result = await syncExtractedStoreys(ctx.building.id, [
      { levelId: sharedLevelId, isExtracted: false },
    ]);
    expect(result.deleted).toBe(1);
    const afterA = await listExtracted(ctx.building.id);
    const afterB = await listExtracted(other.id);
    expect(afterA).toEqual([]);
    expect(afterB).toHaveLength(1);
  });
});
