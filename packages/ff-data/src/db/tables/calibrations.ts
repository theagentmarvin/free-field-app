// src/core/db/tables/calibrations.ts
//
// CRUD for the v4 `calibrations` table. One row per
// (pdfFileId, storeyName) pair. Mirrors the shape of the other
// CRUD modules in this directory (pdfFiles, pdfVersions, etc):
// pure functions, no React, no live-query logic. The live-query
// hook lives in `src/hooks/useCalibrations.ts`.
//
// Cascade policy:
//   - pdfFiles.deletePdfFile() — should remove all calibrations
//     for the file. The wiring lives in `pdfFiles.deletePdfFile`
//     (a follow-up may consolidate this into a single cascade
//     helper, but for now the cascade is colocated with the
//     delete).
//   - storey deletion — we do NOT cascade on storey deletion
//     because Free Field has no UI for deleting storeys
//     (storeys come from IFC files and re-extract on re-upload).
//   - building / project deletion — not yet implemented in the
//     CRUD layer; the relevant delete functions should clean
//     calibrations when they land. A follow-up.
//
// See docs/TASK-12a-CALIBRATION-WIZARD.md "Data layer" for the
// schema rationale and index choices.

import { db } from "../database";
import { uuid } from "../uuid";
import type { CalibrationRecord } from "@ff/types";

export type CreateCalibrationInput = Omit<
  CalibrationRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<CalibrationRecord, "id" | "createdAt" | "updatedAt">>;

/**
 * Insert a new CalibrationRecord. The Dexie schema's
 * `[pdfFileId+storeyName]` is NOT a unique compound (we only
 * declared it as a regular compound index for fast queries, not
 * a `&`-prefixed unique one), so a duplicate (pdfFileId,
 * storeyName) pair will succeed at the DB level. The wizard's
 * save flow calls `getCalibrationForPdfAndStorey` first and
 * `updateCalibration` if one exists — we chose "upsert by
 * wizard logic" over "DB-enforced unique" so the user can have
 * multiple rows per (pdf, storey) for future "history" features.
 */
export async function createCalibration(
  input: CreateCalibrationInput,
): Promise<CalibrationRecord> {
  const now = Date.now();
  const record: CalibrationRecord = {
    id: input.id ?? uuid(),
    projectId: input.projectId,
    pdfFileId: input.pdfFileId,
    storeyName: input.storeyName,
    pointPairs: input.pointPairs,
    transformParams: input.transformParams,
    confidence: input.confidence,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.calibrations.add(record);
  return record;
}

export async function getCalibration(
  id: string,
): Promise<CalibrationRecord | undefined> {
  return db.calibrations.get(id);
}

/**
 * Lookup helper used by the wizard's save flow to detect
 * "calibration for this (pdf, storey) already exists".
 * The compound index makes this a cheap single-row query.
 */
export async function getCalibrationForPdfAndStorey(
  pdfFileId: string,
  storeyName: string,
): Promise<CalibrationRecord | undefined> {
  return db.calibrations
    .where("[pdfFileId+storeyName]")
    .equals([pdfFileId, storeyName])
    .first();
}

export type UpdateCalibrationPatch = Partial<
  Omit<CalibrationRecord, "id" | "projectId" | "createdAt">
>;

/**
 * Patch an existing calibration. The `updatedAt` timestamp is
 * bumped automatically — callers should not pass one (the type
 * allows it for tests that need to pin the timestamp).
 */
export async function updateCalibration(
  id: string,
  patch: UpdateCalibrationPatch,
): Promise<void> {
  await db.calibrations.update(id, { ...patch, updatedAt: Date.now() });
}

export async function listCalibrationsForProject(
  projectId: string,
): Promise<CalibrationRecord[]> {
  return db.calibrations
    .where("projectId")
    .equals(projectId)
    .toArray();
}

export async function listCalibrationsForStorey(
  projectId: string,
  storeyName: string,
): Promise<CalibrationRecord[]> {
  return db.calibrations
    .where("[projectId+storeyName]")
    .equals([projectId, storeyName])
    .toArray();
}

export async function listCalibrationsForPdf(
  projectId: string,
  pdfFileId: string,
): Promise<CalibrationRecord[]> {
  return db.calibrations
    .where("[projectId+pdfFileId]")
    .equals([projectId, pdfFileId])
    .toArray();
}

export async function deleteCalibration(id: string): Promise<void> {
  await db.calibrations.delete(id);
}

/**
 * Cascade-delete all calibrations for a PDF file. Called from
 * `pdfFiles.deletePdfFile` so the file's calibration history
 * doesn't outlive the file. No-op if the file id is unknown
 * (defensive — Dexie's `where(...).delete()` would also
 * be a no-op in that case, but we short-circuit to avoid the
 * query overhead).
 */
export async function deleteCalibrationsForPdf(
  pdfFileId: string,
): Promise<void> {
  // The primary "pdfFileId" secondary index makes this a cheap
  // bulk delete. We don't need a transaction because Dexie's
  // delete() is atomic per-row and the cascade is "delete all
  // rows with this pdfFileId" — no read-then-write.
  await db.calibrations.where("pdfFileId").equals(pdfFileId).delete();
}
