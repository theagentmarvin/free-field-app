// Opt-in end-to-end check against a real exported bundle.
//   FF_E2E_BUNDLE=<path to .ffbundle/.zip> pnpm exec vitest run __tests__/bundle/e2e.realBundle.test.ts
// Skipped when the variable is unset (CI unaffected). Never commit the bundle.
//
// Runs the real importer (web-ifc conversion, fake-indexeddb) and checks, in
// FreeField's own frame, that every plan element's PDF bbox centre maps
// through the stored calibration onto the element's position in the
// converted fragments model.

import { readFileSync } from "node:fs";
import * as FRAGS from "@thatopen/fragments";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: async () => ({ numPages: 1, width: 1000, height: 800, destroy: () => undefined }),
}));

import { applyCalibration, invertCalibration } from "@ff/data/calibration/similarity";
import { db } from "@ff/data/db/database";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";

import { importBundle } from "../../src/bundle/importBundle";
import { parseBundle } from "../../src/bundle/parseBundle";
import { readVersionShift } from "../../src/bundle/fragCoordinates";
import { resetDb } from "../db/helpers";

const path = process.env.FF_E2E_BUNDLE;

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
}

describe.skipIf(!path)("real bundle e2e", () => {
  it("imports, calibrates and maps elements onto the converted model", async () => {
    await resetDb("e2e-real");
    const project = await createProject({ name: "E2E", metadata: {} });
    const building = await createBuilding({ projectId: project.id, name: "B", metadata: {} });
    const bundle = await parseBundle(new Uint8Array(readFileSync(path!)));
    const m = bundle.manifest;
    const expectedPlans = m.sheets.flatMap((s) => s.viewports.filter((v) => v.primary && v.pdfToModel && v.storeyName));

    const t0 = Date.now();
    const report = await importBundle({ bundle, projectId: project.id, buildingId: building.id });
    // eslint-disable-next-line no-console
    console.log(`[e2e] import wall clock ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // eslint-disable-next-line no-console
    console.log("[e2e] warnings:", report.warnings);
    expect(report.models.every((x) => x.status === "imported")).toBe(true);
    expect(report.sheets.every((s) => s.status === "imported")).toBe(true);
    expect(report.calibrationsCreated).toBe(expectedPlans.length);
    expect(expectedPlans.length).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);

    const cals = await db.calibrations.toArray();
    expect(cals).toHaveLength(expectedPlans.length);
    const storeys = await db.storeys.toArray();
    for (const c of cals) expect(storeys.some((s) => s.name === c.storeyName)).toBe(true);

    // b from the frag and the model positions in FreeField's frame.
    const version = (await db.ifcVersions.toArray())[0]!;
    const b = await readVersionShift(version.id);
    const blob = (await getFragBlob(version.fragBlobKey))!;
    const model = new FRAGS.SingleThreadedFragmentsModel("e2e", new Uint8Array(await blob.arrayBuffer()), true);
    await model.ready;
    // eslint-disable-next-line no-console
    console.log("[e2e] base shift b =", b);

    // Several PDFs may map to the same storey: one calibration per (pdf, storey).
    const perStorey = new Map<string, number>();
    for (const c of cals) perStorey.set(c.storeyName, (perStorey.get(c.storeyName) ?? 0) + 1);
    // eslint-disable-next-line no-console
    console.log("[e2e] calibrations per storey:", JSON.stringify([...perStorey.entries()]));
    expect(new Set(cals.map((c) => `${c.pdfFileId}|${c.storeyName}`)).size).toBe(cals.length);
    let worst = { err: 0, where: "" };
    // Truth 2 (robust to clipped / partially visible elements): the element's model
    // position, mapped back into the PDF, must fall inside its drawn bbox (+0.5 m).
    let inside = 0;
    let insideTotal = 0;
    const all: number[] = [];
    try {
      for (const sheet of m.sheets) {
        const outcome = report.sheets.find((s) => s.number === sheet.number)!;
        const plans = sheet.viewports.filter((v) => v.primary && v.pdfToModel && v.storeyName);
        for (const vp of plans) {
          const cal = cals.find((c) => c.pdfFileId === outcome.pdfFileId && c.storeyName === vp.storeyName)!;
          expect(cal).toBeTruthy();
          const idx = JSON.parse(await bundle.readText(sheet.data)) as {
            elements: Array<{ gid: string; vp: string; bbox: [number, number, number, number] }>;
          };
          const els = idx.elements.filter((e) => e.vp === vp.id);
          const ids = model.getLocalIdsByGuids(els.map((e) => e.gid));
          const errs: number[] = [];
          els.forEach((e, i) => {
            const id = ids[i];
            if (id === null || id === undefined) return;
            const pos = model.getPositions([id])[0];
            if (!pos) return;
            const w = applyCalibration(cal.transformParams, {
              x: (e.bbox[0] + e.bbox[2]) / 2,
              y: (e.bbox[1] + e.bbox[3]) / 2,
            });
            errs.push(Math.hypot(w.x - pos.x, w.z - pos.z));
            const back = invertCalibration(cal.transformParams, { x: pos.x, z: pos.z });
            const pad = 0.5 / cal.transformParams.scale;
            insideTotal += 1;
            if (back.x >= e.bbox[0] - pad && back.x <= e.bbox[2] + pad && back.y >= e.bbox[1] - pad && back.y <= e.bbox[3] + pad) inside += 1;
          });
          const within = errs.filter((x) => x <= 0.5).length;
          // eslint-disable-next-line no-console
          console.log(
            `[e2e] ${sheet.number} / ${vp.storeyName}: ${errs.length}/${els.length} matched, ${within} within 0.5 m (${((100 * within) / Math.max(1, errs.length)).toFixed(1)}%), median ${median(errs).toFixed(3)} m`,
          );
          all.push(...errs);
          const mx = Math.max(0, ...errs);
          if (mx > worst.err) worst = { err: mx, where: `${sheet.number} / ${vp.storeyName}` };
        }
      }
    } finally {
      model.dispose();
    }
    const within = all.filter((x) => x <= 0.5).length;
    // eslint-disable-next-line no-console
    console.log(`[e2e] worst element error ${worst.err.toFixed(4)} m at ${worst.where}`);
    // eslint-disable-next-line no-console
    console.log(`[e2e] TOTAL ${all.length} elements, ${within} within 0.5 m (${((100 * within) / all.length).toFixed(1)}%), median ${median(all).toFixed(3)} m`);
    expect(all.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[e2e] model position inside the drawn bbox (+0.5 m): ${inside}/${insideTotal} (${((100 * inside) / insideTotal).toFixed(1)}%)`);
    expect(inside / insideTotal).toBeGreaterThanOrEqual(0.9);
    expect(median(all)).toBeLessThan(0.25);

    // A RE-EXPORT of the same project (FF_E2E_BUNDLE_2): versions the model and changed sheets.
    const path2 = process.env.FF_E2E_BUNDLE_2;
    if (path2) {
      const bundle2 = await parseBundle(new Uint8Array(readFileSync(path2)));
      const r2 = await importBundle({ bundle: bundle2, projectId: project.id, buildingId: building.id });
      // eslint-disable-next-line no-console
      console.log(`[e2e] re-export: models ${r2.models.map((m) => m.change)}, sheets new ${r2.sheets.filter((s) => s.status === "imported").length} / newVersion ${r2.sheets.filter((s) => s.status === "newVersion").length} / unchanged ${r2.sheets.filter((s) => s.status === "unchanged").length}; calibrations created ${r2.calibrationsCreated} updated ${r2.calibrationsUpdated}`);
      expect(await db.ifcFiles.count()).toBe(1);
      expect(await db.ifcVersions.count()).toBe(2);
      expect(r2.models[0]!.change).toBe("newVersion");
      expect(r2.sheets.filter((s) => s.status === "imported")).toHaveLength(0);
      expect(await db.pdfFiles.count()).toBe(m.sheets.length);
      expect(await db.calibrations.count()).toBe(expectedPlans.length);
      return;
    }
    // Re-import: nothing new.
    const counts = async () => [await db.ifcVersions.count(), await db.pdfVersions.count(), await db.calibrations.count(), await db.pdfFiles.count()];
    const before = await counts();
    const again = await importBundle({ bundle, projectId: project.id, buildingId: building.id });
    expect(await counts()).toEqual(before);
    expect(again.calibrationsCreated).toBe(0);
    expect(again.calibrationsUpdated).toBe(expectedPlans.length);
    expect(again.sheets.every((s) => s.status === "unchanged")).toBe(true);
  }, 600_000);
});
