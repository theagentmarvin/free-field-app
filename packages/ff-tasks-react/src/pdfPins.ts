import type { CalibrationTransformParams, OutboxRecord } from "@ff/types";
import type { TaskLocation } from "@ff/firestore";
import { pinBuildingScope } from "./callouts";

import {
  applyCalibration,
  invertCalibration,
  type WorldPoint,
} from "@ff/data/calibration/similarity";

/**
 * 2D plan pins + the calibration bridge (plan §6). Pure module, same
 * discipline as `callouts.ts`: ff-tasks-react talks to the PDF viewer
 * only through the structural `PdfPinSurface` below, so
 * `@ff/viewer-react` is never imported here.
 *
 * The stored pin is `{ pdfFileId, page, uv, calibId }` (schema §2.2):
 * `uv` is normalized over the PDF page (in points) so it survives
 * rescales, and `calibId` names the calibration the pin trusts —
 * never silently re-projected. The transform math itself is the
 * wizard's own (`ff-data/calibration/similarity`), so 2D and 3D are
 * one matrix apart, exactly as the plan promises.
 */

/** Page size in PDF points (from `PdfVersionRecord.width/height`). */
export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfPin {
  taskId: string;
  num: number;
  title: string;
  status: number;
  /** queued (not-yet-committed) pin — renders half-alpha (§4/D5) */
  pending: boolean;
  pdfFileId: string;
  /** 1-based page */
  page: number;
  /** normalized 0..1, origin top-left, y-down (PDF.js convention) */
  uv: [number, number];
  calibId: string;
  /** building scope; absent = legacy/cross-building (shown everywhere) */
  buildingId?: string;
}

/** The slice of a task doc the 2D layer cares about (structural). */
export interface LocatablePdfTask {
  id: string;
  num: number;
  title: string;
  status: number;
  updatedAt: number;
  buildingId?: string | null;
  location?: {
    pdf?: {
      pdfFileId?: string;
      page?: number;
      uv?: [number, number] | null;
      calibId?: string;
    } | null;
  } | null;
}

/** Minimal viewer surface the 2D layer uses (PdfOverlayHandle satisfies it). */
export interface PdfPinSurface {
  /** portal node inside `.pv-zoom-transform` — children inherit the zoom */
  getAnnotationLayer(): HTMLElement | null;
  getTotalScale(): number;
  getCurrentPage(): number;
  goToPage(n: number): void;
  onReady(cb: () => void): void;
  setOnScaleChange(cb: (e: { renderScale: number }) => void): () => void;
  /** Day-3 location snapshot (PdfOverlayHandle.getPageSnapshot). */
  getPageSnapshot?(
    page: number,
    uv: [number, number],
    maxWidthPx?: number,
  ): string | null;
}

