// __tests__/pipeline/deleteIfc.test.ts
//
// Integration test for the deleteIfc() pipeline. Loads a sample IFC,
// then deletes it via the same hook and asserts that:
//   - the .frag blob row in `fragBlobs` is gone
//   - all IfcVersionRecord rows for the file are gone
//   - all StoreyRecord rows linked to those versions are gone
//   - the IfcFileRecord itself is gone
//
// We DON'T call the viewer (FragmentsModels) because jsdom doesn't
// support the Web Worker that FragmentsModels spawns. The pipeline's
// `deleteIfc` is best-effort about the viewer anyway — if no
// fragments are registered it just skips that step. So this test
// exercises the same code path that runs when the viewer is mounted
// AND when it isn't.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcPipeline } from "@ff/data/hooks";
import { listIfcFiles } from "@ff/data/db/tables/ifcFiles";
import { listVersions } from "@ff/data/db/tables/ifcVersions";
import { listStoreys } from "@ff/data/db/tables/storeys";
import { getFragBlob, listFragBlobKeys } from "@ff/data/db/tables/fragBlobs";

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
  const p = await createProject({ name: "DeleteTestProject", metadata: {} });
  return createBuilding({ projectId: p.id, name: "DeleteTestBuilding", metadata: {} });
}

describe("useIfcPipeline.deleteIfc", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("deleteIfc-pipeline");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("deletes all related rows (file, versions, storeys, blob) for an IFC", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("delete-me.ifc");

    const { result } = renderHook(() => useIfcPipeline());

    // Load first so we have something to delete.
    let loaded: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      loaded = await result.current.loadIfc(file, building.id);
    });
    expect(loaded!.isNewFile).toBe(true);

    // Sanity: there's exactly 1 file, 1 version, N storeys, 1 blob.
    const filesBefore = await listIfcFiles(building.id);
    expect(filesBefore).toHaveLength(1);
    const versionsBefore = await listVersions(loaded!.ifcFileId);
    expect(versionsBefore).toHaveLength(1);
    const storeysBefore = await listStoreys(building.id);
    expect(storeysBefore.length).toBeGreaterThan(0);
    const blobBefore = await getFragBlob(versionsBefore[0].fragBlobKey);
    expect(blobBefore).toBeDefined();
    expect(blobBefore!.size).toBeGreaterThan(0);
    const blobKeysBefore = await listFragBlobKeys();
    expect(blobKeysBefore).toContain(versionsBefore[0].fragBlobKey);

    // Now delete.
    await act(async () => {
      await result.current.deleteIfc(loaded!.ifcFileId);
    });

    // After: nothing in this building.
    const filesAfter = await listIfcFiles(building.id);
    expect(filesAfter).toHaveLength(0);

    // Versions are gone too (the file's cascade deletes them).
    const versionsAfter = await listVersions(loaded!.ifcFileId);
    expect(versionsAfter).toHaveLength(0);

    // Storeys tied to the deleted versions are gone.
    const storeysAfter = await listStoreys(building.id);
    expect(storeysAfter).toHaveLength(0);

    // FragBlobs are gone (deleted by the pipeline before the
    // file-delete cascade).
    const blobAfter = await getFragBlob(versionsBefore[0].fragBlobKey);
    expect(blobAfter).toBeNull();
    const blobKeysAfter = await listFragBlobKeys();
    expect(blobKeysAfter).not.toContain(versionsBefore[0].fragBlobKey);
  });

  it("deleting an IFC that has multiple versions removes all of them", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("multi-version.ifc");

    const { result } = renderHook(() => useIfcPipeline());

    // v1
    let v1: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      v1 = await result.current.loadIfc(file, building.id);
    });
    // v2 via replaceIfcVersion — the explicit "new content" path.
    // (Wave 19b: loadIfc with identical bytes now dedupes onto the
    // latest version instead of minting v2, so multi-version chains
    // are built through replaceIfcVersion.)
    let v2: Awaited<ReturnType<typeof result.current.replaceIfcVersion>>;
    await act(async () => {
      v2 = await result.current.replaceIfcVersion(v1!.ifcFileId, file);
    });
    expect(v1!.ifcFileId).toBe(v2!.ifcFileId);
    expect(v1!.versionId).not.toBe(v2!.versionId);

    const versions = await listVersions(v1!.ifcFileId);
    expect(versions).toHaveLength(2);

    // Both blobs exist
    for (const v of versions) {
      const b = await getFragBlob(v.fragBlobKey);
      expect(b).toBeDefined();
      expect(b!.size).toBeGreaterThan(0);
    }

    // Delete the whole chain.
    await act(async () => {
      await result.current.deleteIfc(v1!.ifcFileId);
    });

    expect(await listIfcFiles(building.id)).toHaveLength(0);
    expect(await listVersions(v1!.ifcFileId)).toHaveLength(0);
    expect(await listStoreys(building.id)).toHaveLength(0);
    for (const v of versions) {
      expect(await getFragBlob(v.fragBlobKey)).toBeNull();
    }
  });

  it("deleting an IFC that never existed is a no-op (no throw)", async () => {
    const { result } = renderHook(() => useIfcPipeline());
    await act(async () => {
      await result.current.deleteIfc("definitely-not-a-real-id");
    });
    // No assertion needed beyond "no throw"; this just guarantees the
    // API is safe to call from UI handlers (e.g. on stale state).
  });
});
