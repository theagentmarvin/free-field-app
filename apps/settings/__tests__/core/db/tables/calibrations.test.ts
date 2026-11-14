// __tests__/core/db/tables/calibrations.test.ts
//
// CRUD contract for the v4 `calibrations` table. Mirrors the
// existing `__tests__/db/pdfFiles.test.ts` style. Covers create /
// get / getForPdfAndStorey / list (project / storey / pdf) /
// update / delete / cascade-on-pdf-delete.

import { beforeEach, describe, expect, it } from "vitest";

import {
  createCalibration,
  deleteCalibration,
  deleteCalibrationsForPdf,
  getCalibration,
  getCalibrationForPdfAndStorey,
  listCalibrationsForPdf,
  listCalibrationsForProject,
  listCalibrationsForStorey,
  updateCalibration,
} from "@ff/data/db/tables/calibrations";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { createPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { putPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { deletePdfFile } from "@ff/data/db/tables/pdfFiles";

import { resetDb } from "../../../db/helpers";

async function makeBuilding() {
  const p = await createProject({ name: "P", metadata: {} });
  return createBuilding({ projectId: p.id, name: "B", metadata: {} });
}

async function makePdfFile(buildingId: string, name: string) {
  const f = await createPdfFile({ buildingId, name });
  // Add a version so deletePdfFile has something to cascade
  // to (deletePdfFile expects a version chain — if empty
  // the cascade is a no-op for pdfVersions but the test
  // still works).
  const v = await createPdfVersion({
    pdfFileId: f.id,
    versionNumber: 1,
    name,
    size: 9,
    contentHash: "h",
    pageCount: 1,
    width: 612,
    height: 792,
    blobKey: `blob-${name}`,
    isLatest: true,
  });
  await putPdfBlob(v.blobKey, new Blob([new Uint8Array([1, 2, 3])]));
  return f;
}

function makeCalibrationInput(
  pdfFileId: string,
  storeyName: string,
  overrides: Partial<Parameters<typeof createCalibration>[0]> = {},
) {
  return {
    projectId: "default-project",
    pdfFileId,
    storeyName,
    pointPairs: [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 1, worldX: 2, worldZ: 2 },
    ] as [{ pdfX: number; pdfY: number; worldX: number; worldZ: number }, { pdfX: number; pdfY: number; worldX: number; worldZ: number }],
    transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
    confidence: 1,
    ...overrides,
  };
}

describe("calibrations table", () => {
  beforeEach(async () => {
    await resetDb("calibrations");
  });

  it("creates a calibration row with id and timestamps", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    const c = await createCalibration(makeCalibrationInput(f.id, "Level 1"));
    expect(c.id).toBeTruthy();
    expect(c.projectId).toBe("default-project");
    expect(c.pdfFileId).toBe(f.id);
    expect(c.storeyName).toBe("Level 1");
    expect(c.createdAt).toBeGreaterThan(0);
    expect(c.updatedAt).toBeGreaterThan(0);
  });

  it("reads a calibration by id", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    const c = await createCalibration(makeCalibrationInput(f.id, "Level 1"));
    const got = await getCalibration(c.id);
    expect(got?.id).toBe(c.id);
  });

  it("getCalibrationForPdfAndStorey looks up by the unique pair", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    const c = await createCalibration(makeCalibrationInput(f.id, "Level 1"));
    const found = await getCalibrationForPdfAndStorey(f.id, "Level 1");
    expect(found?.id).toBe(c.id);
  });

  it("getCalibrationForPdfAndStorey returns undefined when missing", async () => {
    const found = await getCalibrationForPdfAndStorey("nonexistent", "nope");
    expect(found).toBeUndefined();
  });

  it("listCalibrationsForProject returns every row in the project", async () => {
    const b = await makeBuilding();
    const f1 = await makePdfFile(b.id, "a.pdf");
    const f2 = await makePdfFile(b.id, "b.pdf");
    await createCalibration(makeCalibrationInput(f1.id, "L1"));
    await createCalibration(makeCalibrationInput(f1.id, "L2"));
    await createCalibration(makeCalibrationInput(f2.id, "L1"));
    const list = await listCalibrationsForProject("default-project");
    expect(list).toHaveLength(3);
  });

  it("listCalibrationsForStorey scopes to (projectId, storeyName)", async () => {
    const b = await makeBuilding();
    const f1 = await makePdfFile(b.id, "a.pdf");
    const f2 = await makePdfFile(b.id, "b.pdf");
    await createCalibration(makeCalibrationInput(f1.id, "L1"));
    await createCalibration(makeCalibrationInput(f2.id, "L1"));
    await createCalibration(makeCalibrationInput(f1.id, "L2"));
    const list = await listCalibrationsForStorey("default-project", "L1");
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.storeyName === "L1")).toBe(true);
  });

  it("listCalibrationsForPdf scopes to (projectId, pdfFileId)", async () => {
    const b = await makeBuilding();
    const f1 = await makePdfFile(b.id, "a.pdf");
    const f2 = await makePdfFile(b.id, "b.pdf");
    await createCalibration(makeCalibrationInput(f1.id, "L1"));
    await createCalibration(makeCalibrationInput(f1.id, "L2"));
    await createCalibration(makeCalibrationInput(f2.id, "L1"));
    const list = await listCalibrationsForPdf("default-project", f1.id);
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.pdfFileId === f1.id)).toBe(true);
  });

  it("updateCalibration patches fields and bumps updatedAt", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    const c = await createCalibration(makeCalibrationInput(f.id, "L1"));
    const original = c.updatedAt;
    // Bump the clock so the patch is observable.
    await new Promise((r) => setTimeout(r, 5));
    await updateCalibration(c.id, { confidence: 0.95 });
    const got = await getCalibration(c.id);
    expect(got?.confidence).toBe(0.95);
    expect(got?.updatedAt).toBeGreaterThan(original);
  });

  it("deleteCalibration removes the row", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    const c = await createCalibration(makeCalibrationInput(f.id, "L1"));
    await deleteCalibration(c.id);
    const got = await getCalibration(c.id);
    expect(got).toBeUndefined();
  });

  it("deleteCalibrationsForPdf removes all rows for a file", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    await createCalibration(makeCalibrationInput(f.id, "L1"));
    await createCalibration(makeCalibrationInput(f.id, "L2"));
    await deleteCalibrationsForPdf(f.id);
    const list = await listCalibrationsForPdf("default-project", f.id);
    expect(list).toHaveLength(0);
  });

  it("deletePdfFile cascades to its calibrations", async () => {
    const b = await makeBuilding();
    const f = await makePdfFile(b.id, "a.pdf");
    await createCalibration(makeCalibrationInput(f.id, "L1"));
    await createCalibration(makeCalibrationInput(f.id, "L2"));
    await deletePdfFile(f.id);
    const list = await listCalibrationsForPdf("default-project", f.id);
    expect(list).toHaveLength(0);
  });
});
