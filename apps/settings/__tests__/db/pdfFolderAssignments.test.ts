// __tests__/db/pdfFolderAssignments.test.ts
//
// CRUD + cascade coverage for the v8 `pdfFolderAssignments` join
// table.
//
// Coverage:
//   - create / get / getForPdf / listForFolders
//   - one-folder-per-PDF: creating a second assignment for the
//     same pdfFileId throws (unique single-field index)
//   - setAssignmentForPdf: create, replace, un-file (null)
//   - cascade on PDF delete: deletePdfFile also drops the
//     assignment (covered indirectly via deletePdfFile)
//   - deleteAssignmentsForPdf helper
//
// See docs/task-20f-pdf-folders.md §"Data layer" for the schema
// rationale.

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearAssignmentForPdf,
  createPdfFolderAssignment,
  deleteAssignmentsForPdf,
  getAssignmentForPdf,
  getPdfFolderAssignment,
  listAssignmentsForFolders,
  setAssignmentForPdf,
} from "@ff/data/db/tables/pdfFolderAssignments";
import { createPdfFile, deletePdfFile } from "@ff/data/db/tables/pdfFiles";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFolder } from "@ff/data/db/tables/pdfFolders";

import { resetDb } from "./helpers";

async function makeBuilding(projectId: string, name = "B") {
  return createBuilding({ projectId, name, metadata: {} });
}

describe("pdfFolderAssignments table", () => {
  beforeEach(async () => {
    await resetDb("pdfFolderAssignments");
  });

  it("creates an assignment and reads it back by id", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    const a = await createPdfFolderAssignment({
      pdfFileId: f.id,
      folderId: folder.id,
    });
    expect(a.pdfFileId).toBe(f.id);
    expect(a.folderId).toBe(folder.id);
    const back = await getPdfFolderAssignment(a.id);
    expect(back).toBeDefined();
  });

  it("getAssignmentForPdf returns the single row for a PDF", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });
    const got = await getAssignmentForPdf(f.id);
    expect(got).toBeDefined();
    expect(got!.folderId).toBe(folder.id);
  });

  it("rejects a second assignment for the same pdfFileId", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folderA = await createPdfFolder({ projectId: p.id, name: "A" });
    const folderB = await createPdfFolder({ projectId: p.id, name: "B" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folderA.id });
    await expect(
      createPdfFolderAssignment({ pdfFileId: f.id, folderId: folderB.id }),
    ).rejects.toThrow();
  });

  it("listAssignmentsForFolders returns rows across multiple folder ids", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f1 = await createPdfFile({ buildingId: b.id, name: "1.pdf" });
    const f2 = await createPdfFile({ buildingId: b.id, name: "2.pdf" });
    const fa = await createPdfFolder({ projectId: p.id, name: "A" });
    const fb = await createPdfFolder({ projectId: p.id, name: "B" });
    await createPdfFolderAssignment({ pdfFileId: f1.id, folderId: fa.id });
    await createPdfFolderAssignment({ pdfFileId: f2.id, folderId: fb.id });

    const rows = await listAssignmentsForFolders([fa.id, fb.id]);
    expect(rows.length).toBe(2);
  });

  it("listAssignmentsForFolders returns [] when given an empty list", async () => {
    expect(await listAssignmentsForFolders([])).toEqual([]);
  });

  it("setAssignmentForPdf creates, replaces, and un-files", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const fa = await createPdfFolder({ projectId: p.id, name: "A" });
    const fb = await createPdfFolder({ projectId: p.id, name: "B" });

    // Create.
    const created = await setAssignmentForPdf(f.id, fa.id);
    expect(created).not.toBeNull();
    expect(created!.folderId).toBe(fa.id);
    expect((await getAssignmentForPdf(f.id))!.id).toBe(created!.id);

    // Replace.
    const replaced = await setAssignmentForPdf(f.id, fb.id);
    expect(replaced).not.toBeNull();
    expect(replaced!.folderId).toBe(fb.id);
    expect((await getAssignmentForPdf(f.id))!.id).toBe(replaced!.id);

    // Un-file.
    const unfiled = await setAssignmentForPdf(f.id, null);
    expect(unfiled).toBeNull();
    expect(await getAssignmentForPdf(f.id)).toBeUndefined();
  });

  it("clearAssignmentForPdf removes the row (no-op when missing)", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });
    await clearAssignmentForPdf(f.id);
    expect(await getAssignmentForPdf(f.id)).toBeUndefined();
    // Second call is a no-op.
    await clearAssignmentForPdf(f.id);
  });

  it("deletePdfFile also drops the assignment", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });

    await deletePdfFile(f.id);

    expect(await getAssignmentForPdf(f.id)).toBeUndefined();
    // Folder itself is NOT deleted (cascade goes one direction).
    expect(await import("@ff/data/db/database").then(({ db }) =>
      db.pdfFolders.get(folder.id),
    )).toBeDefined();
  });

  it("deleteAssignmentsForPdf removes the row by pdfFileId", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await makeBuilding(p.id);
    const f = await createPdfFile({ buildingId: b.id, name: "plan.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });
    await deleteAssignmentsForPdf(f.id);
    expect(await getAssignmentForPdf(f.id)).toBeUndefined();
  });
});