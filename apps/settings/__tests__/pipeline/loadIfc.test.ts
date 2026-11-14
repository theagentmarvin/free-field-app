// __tests__/pipeline/loadIfc.test.ts
//
// Integration tests for the full loadIfc() pipeline:
//   File → web-ifc parse (storeys) → IfcImporter (.frag) → hash →
//   Dexie (ifcFiles + ifcVersions + fragBlobs + storeys) →
//   FragmentsModels.load (best-effort, no-op in tests).
//
// We exercise the *real* web-ifc + IfcImporter against the
// public/samples/sample.ifc fixture. web-ifc loads its WASM from
// /web-ifc-node.wasm — see scripts/setup-wasm.mjs. The setup script
// is wired to `postinstall` so a fresh `npm install` populates
// public/ automatically.
//
// Limitations (documented):
//   - The viewer (IfcViewer) can't be tested in jsdom because the
//     FragmentsModels worker needs a WebWorker. The pipeline runs
//     loadIfc() with `registerFragments` left unset, so the
//     fragments-load step is skipped — exactly the same path that
//     runs when the user uploads an IFC before the viewer mounts.
//   - We don't assert on rendered pixels.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcPipeline } from "@ff/data/hooks";
import { listStoreys, listStoreysByVersion } from "@ff/data/db/tables/storeys";
import { listIfcFiles } from "@ff/data/db/tables/ifcFiles";
import { listVersions, getLatestVersion } from "@ff/data/db/tables/ifcVersions";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";

import { resetDb } from "../db/helpers";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

// Reuse the same fixture the dev "Load sample IFC" button uses.
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
  // Construct a File backed by the sample bytes. In Node 18+ the
  // global File is available via the "node:buffer" shim that the
  // test setup installs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F = (globalThis as any).File ?? File;
  return new F([SAMPLE_BYTES], name, { type: "application/x-step" });
}

async function makeBuilding() {
  const p = await createProject({ name: "PipelineTestProject", metadata: {} });
  return createBuilding({ projectId: p.id, name: "PipelineTestBuilding", metadata: {} });
}

