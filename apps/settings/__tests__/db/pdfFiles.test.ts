// __tests__/db/pdfFiles.test.ts
//
// Mirrors __tests__/db/ifcFiles.test.ts. The version-key behavior is
// the same: same (buildingId, name) pair → throw on insert. Caller
// (the pipeline) is expected to call `findPdfFileByName` first.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createPdfFile,
  getPdfFile,
  listPdfFiles,
  findPdfFileByName,
  updatePdfFile,
  deletePdfFile,
} from "@ff/data/db/tables/pdfFiles";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { resetDb } from "./helpers";

async function makeBuilding() {
  const p = await createProject({ name: "P", metadata: {} });
  return createBuilding({ projectId: p.id, name: "B", metadata: {} });
}

describe("pdfFiles table", () => {
  beforeEach(async () => {
    await resetDb("pdfFiles");
  });

  it("creates a PDF file row", async () => {
    const b = await makeBuilding();
    const f = await createPdfFile({
      buildingId: b.id,
      name: "Planta 1.pdf",
    });
    expect(f.id).toBeTruthy();
    expect(f.buildingId).toBe(b.id);
    expect(f.name).toBe("Planta 1.pdf");
    expect(f.createdAt).toBeGreaterThan(0);
  });

  it("reads a PDF file by id", async () => {
    const b = await makeBuilding();
    const f = await createPdfFile({
      buildingId: b.id,
      name: "Planta 1.pdf",
    });
    const got = await getPdfFile(f.id);
    expect(got?.id).toBe(f.id);
  });

  it("lists PDF files scoped to a building", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    await createPdfFile({ buildingId: b1.id, name: "a.pdf" });
    await createPdfFile({ buildingId: b1.id, name: "b.pdf" });
    await createPdfFile({ buildingId: b2.id, name: "c.pdf" });
    const list = await listPdfFiles(b1.id);
    expect(list.map((f) => f.name).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("finds PDF files by [buildingId+name] (the version key)", async () => {
    const b = await makeBuilding();
    const f = await createPdfFile({ buildingId: b.id, name: "dup.pdf" });
    const found = await findPdfFileByName(b.id, "dup.pdf");
    expect(found?.id).toBe(f.id);
  });

  it("version-key behavior: same name + same building → throws on insert", async () => {
    const b = await makeBuilding();
    await createPdfFile({ buildingId: b.id, name: "dup.pdf" });
    await expect(
      createPdfFile({ buildingId: b.id, name: "dup.pdf" }),
    ).rejects.toThrow();
  });

  it("same name across different buildings is allowed", async () => {
    const b1 = await makeBuilding();
    const b2 = await makeBuilding();
    const f1 = await createPdfFile({ buildingId: b1.id, name: "model.pdf" });
    const f2 = await createPdfFile({ buildingId: b2.id, name: "model.pdf" });
    expect(f1.id).not.toBe(f2.id);
  });

  it("updates a PDF file row (bumps updatedAt)", async () => {
    const b = await makeBuilding();
    const f = await createPdfFile({ buildingId: b.id, name: "x.pdf" });
    const originalUpdated = f.updatedAt;
    // Wait at least 1ms so the bumped timestamp is observable.
    await new Promise((r) => setTimeout(r, 5));
    await updatePdfFile(f.id, { updatedAt: Date.now() + 1 });
    const got = await getPdfFile(f.id);
    expect(got?.updatedAt).toBeGreaterThan(originalUpdated);
  });

  it("deletes a PDF file and cascades to its versions and blobs", async () => {
    const b = await makeBuilding();
    const f = await createPdfFile({ buildingId: b.id, name: "model.pdf" });
    const { createPdfVersion, getPdfVersion } = await import(
      "@ff/data/db/tables/pdfVersions"
    );
    const v = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1024,
      contentHash: "abc",
      pageCount: 1,
      width: 612,
      height: 792,
      blobKey: "blob-1",
      isLatest: true,
    });
    const { putPdfBlob, getPdfBlob } = await import(
      "@ff/data/db/tables/pdfBlobs"
    );
    await putPdfBlob("blob-1", new Blob([new Uint8Array([1, 2, 3])]));

    await deletePdfFile(f.id);
    expect(await getPdfFile(f.id)).toBeUndefined();
    expect(await getPdfVersion(v.id)).toBeNull();
    expect(await getPdfBlob("blob-1")).toBeNull();
  });
});
