// Re-importing a (re-exported) bundle versions the existing items: v2, v3 ...
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: async () => ({ numPages: 1, width: 1000, height: 800, destroy: () => undefined }),
}));

import { db } from "@ff/data/db/database";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";

import { importBundle, summarizeReport } from "../../src/bundle/importBundle";
import { parseBundle } from "../../src/bundle/parseBundle";
import { resetDb } from "../db/helpers";
import { buildSyntheticBundle } from "./fixtures/syntheticBundle";

/** A re-export: renamed model key/file, changed IFC + A101 bytes, A201 renamed but identical. */
async function reExport(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const m = JSON.parse(await zip.file("manifest.json")!.async("string"));
  const ifc = await zip.file("models/arch.ifc")!.async("string");
  zip.remove("models/arch.ifc");
  zip.file("models/arch_r2.ifc", ifc + "\n");
  m.models[0].id = "arch_r2";
  m.models[0].file = "models/arch_r2.ifc";
  m.models[0].name = "Arch r2";
  for (const s of m.sheets) for (const v of s.viewports) if (v.modelId) v.modelId = "arch_r2";
  const pdf = await zip.file("sheets/A101.pdf")!.async("uint8array");
  zip.file("sheets/A101.pdf", new Uint8Array([...pdf, 32, 32, 32]));
  m.sheets[1].name = "Sections Revised"; // same sheet id/number, renamed, bytes identical
  zip.file("manifest.json", JSON.stringify(m));
  return zip.generateAsync({ type: "uint8array" });
}

describe("bundle re-import versions instead of duplicating", () => {
  it("makes v2 of the model and changed sheets, keeps identical ones, moves calibrations", async () => {
    await resetDb("versioning");
    const p = await createProject({ name: "P", metadata: {} });
    const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
    const fx = await buildSyntheticBundle();
    const first = await importBundle({ bundle: await parseBundle(fx.bytes), projectId: p.id, buildingId: b.id });
    expect(summarizeReport(first)).toContain("Sheets: 2 new, 0 new versions, 0 unchanged, 0 skipped, 0 failed");
    expect(summarizeReport(first)).toContain("Models: 1 new, 0 new versions, 0 unchanged");

    const second = await importBundle({ bundle: await parseBundle(await reExport(fx.bytes)), projectId: p.id, buildingId: b.id });
    // one IFC file with two versions (not a second file), same for the changed sheet
    expect(await db.ifcFiles.count()).toBe(1);
    expect(await db.ifcVersions.count()).toBe(2);
    const files = await db.pdfFiles.where("buildingId").equals(b.id).toArray();
    expect(files.map((f) => f.name).sort()).toEqual(["A101 - First Floor Plan.pdf", "A201 - Sections.pdf"]);
    const a101 = files.find((f) => f.name.startsWith("A101"))!;
    const a201 = files.find((f) => f.name.startsWith("A201"))!;
    const v101 = (await db.pdfVersions.where("pdfFileId").equals(a101.id).toArray()).sort((x, y) => x.versionNumber - y.versionNumber);
    expect(v101.map((v) => [v.versionNumber, v.isLatest])).toEqual([[1, false], [2, true]]);
    expect(await db.pdfVersions.where("pdfFileId").equals(a201.id).count()).toBe(1);
    expect(second.sheets.map((s) => s.status)).toEqual(["newVersion", "unchanged"]);
    expect(second.models[0]!.change).toBe("newVersion");
    expect(summarizeReport(second)).toContain("Sheets: 0 new, 1 new version, 1 unchanged, 0 skipped, 0 failed");
    expect(summarizeReport(second)).toContain("Models: 0 new, 1 new version, 0 unchanged");
    // the calibration lives on and applies to the latest version
    expect(second.calibrationsCreated).toBe(0);
    expect(second.calibrationsUpdated).toBe(1);
    expect(await db.calibrations.count()).toBe(1);
    // a third identical import changes nothing
    const third = await importBundle({ bundle: await parseBundle(await reExport(fx.bytes)), projectId: p.id, buildingId: b.id });
    expect(third.sheets.map((s) => s.status)).toEqual(["unchanged", "unchanged"]);
    expect(third.models[0]!.change).toBe("unchanged");
    expect(await db.ifcVersions.count()).toBe(2);
  });
});
