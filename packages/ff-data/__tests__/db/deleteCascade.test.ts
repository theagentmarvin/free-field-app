// __tests__/db/deleteCascade.test.ts
//
// deleteIfcFile / deletePdfFile run their whole cascade in ONE
// transaction (wave 63 review item 6): everything goes, or — when a
// step fails — nothing does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../src/db/database";
import { appendIfcVersion } from "../../src/db/appendIfcVersion";
import { deleteIfcFile } from "../../src/db/tables/ifcFiles";
import { deletePdfFile } from "../../src/db/tables/pdfFiles";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function seedIfc() {
  const base = {
    buildingId: "b1",
    fileName: "m.ifc",
    ifcFileSize: 1,
    fragBlob: new Blob([new Uint8Array([1])]),
    storeys: [{ name: "L0", elevation: 0, expressId: 1, height: null }],
    propertyCatalog: [{ pset: "P", name: "n" }],
  };
  await appendIfcVersion({ ...base, contentHash: "1" });
  const v2 = await appendIfcVersion({ ...base, contentHash: "2" });
  const storey = (await db.storeys.toArray())[0];
  await db.extractedStoreys.add({ id: "x1", buildingId: "b1", storeyId: storey.id, updatedAt: 1 });
  // An unrelated file that must survive.
  await appendIfcVersion({ ...base, fileName: "other.ifc", contentHash: "3" });
  return v2.file.id;
}

async function countsFor(fileId: string) {
  const versions = await db.ifcVersions.where("ifcFileId").equals(fileId).toArray();
  return {
    file: (await db.ifcFiles.get(fileId)) ? 1 : 0,
    versions: versions.length,
    storeys: await db.storeys.filter((s) => s.sourceIfcFileId === fileId).count(),
    extracted: await db.extractedStoreys.count(),
    catalog: await db.propertyCatalog.where({ fileId }).count(),
    blobs: (await db.fragBlobs.toCollection().primaryKeys()).filter((k) => k.startsWith(fileId)).length,
  };
}

describe("deleteIfcFile", () => {
  it("removes the file, every version, blob, storey, extracted storey and catalog row", async () => {
    const id = await seedIfc();
    expect(await countsFor(id)).toEqual({ file: 1, versions: 2, storeys: 1, extracted: 1, catalog: 1, blobs: 2 });
    await deleteIfcFile(id);
    expect(await countsFor(id)).toEqual({ file: 0, versions: 0, storeys: 0, extracted: 0, catalog: 0, blobs: 0 });
    // The other file is untouched.
    const other = (await db.ifcFiles.toArray()).find((f) => f.name === "other.ifc")!;
    expect(await countsFor(other.id)).toMatchObject({ file: 1, versions: 1, storeys: 1, catalog: 1, blobs: 1 });
  });

  it("is all-or-nothing: a failing last step rolls the whole cascade back", async () => {
    const id = await seedIfc();
    const before = await countsFor(id);
    vi.spyOn(db.ifcFiles, "delete").mockRejectedValueOnce(new Error("nope"));
    await expect(deleteIfcFile(id)).rejects.toThrow("nope");
    expect(await countsFor(id)).toEqual(before);
  });

  it("is a no-op for an unknown id", async () => {
    await expect(deleteIfcFile("missing")).resolves.toBeUndefined();
  });
});

describe("deletePdfFile", () => {
  async function seedPdf() {
    await db.pdfFiles.add({ id: "p1", buildingId: "b1", name: "a.pdf", createdAt: 1, updatedAt: 1 });
    for (const n of [1, 2]) {
      await db.pdfVersions.add({
        id: `pv${n}`,
        pdfFileId: "p1",
        versionNumber: n,
        name: "a.pdf",
        size: 1,
        contentHash: `h${n}`,
        pageCount: 1,
        width: 1,
        height: 1,
        storedAt: n,
        blobKey: `pb${n}`,
        isLatest: n === 2,
      });
      await db.pdfBlobs.put({ key: `pb${n}`, bytes: new Blob([new Uint8Array([n])]) });
    }
    await db.calibrations.add({ id: "c1", projectId: "pr", pdfFileId: "p1", storeyName: "L0" } as never);
    await db.pdfFolderAssignments.add({ id: "fa1", pdfFileId: "p1", folderId: "f1" } as never);
  }
  async function counts() {
    return {
      files: await db.pdfFiles.count(),
      versions: await db.pdfVersions.count(),
      blobs: await db.pdfBlobs.count(),
      calibrations: await db.calibrations.count(),
      assignments: await db.pdfFolderAssignments.count(),
    };
  }

  it("removes file, versions, blobs, calibrations and folder assignment", async () => {
    await seedPdf();
    expect(await counts()).toEqual({ files: 1, versions: 2, blobs: 2, calibrations: 1, assignments: 1 });
    await deletePdfFile("p1");
    expect(await counts()).toEqual({ files: 0, versions: 0, blobs: 0, calibrations: 0, assignments: 0 });
  });

  it("is all-or-nothing", async () => {
    await seedPdf();
    vi.spyOn(db.pdfFiles, "delete").mockRejectedValueOnce(new Error("nope"));
    await expect(deletePdfFile("p1")).rejects.toThrow("nope");
    expect(await counts()).toEqual({ files: 1, versions: 2, blobs: 2, calibrations: 1, assignments: 1 });
  });
});
