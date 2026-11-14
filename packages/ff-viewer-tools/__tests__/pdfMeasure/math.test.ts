import { describe, expect, it } from "vitest";

import {
  centroid,
  clientToPage,
  distance,
  pageToClient,
  polygonArea,
  polygonPerimeter,
  polylineLength,
  rotatePagePoint,
  segmentLengths,
  snapToPoints,
} from "../../src/pdfMeasure/geometry";
import {
  pickCalibrationScale,
  resolvePageScale,
  scaleFromCalibration,
  scaleFromTwoPoints,
  toMetres,
} from "../../src/pdfMeasure/scale";
import { formatArea, formatLength } from "../../src/pdfMeasure/format";
import { applyCalibration } from "../../../ff-data/src/calibration/similarity";

describe("geometry", () => {
  it("polyline segments and total", () => {
    const pts = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }];
    expect(segmentLengths(pts)).toEqual([5, 6]);
    expect(polylineLength(pts)).toBe(11);
    expect(polylineLength([{ x: 1, y: 1 }])).toBe(0);
  });
  it("area and perimeter of a rectangle, either winding", () => {
    const r = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }];
    expect(polygonArea(r)).toBe(50);
    expect(polygonArea([...r].reverse())).toBe(50);
    expect(polygonPerimeter(r)).toBe(30);
    expect(polygonArea(r.slice(0, 2))).toBe(0);
    expect(centroid(r)).toEqual({ x: 5, y: 2.5 });
  });
  it("snaps to nearest candidate within radius only", () => {
    const c = [{ x: 10, y: 10 }, { x: 12, y: 10 }];
    expect(snapToPoints({ x: 11.5, y: 10 }, c, 1)).toEqual({ point: c[1], snapped: true });
    expect(snapToPoints({ x: 50, y: 50 }, c, 1).snapped).toBe(false);
  });
  it("client <-> page round trip under zoom and pan", () => {
    const rect = { left: 100, top: 40, width: 1200, height: 800 }; // 2x zoom of a 600x400 page
    const p = clientToPage(400, 240, rect, 600, 400)!;
    expect(p).toEqual({ x: 150, y: 100 });
    expect(pageToClient(p, rect, 600, 400)).toEqual({ x: 400, y: 240 });
    expect(clientToPage(0, 0, { ...rect, width: 0 }, 600, 400)).toBeNull();
  });
  it("rotatePagePoint quarter turns", () => {
    const p = { x: 10, y: 20 };
    expect(rotatePagePoint(p, 0, 100, 200)).toEqual(p);
    expect(rotatePagePoint(p, 1, 100, 200)).toEqual({ x: 180, y: 10 });
    expect(rotatePagePoint(p, 2, 100, 200)).toEqual({ x: 90, y: 180 });
    expect(rotatePagePoint(p, 3, 100, 200)).toEqual({ x: 20, y: 90 });
    expect(rotatePagePoint(p, 4, 100, 200)).toEqual(p);
    expect(rotatePagePoint(p, -1, 100, 200)).toEqual(rotatePagePoint(p, 3, 100, 200));
  });
});

describe("scale", () => {
  it("calibration scale matches world distance of a rotated calibration", () => {
    const params = { scale: 0.05, rotation: 0.7, translateX: 12, translateZ: -3 };
    const a = { x: 100, y: 100 };
    const b = { x: 400, y: 260 };
    const wa = applyCalibration(params, a);
    const wb = applyCalibration(params, b);
    const worldDist = Math.hypot(wb.x - wa.x, wb.z - wa.z);
    const s = scaleFromCalibration(params);
    expect(s.source).toBe("calibrated");
    expect(distance(a, b) * s.metresPerUnit!).toBeCloseTo(worldDist, 9);
  });
  it("rejects invalid calibration", () => {
    expect(scaleFromCalibration({ scale: 0 }).metresPerUnit).toBeNull();
    expect(scaleFromCalibration(null).source).toBe("none");
  });
  it("manual scale from two points and units", () => {
    const s = scaleFromTwoPoints({ x: 0, y: 0 }, { x: 0, y: 200 }, toMetres(10, "ft"))!;
    expect(s.metresPerUnit).toBeCloseTo(3.048 / 200, 12);
    expect(scaleFromTwoPoints({ x: 1, y: 1 }, { x: 1, y: 1 }, 5)).toBeNull();
    expect(scaleFromTwoPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, 0)).toBeNull();
  });
  it("resolution: manual wins; calibration only on page 1; else none", () => {
    expect(resolvePageScale({ page: 1, manualMetresPerUnit: 0.1, calibrationMetresPerUnit: 0.2 })).toEqual({ source: "manual", metresPerUnit: 0.1 });
    expect(resolvePageScale({ page: 1, calibrationMetresPerUnit: 0.2 }).source).toBe("calibrated");
    expect(resolvePageScale({ page: 2, calibrationMetresPerUnit: 0.2 }).source).toBe("none");
    expect(resolvePageScale({ page: 1 }).metresPerUnit).toBeNull();
  });
  it("pickCalibrationScale uses latest row of the project", () => {
    const rows = [
      { projectId: "p", updatedAt: 1, transformParams: { scale: 1 } },
      { projectId: "p", updatedAt: 5, transformParams: { scale: 2 } },
      { projectId: "q", updatedAt: 9, transformParams: { scale: 3 } },
    ];
    expect(pickCalibrationScale(rows, "p")).toBe(2);
    expect(pickCalibrationScale(rows, null)).toBeNull();
    expect(pickCalibrationScale(rows, "z")).toBeNull();
  });
});

describe("format", () => {
  it("never shows metres when uncalibrated", () => {
    const none = { source: "none" as const, metresPerUnit: null };
    expect(formatLength(100, none)).toBe("100.0 pt");
    expect(formatArea(2500, none)).toBe("2500 pt²");
  });
  it("calibrated units", () => {
    const s = { source: "calibrated" as const, metresPerUnit: 0.01 };
    expect(formatLength(500, s)).toBe("5.00 m");
    expect(formatLength(50, s)).toBe("50.0 cm");
    expect(formatLength(0.5, s)).toBe("5 mm");
    expect(formatArea(10000, s)).toBe("1.00 m²");
  });
});
