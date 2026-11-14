// __tests__/hooks/usePdfPipeline.test.ts
//
// Wave 63 — usePdfPipeline against the real (fake-indexeddb) Dexie db
// with PDF.js mocked out:
//   - multi-page PDFs are accepted (loadPDF called with singlePage:false)
//   - the PDF.js document is destroyed even when measuring throws
//   - the content hash is computed from the bytes already read and
//     matches computeContentHash(file)
//   - version numbers are allocated inside the rw transaction (two
//     concurrent uploads of the same name → one file, v1 + v2)
//   - deletePdf's cascade is atomic (a failure rolls everything back)

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const pdf = vi.hoisted(() => ({
  destroy: vi.fn(),
  loadPDF: vi.fn(),
  throwOnWidth: false,
}));

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: pdf.loadPDF,
}));

import { db } from "@ff/data/db/database";
import { computeContentHash } from "@ff/data/db/files/hash";
import { createCalibration } from "@ff/data/db/tables/calibrations";
import { usePdfPipeline } from "@hooks/usePdfPipeline";
import { StorageQuotaExceededError } from "@ff/data/db/errors";

import { resetDb } from "../db/helpers";

function pdfFile(name: string, size = 2048): File {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
  for (let i = 9; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], name, { type: "application/pdf" });
}

beforeEach(async () => {
  await resetDb("usePdfPipeline");
  pdf.destroy.mockClear();
  pdf.throwOnWidth = false;
  pdf.loadPDF.mockReset().mockImplementation(async () => ({
    numPages: 3,
    get width() {
      if (pdf.throwOnWidth) throw new Error("page 1 unreadable");
      return 612;
    },
    height: 792,
    destroy: pdf.destroy,
  }));
});

