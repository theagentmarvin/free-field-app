// __tests__/linkviewNav.test.ts
//
// Wave 57 — unit tests for the pure navigation-view math. No DOM, no
// React: everything here round-trips through the calibration
// similarity transform (from @ff/data/calibration/similarity) and the
// small plain-shape helpers in src/linkviewNav.ts.

import { describe, expect, it } from "vitest";

import type { CalibrationRecord } from "@ff/types";
import { applyCalibration } from "@ff/data/calibration/similarity";

import {
  bearingFromPose,
  bearingTowardCentroid,
  CAMERA_AZIMUTH_EPSILON,
  CAMERA_SYNC_EPSILON,
  clampPdfPoint,
  markerCssPosition,
  firstPersonPose,
  pitchFromPose,
  applyLookDelta,
  walkInputFromKeys,
  walkDelta,
  isEditableTarget,
  lookDirection,
  pdfBearingFromWorld,
  worldBearingFromPdf,
  EYE_HEIGHT,
  LOOK_DISTANCE,
  MAX_PITCH,
  pageCoordsFromClientRect,
  pdfFromWorldPoint,
  planDistance,
  seedPdfPoint,
  seedWorldPoint,
  shouldBackProjectCamera,
  worldFromPdfPoint,
  bearingChanged,
  BEARING_EPSILON,
} from "../src/linkviewNav";
import {
  inferElevationUnitScale,
  resolveStoreyFloorZ,
  shouldDeferForBaseShift,
  overlapTopDownPose,
  DEFAULT_CAMERA_FOV,
  BASE_COORD_MAX_RETRIES,
} from "../src/linkviewNav";

