// The synthetic bundle is only a valid overlay oracle if its PDF linework is
// EXACTLY pdfToModel^-1 of the IFC wall corners. Check that, for several
// rotations, against the real converted fragment.
import JSZip from "jszip";
import * as FRAGS from "@thatopen/fragments";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ff/viewer", () => ({
  validatePDFBuffer: () => undefined,
  loadPDF: async () => ({ numPages: 1, width: 1000, height: 800, destroy: () => undefined }),
}));

import { applyCalibration } from "@ff/data/calibration/similarity";
import { db } from "@ff/data/db/database";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";

import { importBundle } from "../../src/bundle/importBundle";
import { parseBundle } from "../../src/bundle/parseBundle";
import { readVersionShift } from "../../src/bundle/fragCoordinates";
import { resetDb } from "../db/helpers";
import { applyAffine, buildSyntheticBundle, PAGE, WALLS } from "./fixtures/syntheticBundle";

describe.each([0, 25, 90, -45])("synthetic fixture geometry (%i deg)", (deg) => {
  const rot = (deg * Math.PI) / 180;

  it("PDF outlines map through pdfToModel onto the authored wall corners and are drawn in the PDF", async () => {
    const fx = await buildSyntheticBundle({ rotationRad: rot });
    for (const w of WALLS) {
      fx.elementOutlines[w.gid]!.forEach(([px, py], i) => {
        const m = applyAffine(fx.affine, px, py);
        expect(m.x).toBeCloseTo(fx.wallCorners[w.gid]![i]![0], 6);
        expect(m.y).toBeCloseTo(fx.wallCorners[w.gid]![i]![1], 6);
      });
      // authored wall = centre +- half extents
      const xs = fx.wallCorners[w.gid]!.map((c) => c[0]);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(w.centre[0], 9);
    }
    const zip = await JSZip.loadAsync(fx.bytes);
    const pdf = new TextDecoder("latin1").decode(await zip.file("sheets/A101.pdf")!.async("uint8array"));
    const o = fx.elementOutlines[WALLS[0]!.gid]!;
    expect(pdf).toContain(`${o[0]![0]} ${PAGE.h - o[0]![1]} m`);
    expect(pdf).toContain(`${o[2]![0]} ${PAGE.h - o[2]![1]} l`);
    expect(pdf).toContain(" h S");
  });

  it("the calibration puts every drawn wall outline on its fragment footprint (FreeField frame)", async () => {
    await resetDb("fixtureGeometry");
    const project = await createProject({ name: "P", metadata: {} });
    const building = await createBuilding({ projectId: project.id, name: "B", metadata: {} });
    const fx = await buildSyntheticBundle({ rotationRad: rot });
    const report = await importBundle({ bundle: await parseBundle(fx.bytes), projectId: project.id, buildingId: building.id });
    expect(report.calibrationsCreated).toBe(1);
    const cal = (await db.calibrations.toArray())[0]!;
    const version = (await db.ifcVersions.toArray())[0]!;
    const b = await readVersionShift(version.id);
    const model = new FRAGS.SingleThreadedFragmentsModel("fg", new Uint8Array(await (await getFragBlob(version.fragBlobKey))!.arrayBuffer()), true);
    await model.ready;
    try {
      const ids = model.getLocalIdsByGuids(WALLS.map((w) => w.gid));
      WALLS.forEach((w, i) => {
        const pos = model.getPositions([ids[i]!])[0]!;
        // centroid of the drawn outline in world, via the stored calibration
        const o = fx.elementOutlines[w.gid]!;
        const cx = o.reduce((s, p) => s + p[0], 0) / o.length;
        const cy = o.reduce((s, p) => s + p[1], 0) / o.length;
        const wc = applyCalibration(cal.transformParams, { x: cx, y: cy });
        expect(wc.x).toBeCloseTo(pos.x, 3);
        expect(wc.z).toBeCloseTo(pos.z, 3);
        // and every outline corner sits on the wall footprint: model corner + b, z negated
        o.forEach(([px, py], k) => {
          const world = applyCalibration(cal.transformParams, { x: px, y: py });
          const [mx, my] = fx.wallCorners[w.gid]![k]!;
          expect(world.x).toBeCloseTo(mx + b[0], 5);
          expect(world.z).toBeCloseTo(-my + b[2], 5);
        });
      });
    } finally {
      model.dispose();
    }
  });
});