describe("usePdfPipeline", () => {
  it("uploads a multi-page PDF as v1 and frees the PDF.js document", async () => {
    const { result } = renderHook(() => usePdfPipeline());
    let out: Awaited<ReturnType<typeof result.current.loadPdf>> | undefined;
    await act(async () => {
      out = await result.current.loadPdf(pdfFile("Plan.pdf"), "b-1");
    });

    expect(pdf.loadPDF).toHaveBeenCalledWith(expect.any(Uint8Array), { singlePage: false });
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ versionNumber: 1, isNewFile: true });
    const version = await db.pdfVersions.get(out!.versionId);
    expect(version).toMatchObject({ pageCount: 3, width: 612, height: 792, isLatest: true });
    expect(await db.pdfBlobs.get(version!.blobKey)).toBeTruthy();
  });

  it("wave 64: a full storage quota surfaces as StorageQuotaExceededError", async () => {
    const quota = Object.assign(new Error("The quota has been exceeded."), {
      name: "QuotaExceededError",
    });
    const spy = vi.spyOn(db.pdfBlobs, "put").mockRejectedValue(quota);
    const { result } = renderHook(() => usePdfPipeline());
    try {
      await act(async () => {
        await expect(result.current.loadPdf(pdfFile("Full.pdf"), "b-1")).rejects.toBeInstanceOf(
          StorageQuotaExceededError,
        );
      });
      expect(result.current.error).toBeInstanceOf(StorageQuotaExceededError);
    } finally {
      spy.mockRestore();
    }
  });

  it("hashes the bytes already read with the same scheme as computeContentHash", async () => {
    const file = pdfFile("Big.pdf", 70 * 1024);
    const { result } = renderHook(() => usePdfPipeline());
    let versionId = "";
    await act(async () => {
      versionId = (await result.current.loadPdf(file, "b-1")).versionId;
    });
    const version = await db.pdfVersions.get(versionId);
    expect(version!.contentHash).toBe(await computeContentHash(file));
  });

  it("destroys the document and writes nothing when measuring the PDF throws", async () => {
    pdf.throwOnWidth = true;
    const { result } = renderHook(() => usePdfPipeline());
    await act(async () => {
      await expect(result.current.loadPdf(pdfFile("Bad.pdf"), "b-1")).rejects.toThrow(
        "page 1 unreadable",
      );
    });
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
    expect(await db.pdfFiles.count()).toBe(0);
    expect(await db.pdfVersions.count()).toBe(0);
    expect(await db.pdfBlobs.count()).toBe(0);
  });

  it("two concurrent uploads of the same name make one file with v1 and v2", async () => {
    const { result } = renderHook(() => usePdfPipeline());
    await act(async () => {
      await Promise.all([
        result.current.loadPdf(pdfFile("Same.pdf"), "b-1"),
        result.current.loadPdf(pdfFile("Same.pdf"), "b-1"),
      ]);
    });
    const files = await db.pdfFiles.toArray();
    expect(files).toHaveLength(1);
    const versions = await db.pdfVersions.where("pdfFileId").equals(files[0].id).toArray();
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    expect(versions.filter((v) => v.isLatest)).toHaveLength(1);
    expect(versions.find((v) => v.isLatest)!.versionNumber).toBe(2);
  });

  it("replacePdfVersion adds the next version and flips the latest flag", async () => {
    const { result } = renderHook(() => usePdfPipeline());
    let fileId = "";
    await act(async () => {
      fileId = (await result.current.loadPdf(pdfFile("R.pdf"), "b-1")).pdfFileId;
    });
    let v2 = 0;
    await act(async () => {
      v2 = (await result.current.replacePdfVersion(fileId, pdfFile("R2.pdf"))).versionNumber;
    });
    expect(v2).toBe(2);
    const latest = await db.pdfVersions.where("pdfFileId").equals(fileId).toArray();
    expect(latest.filter((v) => v.isLatest).map((v) => v.versionNumber)).toEqual([2]);
  });

  it("deletePdf removes the file, versions, blobs and calibrations", async () => {
    const { result } = renderHook(() => usePdfPipeline());
    let fileId = "";
    await act(async () => {
      fileId = (await result.current.loadPdf(pdfFile("D.pdf"), "b-1")).pdfFileId;
    });
    await createCalibration({
      projectId: "default-project",
      pdfFileId: fileId,
      storeyName: "L1",
      pointPairs: [] as never,
      transformParams: { scale: 1, rotation: 0, tx: 0, tz: 0 } as never,
      confidence: 1,
    });
    await act(async () => {
      await result.current.deletePdf(fileId);
    });
    expect(await db.pdfFiles.count()).toBe(0);
    expect(await db.pdfVersions.count()).toBe(0);
    expect(await db.pdfBlobs.count()).toBe(0);
    expect(await db.calibrations.count()).toBe(0);
  });

  it("deletePdf is atomic: a failure part-way rolls the whole cascade back", async () => {
    const { result } = renderHook(() => usePdfPipeline());
    let fileId = "";
    await act(async () => {
      fileId = (await result.current.loadPdf(pdfFile("A.pdf"), "b-1")).pdfFileId;
    });
    await createCalibration({
      projectId: "default-project",
      pdfFileId: fileId,
      storeyName: "L1",
      pointPairs: [] as never,
      transformParams: { scale: 1, rotation: 0, tx: 0, tz: 0 } as never,
      confidence: 1,
    });
    // The file row is deleted LAST in the cascade; make it fail.
    const failDelete = (): void => {
      throw new Error("disk full");
    };
    db.pdfFiles.hook("deleting", failDelete);
    try {
      await act(async () => {
        await expect(result.current.deletePdf(fileId)).rejects.toThrow();
      });
    } finally {
      db.pdfFiles.hook("deleting").unsubscribe(failDelete);
    }
    expect(await db.pdfFiles.count()).toBe(1);
    expect(await db.pdfVersions.count()).toBe(1);
    expect(await db.pdfBlobs.count()).toBe(1);
    expect(await db.calibrations.count()).toBe(1);
  });
});
