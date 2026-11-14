import { describe, expect, it } from "vitest";

import {
  extractPdfPins,
  isStaleCalib,
  latestCalibration,
  locationFromPdfClick,
  mergePdfPins,
  pagePointToUv,
  pendingPdfPins,
  pinCalibration,
  pinCanvasPx,
  pinsForFile,
  pinsForPage,
  uvToPagePoint,
  uvToWorld,
  worldToUv,
  type CalibrationLike,
  type LocatablePdfTask,
  type PdfPageSize,
  type PdfPin,
} from "../src/pdfPins";

/**
 * Chunk 4 — pdfPins pure math (plan §6). Pin encoding survives
 * rescales, the calibration bridge round-trips exactly, and the
 * drift rule never silently re-projects.
 */

const SIZE: PdfPageSize = { width: 800, height: 600 };

function calib(over: Partial<CalibrationLike> = {}): CalibrationLike {
  return {
    id: "c1",
    storeyName: "L1",
    transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
    updatedAt: 5,
    ...over,
  };
}

function cloudPdfTask(over: Partial<LocatablePdfTask> & { pdf?: Record<string, unknown> | null } = {}): LocatablePdfTask {
  const { pdf, ...taskOver } = over;
  return {
    id: "t1",
    num: 12,
    title: "Set door frame",
    status: 20,
    updatedAt: 1,
    location: { pdf: pdf ?? { pdfFileId: "f1", page: 3, uv: [0.5, 0.25], calibId: "c1" } },
    ...taskOver,
  };
}

function outboxCreateRow(pdf: Record<string, unknown> | null, state = "added"): Record<string, unknown> {
  return {
    id: "g1",
    kind: "task-action",
    state,
    projectId: "p1",
    clientGuid: "g1",
    createdAt: 5,
    attempts: 0,
    photoRefs: [],
    payload: {
      verb: "create",
      taskId: "t9",
      title: "Honeycomb edge",
      statusTo: 10,
      clientGuid: "g1",
      createDoc: { num: 0, location: { pdf } },
    },
  };
}

describe("uv <-> page-point conversions", () => {
  it("normalizes page coords over the page size", () => {
    expect(pagePointToUv({ x: 100, y: 200 }, SIZE)).toEqual([0.125, 200 / 600]);
  });

  it("round-trips through uvToPagePoint", () => {
    const uv = pagePointToUv({ x: 333, y: 444 }, SIZE);
    const pt = uvToPagePoint(uv, SIZE);
    expect(pt.x).toBeCloseTo(333, 9);
    expect(pt.y).toBeCloseTo(444, 9);
  });

  it("clamps out-of-canvas clicks into [0,1]", () => {
    expect(pagePointToUv({ x: -5, y: 1200 }, SIZE)).toEqual([0, 1]);
  });

  it("falls back to [0,0] for a degenerate page size", () => {
    expect(pagePointToUv({ x: 10, y: 10 }, { width: 0, height: 600 })).toEqual([0, 0]);
  });
});

describe("pinCanvasPx (markers at uv × pageSize × renderScale)", () => {
  it("scales page-normalized coords by the point size and render scale", () => {
    expect(pinCanvasPx({ uv: [0.5, 0.25] }, SIZE, 2)).toEqual({ x: 800, y: 300 });
  });

  it("is identity at scale 1", () => {
    expect(pinCanvasPx({ uv: [0.25, 0.5] }, SIZE, 1)).toEqual({ x: 200, y: 300 });
  });
});

