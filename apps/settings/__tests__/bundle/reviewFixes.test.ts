// Regression tests for the code-review findings I1-I7 and the parse cap.
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: async () => ({ numPages: 1, width: 1000, height: 800, destroy: () => undefined }),
}));

import { ingestIfc } from "@ff/data/hooks";
import { db } from "@ff/data/db/database";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";

import { buildCalibration, CalibrationInputError } from "../../src/bundle/bundleCalibration";
import {
  assignSheetPdfNames,
  BASE_SHIFT_KEY,
  importBundle,
  sanitizeNamePart,
} from "../../src/bundle/importBundle";
import { MAX_MANIFEST_BYTES, parseBundle } from "../../src/bundle/parseBundle";
import { resetDb } from "../db/helpers";
import { buildSyntheticBundle, planAffine } from "./fixtures/syntheticBundle";

async function setup(name = "rf") {
  await resetDb(name);
  const p = await createProject({ name: "P", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { projectId: p.id, buildingId: b.id };
}

/** Rewrite a synthetic bundle's manifest (and optionally other entries). */
async function edit(
  bytes: Uint8Array,
  fn: (m: any, zip: JSZip) => void | Promise<void>,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const m = JSON.parse(await zip.file("manifest.json")!.async("string"));
  await fn(m, zip);
  zip.file("manifest.json", JSON.stringify(m));
  return zip.generateAsync({ type: "uint8array" });
}

describe("I1 colliding sheet names never merge", () => {
  it("assigns distinct names and sanitises", () => {
    const r = assignSheetPdfNames([
      { id: "1", number: "A/1", name: "Plan" },
      { id: "2", number: "A_1", name: "Plan" },
      { id: "3", number: "A_1", name: "Plan" },
      { id: "4", number: "", name: "" },
    ]);
    expect(r.map((x) => x.name)).toEqual(["A_1 - Plan.pdf", "A_1 - Plan (2).pdf", "A_1 - Plan (3).pdf", "4.pdf"]);
    expect(r[1]!.renamedFrom).toBe("A_1 - Plan.pdf");
    expect(sanitizeNamePart("a\u0001b. ")).toBe("a_b");
    expect(sanitizeNamePart("x".repeat(200)).length).toBe(80);
  });

  it("imports two same-named sheets as two PDFs, each keeping its own calibration", async () => {
    const { projectId, buildingId } = await setup("i1");
    const fx = await buildSyntheticBundle();
    const bytes = await edit(fx.bytes, (m) => {
      const [a, b] = m.sheets;
      b.number = a.number;
      b.name = a.name;
      // give the second sheet its own plan viewport so both calibrate
      b.viewports = [{ ...a.viewports[0], id: "vp-dup", primary: true }];
    });
    const report = await importBundle({ bundle: await parseBundle(bytes), projectId, buildingId });
    const files = await db.pdfFiles.where("buildingId").equals(buildingId).toArray();
    expect(files.map((f) => f.name).sort()).toEqual(["A101 - First Floor Plan (2).pdf", "A101 - First Floor Plan.pdf"]);
    expect(await db.pdfVersions.count()).toBe(2); // not v1 + v2 of one file
    expect(report.calibrationsCreated).toBe(2);
    expect(new Set((await db.calibrations.toArray()).map((c) => c.pdfFileId)).size).toBe(2);
    expect(report.warnings.join()).toMatch(/imported as "A101 - First Floor Plan \(2\)\.pdf"/);
  });
});

describe("I2 full-content dedupe", () => {
  function pdfWith(marker: string): Uint8Array {
    const body = new Uint8Array(150_000).fill(32);
    body.set(new TextEncoder().encode("%PDF-1.7\n"));
    body.set(new TextEncoder().encode(marker), 120_000); // beyond the first 64 KiB
    return body;
  }
  async function bundleWith(marker: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      schema: "freefield.bundle/1", project: { name: "P" }, models: [],
      sheets: [{ id: "s", number: "S1", name: "Big", file: "sheets/S1.pdf", viewports: [] }],
    }));
    zip.file("sheets/S1.pdf", pdfWith(marker));
    return zip.generateAsync({ type: "uint8array" });
  }

  it("treats a same-size edit past 64 KiB as a new version", async () => {
    const { projectId, buildingId } = await setup("i2");
    const a = await importBundle({ bundle: await parseBundle(await bundleWith("120")), projectId, buildingId });
    const same = await importBundle({ bundle: await parseBundle(await bundleWith("120")), projectId, buildingId });
    const edited = await importBundle({ bundle: await parseBundle(await bundleWith("121")), projectId, buildingId });
    expect(a.sheets[0]!.status).toBe("imported");
    expect(same.sheets[0]!.status).toBe("unchanged");
    expect(edited.sheets[0]!.status).toBe("newVersion");
    expect(await db.pdfVersions.count()).toBe(2);
  });
});

