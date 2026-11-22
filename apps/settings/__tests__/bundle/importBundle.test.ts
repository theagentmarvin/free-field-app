// importBundle against the real (fake-indexeddb) Dexie db, the real web-ifc
// import and base-shift read, with PDF.js mocked (as in usePdfPipeline.test).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: async () => ({ numPages: 1, width: 1000, height: 800, destroy: () => undefined }),
}));

import { db } from "@ff/data/db/database";
import { applyCalibration } from "@ff/data/calibration/similarity";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

import { importBundle, pickBaseIfcFile, sheetPdfName } from "../../src/bundle/importBundle";
import { parseBundle } from "../../src/bundle/parseBundle";
import { readVersionShift } from "../../src/bundle/fragCoordinates";
import { resetDb } from "../db/helpers";
import { applyAffine, buildSyntheticBundle, WALLS } from "./fixtures/syntheticBundle";

async function setup() {
  await resetDb("importBundle");
  const p = await createProject({ name: "P", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { projectId: p.id, buildingId: b.id };
}

describe("sheetPdfName / pickBaseIfcFile", () => {
  it("names PDFs '<number> - <name>.pdf' and cleans path characters", () => {
    expect(sheetPdfName({ number: "S-101", name: "Level 1 / Plan" })).toBe("S-101 - Level 1 _ Plan.pdf");
    expect(sheetPdfName({ number: "A1", name: "" })).toBe("A1.pdf");
  });
  it("picks the first file by name that has a version", () => {
    const files = [
      { id: "1", name: "b.ifc" },
      { id: "2", name: "a.ifc" },
      { id: "3", name: "c.ifc" },
    ];
    expect(pickBaseIfcFile(files)?.id).toBe("2");
    expect(pickBaseIfcFile(files, (f) => f.id !== "2")?.id).toBe("1");
  });
});

describe("importBundle (real db + ifc import)", () => {
  beforeEach(() => undefined);

  it("imports models and sheets and calibrates a rotated plan onto the IFC storey", async () => {
    const { projectId, buildingId } = await setup();
    const theta = (25 * Math.PI) / 180;
    const fx = await buildSyntheticBundle({ rotationRad: theta });
    const progress: string[] = [];
    const report = await importBundle({
      bundle: await parseBundle(fx.bytes),
      projectId,
      buildingId,
      onProgress: (p) => progress.push(p.message),
    });

    expect(report.models[0]).toMatchObject({ status: "imported", storeyNames: ["Level 1"] });
    expect(report.sheets.map((s) => [s.number, s.status])).toEqual([
      ["A101", "imported"],
      ["A201", "imported"],
    ]);
    expect(report.calibrationsCreated).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(progress).toContain("Importing model…");
    expect(progress).toContain("Sheet 2 of 2 — A201");

    const pdfs = await db.pdfFiles.where("buildingId").equals(buildingId).toArray();
    expect(pdfs.map((p) => p.name).sort()).toEqual(["A101 - First Floor Plan.pdf", "A201 - Sections.pdf"]);

    const cals = await db.calibrations.toArray();
    expect(cals).toHaveLength(1);
    const cal = cals[0]!;
    expect(cal.storeyName).toBe("Level 1");
    expect(cal.confidence).toBe(1);
    expect(cal.projectId).toBe(projectId);
    expect(cal.pdfFileId).toBe(report.sheets[0]!.pdfFileId);

    // The calibration puts a PDF point on the world position of the model
    // point, using the shift stored in the converted fragment.
    const version = (await db.ifcVersions.toArray())[0]!;
    const b = await readVersionShift(version.id);
    const m = applyAffine(fx.affine, 321, 456);
    const w = applyCalibration(cal.transformParams, { x: 321, y: 456 });
    expect(w.x).toBeCloseTo(m.x + b[0], 5);
    expect(w.z).toBeCloseTo(-m.y + b[2], 5);
    expect(Math.abs(cal.transformParams.rotation)).toBeCloseTo(theta, 6);

    // Wall A: the PDF centre of its element box maps to the wall's IFC
    // placement (centre 15, 23.1) in the shifted world.
    const box = fx.elementBoxes[WALLS[0]!.gid]!;
    const cw = applyCalibration(cal.transformParams, {
      x: (box[0] + box[2]) / 2,
      y: (box[1] + box[3]) / 2,
    });
    expect(cw.x).toBeCloseTo(15 + b[0], 4);
    expect(cw.z).toBeCloseTo(-23.1 + b[2], 4);

    // The level is marked extracted so it appears in the level list.
    expect(await db.extractedStoreys.count()).toBe(1);
  });

  it("re-import is idempotent: PDFs unchanged, calibration updated not duplicated", async () => {
    const { projectId, buildingId } = await setup();
    const fx = await buildSyntheticBundle();
    const first = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    const second = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    expect(first.calibrationsCreated).toBe(1);
    expect(second.sheets.map((s) => s.status)).toEqual(["unchanged", "unchanged"]);
    expect(second.calibrationsCreated).toBe(0);
    expect(second.calibrationsUpdated).toBe(1);
    expect(await db.calibrations.count()).toBe(1);
    expect(await db.pdfVersions.count()).toBe(2);
    expect(await db.ifcVersions.count()).toBe(1);
  });

  it("creates a building named after the project when none is selected", async () => {
    await resetDb("importBundle-new");
    const p = await createProject({ name: "P", metadata: {} });
    const fx = await buildSyntheticBundle({ projectName: "Tower One" });
    const report = await importBundle({ bundle: await parseBundle(fx.bytes), projectId: p.id, buildingId: null });
    expect(report.createdBuilding).toBe(true);
    expect(report.buildingName).toBe("Tower One");
    const b = await db.buildings.get(report.buildingId);
    expect(b?.name).toBe("Tower One");
    expect(await db.calibrations.count()).toBe(1);
  });

  it("skips calibration with a warning when the storey is not in the IFC", async () => {
    const { projectId, buildingId } = await setup();
    const fx = await buildSyntheticBundle({ viewportStorey: "Level 99" });
    const report = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    expect(report.calibrationsCreated).toBe(0);
    expect(report.warnings.join()).toMatch(/storey "Level 99" not found/);
    expect(await db.calibrations.count()).toBe(0);
    expect(report.sheets[0]!.status).toBe("imported");
  });
});
