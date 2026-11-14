// __tests__/components/PdfFoldersSidebar.test.tsx
//
// UI smoke tests for <PdfFoldersSidebar>. Covers the user-facing
// interactions from the maintainer's directive (2026-06-22):
//   - top-level folder creation via the "+ New folder" button
//   - folder rename via kebab → Rename
//   - folder delete via kebab → Delete (with ConfirmDialog)
//   - subfolder creation via kebab → New subfolder
//   - assignment: an Unfiled PDF row's "Move" button opens the
//     folder picker; picking a folder creates the assignment
//
// The tree, per-folder PDF lists, and the live-query plumbing
// are exercised end-to-end because the component pulls its data
// from Dexie via the live hooks.

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import PdfFoldersSidebar from "@components/PdfFoldersSidebar";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { createPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { putPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { createPdfFolder } from "@ff/data/db/tables/pdfFolders";

import { resetDb } from "../db/helpers";

const PROJECT_ID = "default-project";

async function makeContext() {
  // The settings module hard-codes the project id to
  // "default-project" for Phase 1 (see AppShell.DEFAULT_PROJECT_ID).
  // Make sure the project row exists so the live-query joins
  // don't yield undefined.
  const p = await createProject({ id: PROJECT_ID, name: "Default", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { project: p, building: b };
}

async function makePdfWithVersion(buildingId: string, name: string) {
  const f = await createPdfFile({ buildingId, name });
  const v = await createPdfVersion({
    pdfFileId: f.id,
    versionNumber: 1,
    name,
    size: 9,
    contentHash: "h",
    pageCount: 1,
    width: 612,
    height: 792,
    blobKey: `k-${f.id}`,
    isLatest: true,
  });
  await putPdfBlob(v.blobKey, new Blob([new Uint8Array([1, 2, 3])]));
  return { file: f, version: v };
}

describe("<PdfFoldersSidebar>", () => {
  beforeEach(async () => {
    await resetDb("PdfFoldersSidebar");
  });

  it("renders the empty state when there are no folders", async () => {
    await makeContext();
    render(<PdfFoldersSidebar buildingId={null} projectId={PROJECT_ID} />);
    const empty = await screen.findByTestId("folder-tree-empty");
    expect(empty.textContent).toMatch(/No folders yet/);
  });

  it("creates a top-level folder via the + New folder button", async () => {
    await makeContext();
    render(<PdfFoldersSidebar buildingId={null} projectId={PROJECT_ID} />);

    fireEvent.click(screen.getByTestId("new-root-folder-button"));

    const input = await screen.findByTestId("new-folder-input");
    fireEvent.change(input, { target: { value: "Architecture" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const rows = await screen.findAllByTestId("folder-tree-row");
      expect(rows.length).toBe(1);
    });
    expect(
      await screen.findByText("Architecture"),
    ).toBeTruthy();
  });

  it("renames a folder via the kebab → Rename flow", async () => {
    const { project } = await makeContext();
    await createPdfFolder({ projectId: project.id, name: "Old" });

    render(<PdfFoldersSidebar buildingId={null} projectId={PROJECT_ID} />);

    const row = await screen.findByTestId("folder-tree-row");
    const kebab = within(row).getByTestId("folder-tree-kebab");
    fireEvent.click(kebab);

    const renameBtn = await screen.findByTestId("folder-tree-menu-rename");
    fireEvent.click(renameBtn);

    const input = await screen.findByTestId("rename-input");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => screen.getByText("New"));
  });

  it("deletes a folder via the kebab → Delete flow + ConfirmDialog", async () => {
    const { project } = await makeContext();
    await createPdfFolder({ projectId: project.id, name: "Doomed" });

    render(<PdfFoldersSidebar buildingId={null} projectId={PROJECT_ID} />);

    const row = await screen.findByTestId("folder-tree-row");
    fireEvent.click(within(row).getByTestId("folder-tree-kebab"));

    fireEvent.click(await screen.findByTestId("folder-tree-menu-delete"));

    // ConfirmDialog shows a danger "Delete" button. Click it.
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByText("Delete");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(db.pdfFolders).toBeDefined();
    });
    const remaining = await db.pdfFolders.toArray();
    expect(remaining.length).toBe(0);
  });

  it("creates a subfolder via kebab → New subfolder", async () => {
    const { project } = await makeContext();
    const root = await createPdfFolder({ projectId: project.id, name: "Root" });

    render(<PdfFoldersSidebar buildingId={null} projectId={PROJECT_ID} />);

    const rows = await screen.findAllByTestId("folder-tree-row");
    expect(rows.length).toBe(1);
    fireEvent.click(within(rows[0]).getByTestId("folder-tree-kebab"));

    fireEvent.click(await screen.findByTestId("folder-tree-menu-new-subfolder"));

    const input = await screen.findByTestId("new-subfolder-input");
    fireEvent.change(input, { target: { value: "Child" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The root must be open by default, so the new child is
    // immediately visible.
    await waitFor(() => screen.getByText("Child"));

    const persisted = await db.pdfFolders.toArray();
    expect(persisted.length).toBe(2);
    const child = persisted.find((f) => f.name === "Child");
    expect(child?.parentId).toBe(root.id);
  });

  it("moves an Unfiled PDF into a folder via the Move menu", async () => {
    const { project, building } = await makeContext();
    const { file } = await makePdfWithVersion(building.id, "plan.pdf");
    const folder = await createPdfFolder({ projectId: project.id, name: "Arch" });

    render(
      <PdfFoldersSidebar
        buildingId={building.id}
        projectId={PROJECT_ID}
      />,
    );

    const unfiled = await screen.findByTestId("unfiled-pdf-row");
    expect(unfiled.getAttribute("data-pdf-file-id")).toBe(file.id);

    fireEvent.click(within(unfiled).getByTestId("unfiled-pdf-row-assign"));

    const menu = await screen.findByTestId("assign-menu");
    fireEvent.click(within(menu).getByTestId(`assign-menu-folder-${folder.id}`));

    await waitFor(async () => {
      const assignments = await db.pdfFolderAssignments.toArray();
      expect(assignments.length).toBe(1);
      expect(assignments[0].folderId).toBe(folder.id);
      expect(assignments[0].pdfFileId).toBe(file.id);
    });
  });
});
describe("<PdfFoldersSidebar> — folder row contains its PDFs", () => {
  beforeEach(async () => {
    await resetDb("PdfFoldersSidebar-NestedPdfs");
  });

  it("renders the per-folder PDF list INSIDE the open folder row (not as a sibling)", async () => {
    // Per Maintainer directive 2026-06-22 16:10 CLT — PDFs assigned to
    // a folder must show under that folder when expanded, not at
    // the body level under a separate "ARCH PDFS" header.
    const { project, building } = await makeContext();
    const folder = await createPdfFolder({
      projectId: project.id,
      name: "Architecture",
    });
    const { file } = await makePdfWithVersion(building.id, "plan.pdf");
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({
        pdfFileId: file.id,
        folderId: folder.id,
      }),
    );

    render(
      <PdfFoldersSidebar
        buildingId={building.id}
        projectId={project.id}
      />,
    );

    const folderRow = await screen.findByTestId("folder-tree-row");
    // Wait for the live-query assignments to populate (the per-folder
    // PDF list reads from `usePdfFolderAssignmentsForBuilding` which
    // hydrates async after the row mounts).
    await within(folderRow).findByTestId("folder-pdf-row");
    // The PDF list testid must be a descendant of the folder
    // row's DOM, not a sibling at the body level.
    expect(
      folderRow.querySelector('[data-testid="folder-pdf-list"]'),
    ).not.toBeNull();
    // And the empty-state copy must NOT appear (the folder has
    // a real PDF).
    expect(
      folderRow.querySelector('[data-testid="folder-pdf-list-empty"]'),
    ).toBeNull();
  });

  it("the per-folder count badge matches the visible PDF rows", async () => {
    const { project, building } = await makeContext();
    const folder = await createPdfFolder({
      projectId: project.id,
      name: "Architecture",
    });
    const { file: f1 } = await makePdfWithVersion(building.id, "a.pdf");
    const { file: f2 } = await makePdfWithVersion(building.id, "b.pdf");
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({
        pdfFileId: f1.id,
        folderId: folder.id,
      }),
    );
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({
        pdfFileId: f2.id,
        folderId: folder.id,
      }),
    );

    render(
      <PdfFoldersSidebar
        buildingId={building.id}
        projectId={project.id}
      />,
    );

    const row = await screen.findByTestId("folder-tree-row");
    expect(row.getAttribute("data-folder-id")).toBe(folder.id);
    // Wait for the live-query hydration so the count badge updates.
    // findAllByTestId waits until at least one row appears; we then
    // assert that the count matches the row count inside the folder.
    const pdfRows = await within(row).findAllByTestId("folder-pdf-row");
    expect(pdfRows.length).toBe(2);
    // Count badge inside the row reads "2 PDFs" once the
    // project-wide assignment live query has resolved. Wait for it
    // to appear (the per-folder PDF list uses the building-scoped
    // query; the count uses the project-scoped query — both need
    // to settle).
    const badge = await waitFor(() => {
      const el = row.querySelector('[title="2 PDFs"]');
      if (!el) throw new Error("badge not yet at 2 PDFs");
      return el;
    });
    expect(badge.textContent).toBe("2");
  });
});