/** Calibration slice the bridge needs (CalibrationRecord satisfies it). */
export interface CalibrationLike {
  id: string;
  storeyName: string;
  transformParams: CalibrationTransformParams;
  updatedAt: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function validUv(uv: unknown): uv is [number, number] {
  return (
    Array.isArray(uv) &&
    uv.length === 2 &&
    typeof uv[0] === "number" &&
    typeof uv[1] === "number" &&
    Number.isFinite(uv[0]) &&
    Number.isFinite(uv[1])
  );
}

function validPinParts(pdf: {
  pdfFileId?: string;
  page?: number;
  uv?: [number, number] | null;
  calibId?: string;
} | null | undefined): pdf is {
  pdfFileId: string;
  page: number;
  uv: [number, number];
  calibId: string;
} {
  return (
    !!pdf &&
    typeof pdf.pdfFileId === "string" &&
    pdf.pdfFileId.length > 0 &&
    typeof pdf.page === "number" &&
    Number.isInteger(pdf.page) &&
    pdf.page >= 1 &&
    validUv(pdf.uv) &&
    typeof pdf.calibId === "string" &&
    pdf.calibId.length > 0
  );
}

/** Cloud docs with a 2D anchor become pins. */
export function extractPdfPins(tasks: readonly LocatablePdfTask[]): PdfPin[] {
  const pins: PdfPin[] = [];
  for (const task of tasks) {
    const pdf = task.location?.pdf;
    if (!validPinParts(pdf)) continue;
    pins.push({
      taskId: task.id,
      num: task.num,
      title: task.title,
      status: task.status,
      pending: false,
      pdfFileId: pdf.pdfFileId,
      page: pdf.page,
      uv: pdf.uv,
      calibId: pdf.calibId,
      ...pinBuildingScope(task.buildingId),
    });
  }
  return pins;
}

/**
 * Queued creates carrying a 2D location pin early — D5 again: only
 * `added`/`failed` overlay; `sending` is already optimistic in
 * Firestore's local cache.
 */
export function pendingPdfPins(rows: readonly OutboxRecord[], overlaySending = false): PdfPin[] {
  const pins: PdfPin[] = [];
  for (const row of rows) {
    const isPending =
      row.state === "added" || row.state === "failed" || (overlaySending && row.state === "sending");
    if (!isPending) continue;
    const payload = row.payload as unknown as {
      verb?: string;
      taskId?: string;
      title?: string;
      statusTo?: number;
      createDoc?: { num?: number; buildingId?: string | null; location?: LocatablePdfTask["location"] };
    };
    if (payload.verb !== "create" || !payload.taskId) continue;
    const pdf = payload.createDoc?.location?.pdf;
    if (!validPinParts(pdf)) continue;
    pins.push({
      taskId: payload.taskId,
      num: payload.createDoc?.num ?? 0,
      title: payload.title ?? "(untitled)",
      status: payload.statusTo ?? 10,
      pending: true,
      pdfFileId: pdf.pdfFileId,
      page: pdf.page,
      uv: pdf.uv,
      calibId: pdf.calibId,
      ...pinBuildingScope(payload.createDoc?.buildingId),
    });
  }
  return pins;
}

/** Cloud pins hidden while a pending pin for the same task exists. */
export function mergePdfPins(cloud: PdfPin[], pending: PdfPin[]): PdfPin[] {
  const queued = new Set(pending.map((p) => p.taskId));
  return [...cloud.filter((p) => !queued.has(p.taskId)), ...pending];
}

/** Pins shown on one page only. */
export function pinsForPage(pins: readonly PdfPin[], page: number): PdfPin[] {
  return pins.filter((p) => p.page === page);
}

/** Pins for one PDF file (a documents session shows one file at a time). */
export function pinsForFile(pins: readonly PdfPin[], pdfFileId: string): PdfPin[] {
  return pins.filter((p) => p.pdfFileId === pdfFileId);
}

// ─── conversions ────────────────────────────────────────────────────

export function uvToPagePoint(
  uv: readonly [number, number],
  size: PdfPageSize
): { x: number; y: number } {
  return { x: uv[0] * size.width, y: uv[1] * size.height };
}

export function pagePointToUv(
  pt: { x: number; y: number },
  size: PdfPageSize
): [number, number] {
  if (size.width <= 0 || size.height <= 0) return [0, 0];
  return [clamp01(pt.x / size.width), clamp01(pt.y / size.height)];
}

/**
 * Canvas-local CSS px inside the annotation layer: page coords (pdf
 * points) × renderScale — the exact convention the calibration wizard
 * proved (Task 15b): the portal inherits the display zoom, so pin
 * positions are set once per scale change — no rAF loop, no rect math.
 */
export function pinCanvasPx(
  pin: { uv: readonly [number, number] },
  size: PdfPageSize,
  renderScale: number
): { x: number; y: number } {
  const pt = uvToPagePoint(pin.uv, size);
  return { x: pt.x * renderScale, y: pt.y * renderScale };
}

// ─── the calibration bridge (the differentiator, §6) ────────────────

/** 2D pin → world floor-plan point (X-Z), through the pin's calibration. */
export function uvToWorld(
  uv: readonly [number, number],
  size: PdfPageSize,
  calib: CalibrationLike
): WorldPoint {
  return applyCalibration(calib.transformParams, uvToPagePoint(uv, size));
}

/** World floor-plan point → normalized uv (reverse bridge). */
export function worldToUv(
  world: WorldPoint,
  size: PdfPageSize,
  calib: CalibrationLike
): [number, number] {
  const pt = invertCalibration(calib.transformParams, world);
  return pagePointToUv(pt, size);
}

/**
 * Drift rule (§6): the pin renders from stored uv regardless, but if
 * the active calibration is a different record the 3D jump must warn
 * and recompute — never silently re-project.
 */
export function isStaleCalib(
  pin: PdfPin,
  activeCalib: CalibrationLike | null
): boolean {
  if (!activeCalib) return false;
  return pin.calibId !== activeCalib.id;
}

/** The calibration a pin trusts: its own record when still present, else null. */
export function pinCalibration(
  pin: PdfPin,
  calibrations: readonly CalibrationLike[]
): CalibrationLike | null {
  return calibrations.find((c) => c.id === pin.calibId) ?? null;
}

/** Most recently updated calibration, or null (pin capture gated on this). */
export function latestCalibration<T extends CalibrationLike>(
  records: readonly T[]
): T | null {
  if (records.length === 0) return null;
  let best = records[0];
  for (const r of records) if (r.updatedAt > best.updatedAt) best = r;
  return best;
}

/** TaskLocation for a freshly captured plan point (schema §2.2 pdf variant). */
export function pdfPinLocation(
  pdfFileId: string,
  page: number,
  uv: [number, number],
  calib: CalibrationLike
): TaskLocation {
  return {
    storeyName: calib.storeyName,
    bim: null,
    pdf: { pdfFileId, page, uv, calibId: calib.id },
  };
}

/**
 * The pin-capture entry point (plan §6): the Documents panel forwards
 * `PdfOverlay`'s click coords (page points, from `pageCoordsFromEvent`)
 * plus the current page and the latest Dexie calibration for
 * `[projectId + pdfFileId]`. Returns `null` when there is no
 * calibration — the schema requires a `calibId`, so the pin MUST name
 * the transform it trusts — and the UI surfaces the
 * "calibrate this plan first" hint instead.
 */
export function locationFromPdfClick(
  click: { x: number; y: number },
  pageSize: PdfPageSize,
  pdfFileId: string,
  page: number,
  calib: CalibrationLike | null
): TaskLocation | null {
  if (!calib) return null;
  return pdfPinLocation(pdfFileId, page, pagePointToUv(click, pageSize), calib);
}