describe("extract / pending / merge (D5 suppression)", () => {
  it("extracts valid cloud pdf pins and skips malformed ones", () => {
    const good = cloudPdfTask();
    const noCalib = cloudPdfTask({ pdf: { pdfFileId: "f1", page: 1, uv: [0.1, 0.1] } });
    const nullUv = cloudPdfTask({ pdf: { pdfFileId: "f1", page: 1, uv: null, calibId: "c1" } });
    const badPage = cloudPdfTask({ pdf: { pdfFileId: "f1", page: 0, uv: [0.1, 0.1], calibId: "c1" } });
    const noPdf = { ...cloudPdfTask(), location: { pdf: null } };
    const pins = extractPdfPins([good, noCalib, nullUv, badPage, noPdf]);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      taskId: "t1",
      pdfFileId: "f1",
      page: 3,
      uv: [0.5, 0.25],
      calibId: "c1",
      pending: false,
    });
  });

  it("projects queued creates (added/failed only) as pending pins", () => {
    const pdf = { pdfFileId: "f1", page: 2, uv: [0.3, 0.4], calibId: "c7" };
    const pins = pendingPdfPins([
      outboxCreateRow(pdf, "added"),
      outboxCreateRow(pdf, "failed"),
      outboxCreateRow(pdf, "sending") as never,
      outboxCreateRow(null) as never,
    ] as never);
    // sending is already optimistic in Firestore's cache (§4/D5) — skipped
    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({ taskId: "t9", pending: true, status: 10, calibId: "c7" });
  });

  it("hides a cloud pin while its pending twin is queued", () => {
    const cloud: PdfPin = {
      taskId: "t9", num: 0, title: "old", status: 20, pending: false,
      pdfFileId: "f1", page: 2, uv: [0.3, 0.4], calibId: "c7",
    };
    const pending: PdfPin = { ...cloud, title: "new", pending: true };
    expect(mergePdfPins([cloud], [pending])).toEqual([pending]);
  });

  it("filters by file and page (one page on screen at a time)", () => {
    const pins: PdfPin[] = [
      { taskId: "a", num: 1, title: "a", status: 20, pending: false, pdfFileId: "f1", page: 3, uv: [0, 0], calibId: "c" },
      { taskId: "b", num: 2, title: "b", status: 20, pending: false, pdfFileId: "f1", page: 4, uv: [0, 0], calibId: "c" },
      { taskId: "c2", num: 3, title: "c", status: 20, pending: false, pdfFileId: "f2", page: 3, uv: [0, 0], calibId: "c" },
    ];
    const inFile = pinsForFile(pins, "f1");
    expect(inFile.map((p) => p.taskId)).toEqual(["a", "b"]);
    expect(pinsForPage(inFile, 3).map((p) => p.taskId)).toEqual(["a"]);
  });
});

describe("calibration selection + drift (§6)", () => {
  it("latestCalibration picks the freshest record, null on empty", () => {
    expect(latestCalibration([])).toBeNull();
    const a = calib({ id: "a", updatedAt: 5 });
    const b = calib({ id: "b", updatedAt: 9 });
    expect(latestCalibration([a, b])?.id).toBe("b");
    expect(latestCalibration([b, a])?.id).toBe("b");
  });

  it("isStaleCalib: no active calibration is not drift; a different id is", () => {
    const pin = extractPdfPins([cloudPdfTask()])[0];
    expect(isStaleCalib(pin, null)).toBe(false);
    expect(isStaleCalib(pin, calib({ id: "c1" }))).toBe(false);
    expect(isStaleCalib(pin, calib({ id: "c2" }))).toBe(true);
  });

  it("pinCalibration resolves the calib the pin actually trusts", () => {
    const pin = extractPdfPins([cloudPdfTask()])[0];
    expect(pinCalibration(pin, [calib({ id: "c9" })])).toBeNull();
    expect(pinCalibration(pin, [calib({ id: "c9" }), calib({ id: "c1" })])?.id).toBe("c1");
  });
});

describe("locationFromPdfClick (pin capture entry point)", () => {
  it("refuses to build a location without a calibration (UI hint contract)", () => {
    expect(locationFromPdfClick({ x: 100, y: 200 }, SIZE, "f1", 3, null)).toBeNull();
  });

  it("stores normalized uv + the calibId it used + the calib's storey", () => {
    const loc = locationFromPdfClick({ x: 100, y: 200 }, SIZE, "f1", 3, calib({ id: "c2", storeyName: "L2" }));
    expect(loc).toEqual({
      storeyName: "L2",
      bim: null,
      pdf: { pdfFileId: "f1", page: 3, uv: [0.125, 200 / 600], calibId: "c2" },
    });
  });
});

describe("calibration bridge (2D and 3D are one matrix apart)", () => {
  it("uvToWorld applies the forward transform through page points", () => {
    const c = calib({ transformParams: { scale: 2, rotation: 0, translateX: 10, translateZ: 20 } });
    expect(uvToWorld([0.5, 0.25], SIZE, c)).toEqual({ x: 810, z: 320 });
  });

  it("worldToUv round-trips uv through a non-trivial transform", () => {
    const c = calib({
      transformParams: { scale: 3.3, rotation: 0.7, translateX: -12, translateZ: 7 },
    });
    const uv: [number, number] = [0.42, 0.77];
    const back = worldToUv(uvToWorld(uv, SIZE, c), SIZE, c);
    expect(back[0]).toBeCloseTo(uv[0], 9);
    expect(back[1]).toBeCloseTo(uv[1], 9);
  });
});