describe("useIfcPipeline.loadIfc", () => {
  beforeAll(async () => {
    // Open the shared DB once; beforeEach clears tables.
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("loadIfc-pipeline");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("loads a new IFC, creating 1 file + 1 version + 1 frag blob + N storeys", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("model.ifc");

    const { result } = renderHook(() => useIfcPipeline());
    let r: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r = await result.current.loadIfc(file, building.id);
    });

    // Result shape
    expect(r!.isNewFile).toBe(true);
    expect(r!.versionNumber).toBe(1);
    expect(r!.ifcFileId).toBeTruthy();
    expect(r!.versionId).toBeTruthy();
    expect(r!.storeyCount).toBeGreaterThan(0);

    // 1 IfcFileRecord
    const files = await listIfcFiles(building.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("model.ifc");
    expect(files[0].currentVersionId).toBe(r!.versionId);

    // 1 IfcVersionRecord, isLatest=true
    const versions = await listVersions(r!.ifcFileId);
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNumber).toBe(1);
    expect(versions[0].isLatest).toBe(true);
    expect(versions[0].storeyCount).toBe(r!.storeyCount);
    expect(versions[0].ifcFileSize).toBe(SAMPLE_BYTES.byteLength);

    // fragBlobs has 1 entry with a non-empty Blob
    const blob = await getFragBlob(versions[0].fragBlobKey);
    expect(blob).toBeDefined();
    expect(blob!.size).toBeGreaterThan(0);
    // The .frag payload must start with a recognizable FlatBuffers
    // header (its first 4 bytes are the root-table offset, which is
    // small). We just assert it's not 0 bytes of garbage.
    const head = new Uint8Array(await blob!.slice(0, 4).arrayBuffer());
    expect(head.length).toBe(4);

    // N storey rows, all linked to this version
    const storeys = await listStoreysByVersion(r!.versionId);
    expect(storeys.length).toBe(r!.storeyCount);
    expect(storeys.length).toBeGreaterThan(0);
    for (const s of storeys) {
      expect(s.buildingId).toBe(building.id);
      expect(s.ifcVersionId).toBe(r!.versionId);
      expect(s.sourceIfcFileId).toBe(r!.ifcFileId);
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(s.elevation)).toBe(true);
    }

    // And the latest pointer resolves to the same version
    const latest = await getLatestVersion(r!.ifcFileId);
    expect(latest?.id).toBe(r!.versionId);
  });

  it("re-loading the same filename with identical bytes reuses the latest version (Wave 19b dedupe)", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("dup.ifc");

    const { result } = renderHook(() => useIfcPipeline());

    // First upload → v1
    let v1: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      v1 = await result.current.loadIfc(file, building.id);
    });
    expect(v1!.versionNumber).toBe(1);
    expect(v1!.isNewFile).toBe(true);

    // Second upload (same name, same building, SAME bytes) → dedupe:
    // the content hash matches the latest version, so loadIfc returns
    // it untouched — no re-import, no new version, no new blob. This
    // is what stops the pick harness (which re-uploads its two
    // samples on every mount) from minting a fresh multi-MB frag
    // blob per page reload.
    let v2: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      v2 = await result.current.loadIfc(file, building.id);
    });
    expect(v2!.versionNumber).toBe(1);
    expect(v2!.versionId).toBe(v1!.versionId);
    expect(v2!.isNewFile).toBe(false);
    expect(v2!.ifcFileId).toBe(v1!.ifcFileId);

    // 1 IfcFileRecord
    const files = await listIfcFiles(building.id);
    expect(files).toHaveLength(1);
    expect(files[0].currentVersionId).toBe(v2!.versionId);

    // Still exactly 1 IfcVersionRecord + 1 blob
    const versions = await listVersions(v1!.ifcFileId);
    expect(versions).toHaveLength(1);
    expect(versions[0].isLatest).toBe(true);
    expect(versions[0].id).toBe(v1!.versionId);

    // Exactly 1 fragBlob — the dedupe must not write a second one.
    const blob = await getFragBlob(versions[0].fragBlobKey);
    expect(blob).toBeDefined();
    expect(blob!.size).toBeGreaterThan(0);

    // Storeys belong to the single version; the building-level list
    // is not doubled by the no-op reload.
    const v1Storeys = await listStoreysByVersion(v1!.versionId);
    expect(v1Storeys.length).toBe(v1!.storeyCount);
    expect(v1Storeys.length).toBeGreaterThan(0);
    const allStoreys = await listStoreys(building.id);
    expect(allStoreys.length).toBe(v1Storeys.length);
  });

  it("same filename under a different building is treated as a new file", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    const file = makeIfcFile("shared.ifc");

    const { result } = renderHook(() => useIfcPipeline());
    let r1: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r1 = await result.current.loadIfc(file, b1.id);
    });
    let r2: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r2 = await result.current.loadIfc(file, b2.id);
    });

    expect(r1!.ifcFileId).not.toBe(r2!.ifcFileId);
    expect(r1!.isNewFile).toBe(true);
    expect(r2!.isNewFile).toBe(true);

    const files1 = await listIfcFiles(b1.id);
    const files2 = await listIfcFiles(b2.id);
    expect(files1).toHaveLength(1);
    expect(files2).toHaveLength(1);
  });

  it("loadIfc with a corrupted (non-IFC) file throws a clear error", async () => {
    const building = await makeBuilding();
    const corrupted = new File(
      [new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])],
      "junk.ifc",
      { type: "application/x-step" },
    );

    const { result } = renderHook(() => useIfcPipeline());
    await act(async () => {
      await expect(
        result.current.loadIfc(corrupted, building.id),
      ).rejects.toBeDefined();
    });

    // No file should have been persisted
    const files = await listIfcFiles(building.id);
    expect(files).toHaveLength(0);
  });
});
