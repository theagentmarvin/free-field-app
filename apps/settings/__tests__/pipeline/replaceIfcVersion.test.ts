// __tests__/pipeline/replaceIfcVersion.test.ts
//
// Integration tests for the new `replaceIfcVersion` method added in
// Task 3. Exercises the same web-ifc + IfcImporter + Dexie stack
// that loadIfc.test.ts uses, and asserts that:
//   - replace keeps the same IfcFileRecord (name + buildingId preserved)
//   - a new IfcVersionRecord with versionNumber+1 is created
//   - the new .frag blob is written under a distinct key
//   - the previous storeys are replaced (not duplicated) with the
//     newly-parsed ones
//   - the latest-version pointer flips
//
// See docs/TASK-3-UI.md "Replace version flow".

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcPipeline } from "@ff/data/hooks";
import { listIfcFiles } from "@ff/data/db/tables/ifcFiles";
import { listVersions, getLatestVersion } from "@ff/data/db/tables/ifcVersions";
import { listStoreys, listStoreysByVersion } from "@ff/data/db/tables/storeys";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";

import { resetDb } from "../db/helpers";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

const SAMPLE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "public",
  "samples",
  "sample.ifc",
);
const SAMPLE_BYTES = readFileSync(SAMPLE_PATH);

function makeIfcFile(name: string): File {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F = (globalThis as any).File ?? File;
  return new F([SAMPLE_BYTES], name, { type: "application/x-step" });
}

async function makeBuilding() {
  const p = await createProject({ name: "ReplaceTestProject", metadata: {} });
  return createBuilding({
    projectId: p.id,
    name: "ReplaceTestBuilding",
    metadata: {},
  });
}

describe("useIfcPipeline.replaceIfcVersion", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("replaceIfcVersion");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("creates v2 for an existing file, keeps the IfcFileRecord, flips the latest", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("model.ifc");

    const { result } = renderHook(() => useIfcPipeline());

    // v1
    let v1: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      v1 = await result.current.loadIfc(file, building.id);
    });

    // Now replace the version with the same file. In production this
    // would be a different upload; here we just want to verify the
    // path that runs when the user picks a file via the kebab
    // "Replace version" menu.
    let r: Awaited<ReturnType<typeof result.current.replaceIfcVersion>>;
    await act(async () => {
      r = await result.current.replaceIfcVersion(v1!.ifcFileId, file);
    });

    // The IfcFileRecord is preserved (same id, same name).
    expect(r!.ifcFileId).toBe(v1!.ifcFileId);
    expect(r!.isNewFile).toBe(false);
    expect(r!.versionNumber).toBe(2);
    expect(r!.versionId).not.toBe(v1!.versionId);

    // 1 IfcFileRecord (unchanged name)
    const files = await listIfcFiles(building.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("model.ifc");
    expect(files[0].currentVersionId).toBe(r!.versionId);

    // 2 IfcVersionRecord
    const versions = await listVersions(r!.ifcFileId);
    expect(versions).toHaveLength(2);
    const byNum = Object.fromEntries(
      versions.map((v) => [v.versionNumber, v]),
    );
    expect(byNum[1].isLatest).toBe(false);
    expect(byNum[2].isLatest).toBe(true);

    // 2 distinct fragBlobs
    expect(byNum[1].fragBlobKey).not.toBe(byNum[2].fragBlobKey);
    const blob1 = await getFragBlob(byNum[1].fragBlobKey);
    const blob2 = await getFragBlob(byNum[2].fragBlobKey);
    expect(blob1).toBeDefined();
    expect(blob2).toBeDefined();
    expect(blob1!.size).toBeGreaterThan(0);
    expect(blob2!.size).toBeGreaterThan(0);

    // Latest pointer resolves to v2.
    const latest = await getLatestVersion(r!.ifcFileId);
    expect(latest?.id).toBe(r!.versionId);

    // Storeys: the v1 storeys have been removed (replaced) and v2
    // storeys are present. The building-level storey list contains
    // only the latest version's storeys.
    const v1Storeys = await listStoreysByVersion(v1!.versionId);
    expect(v1Storeys).toHaveLength(0);
    const v2Storeys = await listStoreysByVersion(r!.versionId);
    expect(v2Storeys.length).toBe(r!.storeyCount);
    const allStoreys = await listStoreys(building.id);
    expect(allStoreys.length).toBe(r!.storeyCount);
  });

  it("throws for an unknown ifcFileId", async () => {
    const { result } = renderHook(() => useIfcPipeline());
    const file = makeIfcFile("missing.ifc");
    await act(async () => {
      await expect(
        result.current.replaceIfcVersion("definitely-not-a-real-id", file),
      ).rejects.toThrow(/IfcFileRecord/);
    });
  });
});
