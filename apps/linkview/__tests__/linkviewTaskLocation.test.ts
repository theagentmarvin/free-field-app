import { describe, expect, it } from "vitest";

import { applyCalibration } from "@ff/data/calibration/similarity";

import { linkviewLocationFromBim, type LinkviewPlanContext } from "../src/linkviewTaskLocation";

// 1 pdf point = 0.01 world metre, no rotation, page origin at world (10, 20).
const params = { scale: 0.01, rotation: 0, translateX: 10, translateZ: 20 };
const plan: LinkviewPlanContext = {
  pdfFileId: "p1",
  versionId: "p1v2",
  calibration: { id: "cal-uuid", storeyName: "L1", transformParams: params as never, updatedAt: 1 },
  pageWidth: 1000,
  pageHeight: 800,
};
const bimLocation = (wp: [number, number, number] | null) => ({
  storeyName: null,
  bim: {
    elements: [{ modelId: "m1", expressId: 7 }],
    worldPoint: wp,
    cameraPose: { pos: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false },
  },
  pdf: null,
});

describe("linkviewLocationFromBim", () => {
  it("projects the tapped world point through the calibration onto page 1", () => {
    // pdf point (250, 400) -> world
    const w = applyCalibration(params as never, { x: 250, y: 400 });
    const r = linkviewLocationFromBim(bimLocation([w.x, 1.7, w.z]), plan)!;
    expect(r.uv[0]).toBeCloseTo(0.25, 6);
    expect(r.uv[1]).toBeCloseTo(0.5, 6);
    expect(r.location.pdf).toMatchObject({
      pdfFileId: "p1",
      page: 1,
      calibId: "p1__L1", // canonical calibration id, not the local row uuid
      pdfVersionId: "p1v2",
    });
    expect(r.location.pdf!.uv[0]).toBeCloseTo(0.25, 6);
  });

  it("keeps the 3D placement untouched and stamps the origin + storey", () => {
    const w = applyCalibration(params as never, { x: 100, y: 100 });
    const input = bimLocation([w.x, 0, w.z]);
    const r = linkviewLocationFromBim(input, plan)!;
    expect(r.location.origin).toBe("linkview");
    expect(r.location.storeyName).toBe("L1"); // filled from the calibration when the 3D side had none
    expect(r.location.bim).toBe(input.bim);
  });

  it("keeps an existing storey name", () => {
    const w = applyCalibration(params as never, { x: 100, y: 100 });
    const r = linkviewLocationFromBim({ ...bimLocation([w.x, 0, w.z]), storeyName: "Roof" }, plan)!;
    expect(r.location.storeyName).toBe("Roof");
  });

  it("returns null (ordinary 3D task) when the point is off the open page", () => {
    const w = applyCalibration(params as never, { x: 5000, y: 100 });
    expect(linkviewLocationFromBim(bimLocation([w.x, 0, w.z]), plan)).toBeNull();
  });

  it("returns null without a 3D world point", () => {
    expect(linkviewLocationFromBim(bimLocation(null), plan)).toBeNull();
    expect(linkviewLocationFromBim({ storeyName: null, bim: null, pdf: null }, plan)).toBeNull();
  });
});
