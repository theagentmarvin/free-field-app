// __tests__/db/pdfVersions.test.ts
//
// Mirrors __tests__/db/ifcVersions.test.ts. Same `isLatest` invariant
// enforcement via `setPdfVersionAsLatest`, same delete-cascade
// (minus the storeys + extractedStoreys tables).

import { beforeEach, describe, expect, it } from "vitest";
import {
  createPdfVersion,
  getPdfVersion,
  listPdfVersions,
  getLatestPdfVersion,
  setPdfVersionAsLatest,
  deletePdfVersion,
} from "@ff/data/db/tables/pdfVersions";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { resetDb } from "./helpers";

async function makePdfFile() {
  const p = await createProject({ name: "P", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return createPdfFile({ buildingId: b.id, name: "model.pdf" });
}

describe("pdfVersions table", () => {
  beforeEach(async () => {
    await resetDb("pdfVersions");
  });

  it("creates a version row", async () => {
    const f = await makePdfFile();
    const v = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 2048,
      contentHash: "deadbeef",
      pageCount: 1,
      width: 612,
      height: 792,
      blobKey: "blob-1",
      isLatest: true,
    });
    expect(v.id).toBeTruthy();
    expect(v.versionNumber).toBe(1);
    expect(v.isLatest).toBe(true);
    expect(v.pageCount).toBe(1);
    expect(v.width).toBe(612);
    expect(v.height).toBe(792);
  });

  it("reads a version by id", async () => {
    const f = await makePdfFile();
    const v = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k",
      isLatest: true,
    });
    const got = await getPdfVersion(v.id);
    expect(got?.id).toBe(v.id);
  });

  it("lists versions for a PDF file ordered by versionNumber", async () => {
    const f = await makePdfFile();
    await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 2,
      name: "model.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k2",
      isLatest: true,
    });
    await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h1",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k1",
      isLatest: false,
    });
    const list = await listPdfVersions(f.id);
    expect(list.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it("getLatestPdfVersion returns the row with isLatest=true", async () => {
    const f = await makePdfFile();
    const old = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h1",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k1",
      isLatest: false,
    });
    const latest = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 2,
      name: "model.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k2",
      isLatest: true,
    });
    const got = await getLatestPdfVersion(f.id);
    expect(got?.id).toBe(latest.id);
    expect(got?.id).not.toBe(old.id);
  });

  it("setPdfVersionAsLatest toggles the flag", async () => {
    const f = await makePdfFile();
    const v1 = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h1",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k1",
      isLatest: true,
    });
    const v2 = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 2,
      name: "model.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k2",
      isLatest: false,
    });
    await setPdfVersionAsLatest(v2.id);

    const v1After = await getPdfVersion(v1.id);
    const v2After = await getPdfVersion(v2.id);
    expect(v1After?.isLatest).toBe(false);
    expect(v2After?.isLatest).toBe(true);
  });

  it("latest-flag invariant: only one isLatest per pdfFileId after toggling", async () => {
    const f = await makePdfFile();
    await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h1",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k1",
      isLatest: true,
    });
    const v2 = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 2,
      name: "model.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k2",
      isLatest: true,
    });
    // Fix the violation explicitly.
    await setPdfVersionAsLatest(v2.id);
    const list = await listPdfVersions(f.id);
    const latestCount = list.filter((v) => v.isLatest).length;
    expect(latestCount).toBe(1);
  });

  it("deleting the latest version promotes the previous one", async () => {
    const f = await makePdfFile();
    await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 1,
      contentHash: "h1",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k1",
      isLatest: false,
    });
    const v2 = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 2,
      name: "model.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "k2",
      isLatest: true,
    });
    await deletePdfVersion(v2.id);
    const list = await listPdfVersions(f.id);
    expect(list.length).toBe(1);
    expect(list[0].versionNumber).toBe(1);
    expect(list[0].isLatest).toBe(true);
  });

  it("delete cascades to the corresponding pdfBlob", async () => {
    const f = await makePdfFile();
    const v = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "model.pdf",
      size: 7,
      contentHash: "h",
      pageCount: 1,
      width: 100,
      height: 200,
      blobKey: "blob-to-delete",
      isLatest: true,
    });
    const { putPdfBlob, getPdfBlob } = await import(
      "@ff/data/db/tables/pdfBlobs"
    );
    await putPdfBlob("blob-to-delete", new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7])]));
    expect(await getPdfBlob("blob-to-delete")).toBeDefined();

    await deletePdfVersion(v.id);
    expect(await getPdfVersion(v.id)).toBeNull();
    expect(await getPdfBlob("blob-to-delete")).toBeNull();
  });
});