function makeCalibration(overrides?: Partial<CalibrationRecord>): CalibrationRecord {
  return {
    id: "cal-1",
    projectId: "p1",
    pdfFileId: "pdf-1",
    storeyName: "101 FIRST FLOOR",
    pointPairs: [
      { pdfX: 120, pdfY: 340, worldX: -3.5, worldZ: 7.25 },
      { pdfX: 480, pdfY: 340, worldX: 37.5, worldZ: 7.25 },
    ],
    transformParams: {
      scale: 2,
      rotation: Math.PI / 3,
      translateX: -8,
      translateZ: 3,
    },
    confidence: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("seedPdfPoint / seedWorldPoint", () => {
  it("reads the first calibration anchor", () => {
    const record = makeCalibration();
    expect(seedPdfPoint(record)).toEqual({ x: 120, y: 340 });
    expect(seedWorldPoint(record)).toEqual({ x: -3.5, z: 7.25 });
  });
});

describe("firstPersonPose (eye-level first-person nav camera)", () => {
  it("stands EYE_HEIGHT above the storey floor at the world point", () => {
    const pose = firstPersonPose({ x: 4, z: 6 }, 12.5, 0, 0, null);
    expect(EYE_HEIGHT).toBeGreaterThanOrEqual(1.6);
    expect(EYE_HEIGHT).toBeLessThanOrEqual(1.7);
    expect(pose.pos[0]).toBe(4);
    expect(pose.pos[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 10);
    expect(pose.pos[2]).toBe(6);
  });

  it("looks HORIZONTALLY along the bearing (not straight down)", () => {
    const b = Math.PI / 3;
    const pose = firstPersonPose({ x: 1, z: 2 }, 3, b, 0, null);
    // Target at the same height as the eye.
    expect(pose.target[1]).toBeCloseTo(pose.pos[1], 10);
    expect(pose.target[0] - pose.pos[0]).toBeCloseTo(
      Math.cos(b) * LOOK_DISTANCE,
      10,
    );
    expect(pose.target[2] - pose.pos[2]).toBeCloseTo(
      Math.sin(b) * LOOK_DISTANCE,
      10,
    );
    expect(pitchFromPose(pose)).toBeCloseTo(0, 10);
  });

  it("is always perspective, inheriting a perspective fov", () => {
    const persp = firstPersonPose({ x: 0, z: 0 }, 0, 0, 0, {
      pos: [0, 0, 0],
      target: [1, 0, 0],
      fov: 60,
      isOrtho: false,
    });
    expect(persp.isOrtho).toBe(false);
    expect(persp.fov).toBe(60);
    const fromOrtho = firstPersonPose({ x: 0, z: 0 }, 0, 0, 0, {
      pos: [0, 50, 0],
      target: [0, 0, 0],
      fov: 30,
      isOrtho: true,
    });
    expect(fromOrtho.isOrtho).toBe(false);
    expect(fromOrtho.fov).toBe(45);
    expect(firstPersonPose({ x: 0, z: 0 }, 0, 0, 0, null).fov).toBe(45);
  });

  it("clamps the pitch to ±MAX_PITCH", () => {
    const up = firstPersonPose({ x: 0, z: 0 }, 0, 0, Math.PI / 2, null);
    expect(pitchFromPose(up)).toBeCloseTo(MAX_PITCH, 10);
    const down = firstPersonPose({ x: 0, z: 0 }, 0, 0, -Math.PI, null);
    expect(pitchFromPose(down)).toBeCloseTo(-MAX_PITCH, 10);
  });
});

describe("bearing round-trip through the first-person pose", () => {
  it("bearingFromPose(firstPersonPose(b)) === b for every quadrant and pitch", () => {
    for (const b of [-3, -2, -1, -0.25, 0, 0.5, 1.4, 2.2, 3.1]) {
      for (const p of [-0.9, 0, 0.6]) {
        const pose = firstPersonPose({ x: 7, z: -2 }, 4, b, p, null);
        const back = bearingFromPose(pose);
        expect(back).not.toBeNull();
        expect(bearingChanged(b, back!, 1e-9)).toBe(false);
        expect(pitchFromPose(pose)).toBeCloseTo(p, 10);
      }
    }
  });

  it("the seed pose looks toward the model centroid", () => {
    const point = { x: 2, z: 3 };
    const centroid = { x: -8, z: 13 };
    const bearing = bearingTowardCentroid(point, centroid);
    const pose = firstPersonPose(point, 0, bearing, 0, null);
    const back = bearingFromPose(pose)!;
    expect(back).toBeCloseTo(Math.atan2(10, -10), 10);
  });

  it("the look direction is a unit vector", () => {
    const [x, y, z] = lookDirection(1.2, -0.4);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
  });
});

describe("applyLookDelta (drag-to-look)", () => {
  it("drag right turns right (bearing grows), drag up looks up", () => {
    const next = applyLookDelta({ bearing: 0, pitch: 0 }, 100, -50, 0.01);
    expect(next.bearing).toBeCloseTo(1, 10);
    expect(next.pitch).toBeCloseTo(0.5, 10);
  });

  it("clamps the pitch", () => {
    const next = applyLookDelta({ bearing: 0, pitch: 0 }, 0, -1e6, 0.01);
    expect(next.pitch).toBeCloseTo(MAX_PITCH, 10);
  });
});

describe("walk controls (WASD / arrows)", () => {
  it("maps WASD and arrows to forward/right intent", () => {
    expect(walkInputFromKeys(new Set(["KeyW"]))).toEqual({ forward: 1, right: 0 });
    expect(walkInputFromKeys(new Set(["ArrowDown"]))).toEqual({ forward: -1, right: 0 });
    expect(walkInputFromKeys(new Set(["KeyD", "ArrowUp"]))).toEqual({ forward: 1, right: 1 });
    expect(walkInputFromKeys(new Set(["KeyA"]))).toEqual({ forward: 0, right: -1 });
    expect(walkInputFromKeys(new Set(["KeyW", "KeyS"]))).toEqual({ forward: 0, right: 0 });
    expect(walkInputFromKeys(new Set(["KeyQ"]))).toEqual({ forward: 0, right: 0 });
  });

  it("walks along the bearing; strafe right = bearing + 90°", () => {
    const fwd = walkDelta(Math.PI / 2, { forward: 1, right: 0 }, 2);
    expect(fwd.dx).toBeCloseTo(0, 10);
    expect(fwd.dz).toBeCloseTo(2, 10);
    const right = walkDelta(0, { forward: 0, right: 1 }, 1);
    // bearing 0 looks +X; turning right (bearing +90°) faces +Z.
    expect(right.dx).toBeCloseTo(0, 10);
    expect(right.dz).toBeCloseTo(1, 10);
  });

  it("normalises diagonals and idles with no input", () => {
    const d = walkDelta(0.3, { forward: 1, right: 1 }, 1);
    expect(Math.hypot(d.dx, d.dz)).toBeCloseTo(1, 10);
    expect(walkDelta(0.3, { forward: 0, right: 0 }, 1)).toEqual({ dx: 0, dz: 0 });
  });

  it("walking keeps the eye height on the storey", () => {
    const start = firstPersonPose({ x: 0, z: 0 }, 9, 0.7, 0.3, null);
    const d = walkDelta(0.7, { forward: 1, right: 0 }, 5);
    const next = firstPersonPose(
      { x: start.pos[0] + d.dx, z: start.pos[2] + d.dz },
      9,
      0.7,
      0.3,
      start,
    );
    expect(next.pos[1]).toBeCloseTo(9 + EYE_HEIGHT, 10);
    expect(Math.hypot(next.pos[0], next.pos[2])).toBeCloseTo(5, 10);
  });

  it("ignores keys typed into text inputs", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("marker cone bearing on the PDF", () => {
  it("subtracts the calibration rotation and round-trips", () => {
    const params = makeCalibration().transformParams;
    const world = 1.1;
    const page = pdfBearingFromWorld(params, world);
    expect(page).toBeCloseTo(world - params.rotation, 12);
    expect(worldBearingFromPdf(params, page)).toBeCloseTo(world, 12);
  });

  it("a page direction maps to the same world direction through the calibration", () => {
    const params = makeCalibration().transformParams;
    const a = { x: 100, y: 200 };
    const phi = 0.4; // page angle (y-down)
    const b = { x: a.x + Math.cos(phi) * 10, y: a.y + Math.sin(phi) * 10 };
    const wa = worldFromPdfPoint(params, a);
    const wb = worldFromPdfPoint(params, b);
    const worldBearing = Math.atan2(wb.z - wa.z, wb.x - wa.x);
    expect(
      bearingChanged(worldBearingFromPdf(params, phi), worldBearing, 1e-9),
    ).toBe(false);
  });
});

describe("bearingTowardCentroid (seed bearing)", () => {
  it("points from the nav point toward the model centroid", () => {
    // Centroid due +Z of the point → atan2(10−0, 0−0) = π/2.
    expect(
      bearingTowardCentroid({ x: 0, z: 0 }, { x: 0, z: 10 }),
    ).toBeCloseTo(Math.PI / 2, 10);
    // Centroid due −X → atan2(0, −5) = π.
    expect(
      bearingTowardCentroid({ x: 0, z: 0 }, { x: -5, z: 0 }),
    ).toBeCloseTo(Math.PI, 10);
  });

  it("returns 0 when the centroid is unknown (no model loaded)", () => {
    expect(bearingTowardCentroid({ x: 3, z: 4 }, null)).toBe(0);
  });
});

describe("bearingFromPose (live azimuth update / degenerate hold)", () => {
  const pose = (
    pos: [number, number, number],
    target: [number, number, number],
  ) => ({ pos, target, fov: 45, isOrtho: false });

  it("derives the bearing from the pose's horizontal look component", () => {
    // Looking toward +X → atan2(0, 5) = 0.
    expect(
      bearingFromPose(pose([0, 10, 0], [5, 10, 0])),
    ).toBeCloseTo(0, 10);
    // Looking toward +Z → π/2.
    expect(
      bearingFromPose(pose([0, 10, 0], [0, 10, 5])),
    ).toBeCloseTo(Math.PI / 2, 10);
  });

  it("returns null for a straight-down pose (degenerate azimuth)", () => {
    expect(bearingFromPose(pose([3, 50, 4], [3, 0, 4]))).toBeNull();
  });

  it("returns null when the horizontal component is below the epsilon", () => {
    const eps = CAMERA_AZIMUTH_EPSILON;
    const tiny = eps * 0.5;
    const p = pose([0, 10, 0], [tiny, 10, tiny]);
    expect(Math.hypot(p.target[0] - p.pos[0], p.target[2] - p.pos[2])).toBeLessThan(eps);
    expect(bearingFromPose(p)).toBeNull();
  });
});

describe("world ↔ PDF round-trip", () => {
  const params = {
    scale: 3,
    rotation: Math.PI / 3,
    translateX: -2,
    translateZ: 4,
  };

  it("pdf → world → pdf is the identity", () => {
    const pdf = { x: 211, y: 97 };
    const world = worldFromPdfPoint(params, pdf);
    const back = pdfFromWorldPoint(params, world);
    expect(back.x).toBeCloseTo(pdf.x, 10);
    expect(back.y).toBeCloseTo(pdf.y, 10);
  });

  it("world → pdf → world is the identity", () => {
    const world = { x: -11.3, z: 24.7 };
    const pdf = pdfFromWorldPoint(params, world);
    const back = worldFromPdfPoint(params, pdf);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.z).toBeCloseTo(world.z, 10);
  });
});

describe("clampPdfPoint", () => {
  it("clamps to the page bounds", () => {
    expect(clampPdfPoint({ x: -10, y: 900 }, 595, 842)).toEqual({ x: 0, y: 842 });
    expect(clampPdfPoint({ x: 700, y: -5 }, 595, 842)).toEqual({ x: 595, y: 0 });
    expect(clampPdfPoint({ x: 100, y: 100 }, 595, 842)).toEqual({ x: 100, y: 100 });
  });

  it("returns the point unchanged when page dimensions are unknown", () => {
    expect(clampPdfPoint({ x: -10, y: 900 }, 0, 0)).toEqual({ x: -10, y: 900 });
  });
});

describe("markerCssPosition", () => {
  it("multiplies page coords by the RENDER scale", () => {
    expect(markerCssPosition({ x: 120, y: 340 }, 2)).toEqual({
      left: 240,
      top: 680,
    });
  });
});

describe("pageCoordsFromClientRect", () => {
  const rect = { left: 10, top: 20, width: 500, height: 700 };

  it("converts a client point to page coords via total scale", () => {
    // rect.width 500 / totalScale 2 = 250 page-points wide.
    const out = pageCoordsFromClientRect(rect, 2, 210, 220);
    expect(out).toEqual({ x: 100, y: 100 });
  });

  it("returns null for a degenerate rect or non-positive scale", () => {
    expect(
      pageCoordsFromClientRect({ left: 0, top: 0, width: 0, height: 0 }, 2, 0, 0),
    ).toBeNull();
    expect(
      pageCoordsFromClientRect(rect, 0, 0, 0),
    ).toBeNull();
  });
});

describe("shouldBackProjectCamera (one-source-of-truth dragging guard)", () => {
  it("suppresses camera→marker sync while dragging", () => {
    expect(shouldBackProjectCamera(true, true)).toBe(false);
  });

  it("allows camera→marker sync while nav is active and not dragging", () => {
    expect(shouldBackProjectCamera(false, true)).toBe(true);
  });

  it("disallows sync when nav is inactive", () => {
    expect(shouldBackProjectCamera(false, false)).toBe(false);
    expect(shouldBackProjectCamera(true, false)).toBe(false);
  });

  it("exports a positive epsilon so the sync threshold is a genuine distance", () => {
    expect(CAMERA_SYNC_EPSILON).toBeGreaterThan(0);
  });
});

describe("planDistance", () => {
  it("computes the X-Z plan distance", () => {
    expect(planDistance({ x: 0, z: 0 }, { x: 3, z: 4 })).toBeCloseTo(5, 10);
  });
});

describe("bearingChanged (perf gate for the live marker bearing)", () => {
  it("ignores sub-epsilon rotations", () => {
    expect(bearingChanged(1, 1)).toBe(false);
    expect(bearingChanged(1, 1 + BEARING_EPSILON * 0.5)).toBe(false);
  });

  it("reports rotations beyond the epsilon in either direction", () => {
    expect(bearingChanged(1, 1 + BEARING_EPSILON * 2)).toBe(true);
    expect(bearingChanged(1, 1 - BEARING_EPSILON * 2)).toBe(true);
  });

  it("measures the shortest angle across the ±π seam", () => {
    expect(bearingChanged(Math.PI - 0.001, -Math.PI + 0.001)).toBe(false);
    expect(bearingChanged(Math.PI - 0.1, -Math.PI + 0.1)).toBe(true);
  });
});

describe("storey floor Z (wave 63)", () => {
  const row = (
    name: string,
    elevation: number,
    ifcVersionId = "v1",
    sourceIfcFileId = "f1",
  ) => ({ name, elevation, ifcVersionId, sourceIfcFileId });

  it("infers millimetres from the storey spacing", () => {
    expect(inferElevationUnitScale([0, 3500, 7000])).toBe(0.001);
    expect(inferElevationUnitScale([0, 3.5, 7])).toBe(1);
    // Absolute (sea-level) metres stay metres.
    expect(inferElevationUnitScale([2240, 2243.5, 2247])).toBe(1);
  });

  it("single storey: centroid tie-break, else a large-value fallback", () => {
    expect(inferElevationUnitScale([3000], 4)).toBe(0.001);
    expect(inferElevationUnitScale([3], 4)).toBe(1);
    expect(inferElevationUnitScale([12000])).toBe(0.001);
    expect(inferElevationUnitScale([12.5])).toBe(1);
  });

  it("converts each federated model with its own unit and ignores stale versions", () => {
    const rows = [
      row("L1", 3500, "arch-v2", "arch"),
      row("L0", 0, "arch-v2", "arch"),
      row("L2", 7000, "arch-v2", "arch"),
      row("L1", 3.2, "str-v1", "str"),
      row("L0", 0, "str-v1", "str"),
      row("L1", 99, "arch-v1", "arch"), // stale version
    ];
    const current = new Set(["arch-v2", "str-v1"]);
    // Lowest floor across models wins (level-plan rule).
    expect(
      resolveStoreyFloorZ("L1", rows, { currentVersionIds: current }),
    ).toBeCloseTo(3.2, 6);
    // The open level's model is preferred.
    expect(
      resolveStoreyFloorZ("L1", rows, {
        currentVersionIds: current,
        preferredIfcFileId: "arch",
      }),
    ).toBeCloseTo(3.5, 6);
    expect(resolveStoreyFloorZ("Roof", rows)).toBeNull();
  });

  it("adds the base model's vertical shift so the plane sits on the storey", () => {
    const rows = [row("L1", 3.2, "str-v1", "str")];
    expect(resolveStoreyFloorZ("L1", rows, { modelShiftY: -6 })).toBeCloseTo(-2.8, 9);
    expect(resolveStoreyFloorZ("L1", rows, { modelShiftY: null })).toBeCloseTo(3.2, 9);
    expect(resolveStoreyFloorZ("Roof", rows, { modelShiftY: -6 })).toBeNull();
  });
});

describe("shouldDeferForBaseShift", () => {
  it("defers only while a model exists but its base coordinates are unknown", () => {
    const none = { getBaseCoordinates: () => null };
    const ready = { getBaseCoordinates: () => [0, 0.15, 0] };
    expect(shouldDeferForBaseShift(none, true, 0)).toBe(true);
    expect(shouldDeferForBaseShift(null, true, 0)).toBe(true); // viewer not mounted yet
    expect(shouldDeferForBaseShift(ready, true, 0)).toBe(false);
    expect(shouldDeferForBaseShift(none, false, 0)).toBe(false); // no model: nothing to wait for
    expect(shouldDeferForBaseShift(none, true, BASE_COORD_MAX_RETRIES)).toBe(false); // gives up
    expect(shouldDeferForBaseShift({}, true, 0)).toBe(false); // handle without the method
  });
});

describe("feet models (storey elevations stored in feet)", () => {
  // Elevations of a 5-storey + roofs building in FEET (about -17 ft .. 71 ft).
  const FEET = [-16.92, -5.92, -3.46, 0, 5.5, 8.08, 18.83, 32.17, 45.5, 52.67, 58.83, 68.83, 70.83];
  it("reads feet when the centroid height matches the foot reading, metres otherwise", () => {
    expect(inferElevationUnitScale(FEET, 8.2)).toBeCloseTo(0.3048, 9);
    // the same numbers in a metre model with a centroid ~27 m up stay metres
    expect(inferElevationUnitScale(FEET, 27)).toBe(1);
    // millimetres still win on spacing
    expect(inferElevationUnitScale([0, 3000, 6000], 3)).toBe(0.001);
    // no centroid yet: keep the metre reading (callers defer until it is known)
    expect(inferElevationUnitScale(FEET, null)).toBe(1);
  });

  it("places the floor of a feet model in metres plus the vertical shift", () => {
    const rows = FEET.map((e, i) => ({ name: `S${i}`, elevation: e, ifcVersionId: "v", sourceIfcFileId: "f" }));
    const z = resolveStoreyFloorZ("S7", rows, { centroidY: 8.2, modelShiftY: 0.1524 })!;
    expect(z).toBeCloseTo(32.17 * 0.3048 + 0.1524, 6);
  });

  it("also defers while the model centroid is unknown (feet vs metres needs it)", () => {
    const base = { getBaseCoordinates: () => [0, 0, 0] };
    expect(shouldDeferForBaseShift({ ...base, getModelCentroid: () => null }, true, 0)).toBe(true);
    expect(shouldDeferForBaseShift({ ...base, getModelCentroid: () => ({ x: 0, y: 8, z: 0 }) }, true, 0)).toBe(false);
    expect(shouldDeferForBaseShift(base, true, 0)).toBe(false); // handle without a centroid accessor
  });
});

describe("overlapTopDownPose (entering overlap from a first-person split view)", () => {
  const params = { scale: 0.0339, rotation: 0.3, translateX: -24, translateZ: -1.6 };
  const eye = firstPersonPose({ x: 3, z: 4 }, 0, 0, 0, null); // what the split nav view leaves behind

  it("looks straight down at the page centre, above the storey floor, perspective", () => {
    const pose = overlapTopDownPose(params, 1000, 800, 2.5, eye);
    const centre = applyCalibration(params, { x: 500, y: 400 });
    expect(pose.target[0]).toBeCloseTo(centre.x, 9);
    expect(pose.target[2]).toBeCloseTo(centre.z, 9);
    expect(pose.target[1]).toBeCloseTo(2.5, 9);
    expect(pose.pos[1]).toBeGreaterThan(2.5 + 5); // well above the plan, not at eye height
    expect(Math.hypot(pose.pos[0] - centre.x, pose.pos[2] - centre.z)).toBeLessThan(0.01 * (pose.pos[1] - 2.5));
    expect(pose.isOrtho).toBe(false);
    // the grazing split pose is nowhere near this: its pitch is horizontal
    expect(pitchFromPose(eye)).toBeCloseTo(0, 9);
    expect(pitchFromPose(pose)).toBeLessThan(-1.5); // ~ -90 degrees
  });

  it("frames the whole page: the camera is higher for a bigger page", () => {
    const small = overlapTopDownPose(params, 500, 400, 0, eye);
    const big = overlapTopDownPose(params, 2000, 1600, 0, eye);
    expect(big.pos[1]).toBeGreaterThan(small.pos[1] * 3);
  });

  it("inherits the perspective fov and survives an orthographic current pose", () => {
    expect(overlapTopDownPose(params, 1000, 800, 0, { ...eye, fov: 60 }).fov).toBe(60);
    expect(overlapTopDownPose(params, 1000, 800, 0, { ...eye, isOrtho: true, fov: 5 }).fov).toBe(DEFAULT_CAMERA_FOV);
    expect(overlapTopDownPose(params, 1000, 800, 0, null).fov).toBe(DEFAULT_CAMERA_FOV);
  });
});