describe("I3 failed model never falls back to another model", () => {
  it("skips (with a warning) a viewport whose model failed", async () => {
    const { projectId, buildingId } = await setup("i3");
    const fx = await buildSyntheticBundle();
    const bytes = await edit(fx.bytes, async (m, zip) => {
      m.models.push({ id: "bad", file: "models/bad.ifc", storeys: [{ name: "Level 1" }] });
      zip.file("models/bad.ifc", "garbage");
      m.sheets[0].viewports[0].modelId = "bad";
    });
    const report = await importBundle({
      bundle: await parseBundle(bytes), projectId, buildingId,
      deps: { ingestIfc: (o) => (o.file.name === "bad.ifc" ? Promise.reject(new Error("boom")) : ingestIfc(o)) },
    });
    expect(report.models.find((x) => x.id === "bad")!.status).toBe("failed");
    expect(report.calibrationsCreated).toBe(0);
    expect(await db.calibrations.count()).toBe(0);
    expect(report.warnings.join()).toMatch(/model "bad" was not imported/);
  });
});

describe("I4 mirrored pages are not calibrated", () => {
  it("buildCalibration throws for a mirrored or anisotropic affine", () => {
    const a = planAffine(0);
    const cps = [
      { pdfX: 0, pdfY: 0, modelX: a[2], modelY: a[5] },
      { pdfX: 100, pdfY: 100, modelX: a[2] + 3.4, modelY: a[5] - 3.4 },
    ];
    const mirrored = [...a] as typeof a;
    mirrored[4] = -mirrored[4];
    expect(() => buildCalibration(cps, [0, 0, 0], mirrored)).toThrow(CalibrationInputError);
    expect(() => buildCalibration(cps, [0, 0, 0], mirrored)).toThrow(/mirrored/);
    const aniso = [...a] as typeof a;
    aniso[0] *= 2;
    expect(() => buildCalibration(cps, [0, 0, 0], aniso)).toThrow(/not uniform/);
    expect(() => buildCalibration(cps, [0, 0, 0], a)).not.toThrow();
  });

  it("the importer skips such a viewport with a warning", async () => {
    const { projectId, buildingId } = await setup("i4");
    const fx = await buildSyntheticBundle();
    const bytes = await edit(fx.bytes, (m) => {
      const v = m.sheets[0].viewports[0];
      v.pdfToModel[4] = -v.pdfToModel[4]; // pdfRegion corners are re-derived? control points stay
    });
    const report = await importBundle({ bundle: await parseBundle(bytes), projectId, buildingId });
    expect(report.calibrationsCreated).toBe(0);
    expect(report.warnings.join()).toMatch(/calibration failed \(.*mirrored/);
  });
});

describe("I7 base model guard + persisted base shift", () => {
  beforeEach(() => undefined);

  it("persists b on the building and warns when a later import sees another b", async () => {
    const { projectId, buildingId } = await setup("i7a");
    const fx = await buildSyntheticBundle();
    const first = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    const stored = (await db.buildings.get(buildingId))!.metadata[BASE_SHIFT_KEY] as number[];
    expect(stored).toHaveLength(3);
    expect(first.warnings).toEqual([]);
    // simulate a different base at the previous import
    await db.buildings.update(buildingId, { metadata: { [BASE_SHIFT_KEY]: [stored[0]! + 5, stored[1]!, stored[2]!] } });
    const second = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    expect(second.warnings.join()).toMatch(/base model coordinates changed/);
    expect((await db.buildings.get(buildingId))!.metadata[BASE_SHIFT_KEY]).toEqual(stored);
  });

  it("skips calibration with ONE warning when every bundle model failed", async () => {
    const { projectId, buildingId } = await setup("i7b");
    const fx = await buildSyntheticBundle();
    await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId }); // building now has a model
    await db.calibrations.clear();
    const report = await importBundle({
      bundle: await parseBundle(fx.bytes), projectId, buildingId,
      deps: { ingestIfc: () => Promise.reject(new Error("boom")) },
    });
    expect(report.calibrationsCreated + report.calibrationsUpdated).toBe(0);
    const msgs = report.warnings.filter((w) => /No model of this bundle/.test(w));
    expect(msgs).toHaveLength(1);
    expect(report.warnings.some((w) => /storey/.test(w))).toBe(false);
  });
});

describe("parseBundle manifest size cap", () => {
  it("rejects a manifest that inflates beyond the limit", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", " ".repeat(MAX_MANIFEST_BYTES + 1024), { compression: "DEFLATE" });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.length).toBeLessThan(200_000);
    await expect(parseBundle(bytes)).rejects.toThrow(/too large|compression ratio/);
  });
});

describe("import report timings", () => {
  it("reports wall-clock per phase and shows them in the summary", async () => {
    const { projectId, buildingId } = await setup("timings");
    const fx = await buildSyntheticBundle();
    const { summarizeReport } = await import("../../src/bundle/importBundle");
    const report = await importBundle({ bundle: await parseBundle(fx.bytes), projectId, buildingId });
    const t = report.timings;
    expect(t.modelsMs).toBeGreaterThan(0);
    expect(t.pdfsMs).toBeGreaterThan(0);
    for (const v of Object.values(t)) expect(Number.isFinite(v) && v >= 0).toBe(true);
    expect(summarizeReport(report).some((l) => /^Time: model [\d.]+ s, PDFs [\d.]+ s, calibration [\d.]+ s$/.test(l))).toBe(true);
  });
});
