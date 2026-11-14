// __tests__/db/pdfFolders.test.ts
//
// CRUD round-trips for the v8 `pdfFolders` table.
//
// Coverage:
//   - create / get / list / findByName / update / delete
//   - default color (when not provided)
//   - nested folder creation (parentId chain)
//   - cascade: deleting a folder also drops every descendant
//     folder and every assignment pointing at any of them
//   - rename does NOT touch assignments
//
// See docs/task-20f-pdf-folders.md §"Data layer" for the schema
// rationale.

import { beforeEach, describe, expect, it } from "vitest";

import {
  createPdfFolder,
  deletePdfFolder,
  findPdfFolderByName,
  getPdfFolder,
  listPdfFolders,
  PDF_FOLDER_COLORS,
  updatePdfFolder,
} from "@ff/data/db/tables/pdfFolders";
import { createPdfFolderAssignment } from "@ff/data/db/tables/pdfFolderAssignments";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

import { resetDb } from "./helpers";

async function makeProject(name = "P") {
  return createProject({ name, metadata: {} });
}

async function makeBuilding(projectId: string, name = "B") {
  return createBuilding({ projectId, name, metadata: {} });
}

async function makePdfFile(buildingId: string, name = "plan.pdf") {
  return createPdfFile({ buildingId, name });
}

describe("pdfFolders table", () => {
  beforeEach(async () => {
    await resetDb("pdfFolders");
  });

  it("creates a folder with a default color when not specified", async () => {
    const p = await makeProject();
    const folder = await createPdfFolder({ projectId: p.id, name: "Architecture" });
    expect(folder.color).toBe("blue");
    expect(folder.parentId).toBeNull();
    expect(folder.projectId).toBe(p.id);
  });

  it("creates a folder with an explicit color from the palette", async () => {
    const p = await makeProject();
    const folder = await createPdfFolder({
      projectId: p.id,
      name: "Finishes",
      color: "amber",
    });
    expect(folder.color).toBe("amber");
  });

  it("findPdfFolderByName surfaces a duplicate so the caller can refuse", async () => {
    // The schema does not enforce compound uniqueness (null
    // parentId is awkward in IndexedDB compound keys — see
    // database.ts v8 notes), so duplicate creates succeed at
    // the DB layer. The caller is expected to check via
    // `findPdfFolderByName` and bail with a friendly error.
    const p = await makeProject();
    await createPdfFolder({ projectId: p.id, name: "Architecture" });
    const dup = await findPdfFolderByName(p.id, "Architecture", null);
    expect(dup).toBeDefined();
    expect(dup!.name).toBe("Architecture");
  });

  it("allows the same folder name in different parents", async () => {
    const p = await makeProject();
    const root = await createPdfFolder({ projectId: p.id, name: "Plans" });
    const nested = await createPdfFolder({
      projectId: p.id,
      name: "Plans",
      parentId: root.id,
    });
    expect(nested.parentId).toBe(root.id);
    expect(nested.name).toBe("Plans");
  });

  it("lists folders for a project, ordered by name ascending", async () => {
    const p = await makeProject();
    await createPdfFolder({ projectId: p.id, name: "Finishes" });
    await createPdfFolder({ projectId: p.id, name: "Architecture" });
    await createPdfFolder({ projectId: p.id, name: "Furniture" });
    const list = await listPdfFolders(p.id);
    expect(list.map((f) => f.name)).toEqual([
      "Architecture",
      "Finishes",
      "Furniture",
    ]);
  });

  it("findPdfFolderByName returns the matching row (root)", async () => {
    const p = await makeProject();
    await createPdfFolder({ projectId: p.id, name: "Architecture" });
    const found = await findPdfFolderByName(p.id, "Architecture", null);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Architecture");
  });

  it("findPdfFolderByName returns undefined when missing", async () => {
    const p = await makeProject();
    expect(await findPdfFolderByName(p.id, "Nope", null)).toBeUndefined();
  });

  it("updatePdfFolder stamps updatedAt and preserves projectId", async () => {
    const p = await makeProject();
    const folder = await createPdfFolder({ projectId: p.id, name: "Architecture" });
    const originalUpdatedAt = folder.updatedAt;
    // Add a small delay to ensure the timestamp actually changes.
    await new Promise((r) => setTimeout(r, 5));
    await updatePdfFolder(folder.id, { name: "Arch", color: "green" });
    const updated = await getPdfFolder(folder.id);
    expect(updated!.name).toBe("Arch");
    expect(updated!.color).toBe("green");
    expect(updated!.projectId).toBe(p.id);
    expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  it("deletePdfFolder drops assignments pointing at the folder", async () => {
    const p = await makeProject();
    const b = await makeBuilding(p.id);
    const f = await makePdfFile(b.id);
    const folder = await createPdfFolder({ projectId: p.id, name: "Arch" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });

    await deletePdfFolder(folder.id);

    // The folder is gone.
    expect(await getPdfFolder(folder.id)).toBeUndefined();
    // The assignment is gone.
    const { db } = await import("@ff/data/db/database");
    const remaining = await db.pdfFolderAssignments
      .where("pdfFileId")
      .equals(f.id)
      .toArray();
    expect(remaining.length).toBe(0);
  });

  it("deletePdfFolder cascades to descendants and their assignments", async () => {
    const p = await makeProject();
    const b = await makeBuilding(p.id);
    const root = await createPdfFolder({ projectId: p.id, name: "Root" });
    const child = await createPdfFolder({
      projectId: p.id,
      name: "Child",
      parentId: root.id,
    });
    const grandchild = await createPdfFolder({
      projectId: p.id,
      name: "Grandchild",
      parentId: child.id,
    });
    const pdfRoot = await makePdfFile(b.id, "r.pdf");
    const pdfChild = await makePdfFile(b.id, "c.pdf");
    const pdfGrand = await makePdfFile(b.id, "g.pdf");
    await createPdfFolderAssignment({ pdfFileId: pdfRoot.id, folderId: root.id });
    await createPdfFolderAssignment({ pdfFileId: pdfChild.id, folderId: child.id });
    await createPdfFolderAssignment({ pdfFileId: pdfGrand.id, folderId: grandchild.id });

    await deletePdfFolder(root.id);

    expect(await getPdfFolder(root.id)).toBeUndefined();
    expect(await getPdfFolder(child.id)).toBeUndefined();
    expect(await getPdfFolder(grandchild.id)).toBeUndefined();

    const { db } = await import("@ff/data/db/database");
    const remaining = await db.pdfFolderAssignments.toArray();
    expect(remaining.length).toBe(0);
  });

  it("rename does NOT touch the assignments table", async () => {
    const p = await makeProject();
    const b = await makeBuilding(p.id);
    const f = await makePdfFile(b.id);
    const folder = await createPdfFolder({ projectId: p.id, name: "Old" });
    const assignment = await createPdfFolderAssignment({
      pdfFileId: f.id,
      folderId: folder.id,
    });
    await updatePdfFolder(folder.id, { name: "New" });
    const { db } = await import("@ff/data/db/database");
    const persisted = await db.pdfFolderAssignments.get(assignment.id);
    expect(persisted).toBeDefined();
    expect(persisted!.folderId).toBe(folder.id);
    expect(persisted!.pdfFileId).toBe(f.id);
  });

  it("exposes the PDF_FOLDER_COLORS palette for callers", () => {
    // The palette is the contract for the color picker. A change
    // here is a UI-visible breaking change.
    expect(PDF_FOLDER_COLORS).toEqual([
      "blue",
      "green",
      "amber",
      "rose",
      "violet",
      "slate",
    ]);
  });
});