// __tests__/hooks/usePdfFolders.test.tsx
//
// Live-query contracts for the folder hooks:
//
//   - usePdfFolders(projectId)
//       → flat list, ordered by name ascending
//       → live updates on insert/delete/rename
//   - usePdfFolderTree(projectId)
//       → nested tree derived from the flat list
//       → depth is set correctly per level
//       → orphan rows (parentId pointing at nothing) surface as roots
//   - usePdfFolderAssignment(pdfFileId)
//       → single row for a PDF; undefined when unfiled
//   - usePdfFolderAssignmentsForBuilding(buildingId)
//       → assignments for PDFs in a single building
//   - usePdfFolderAssignmentsForProject(projectId)
//       → assignments for every PDF across every building in a project
//
// Plus the pure helper `buildFolderTree` (no Dexie, no React).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import {
  usePdfFolders,
  usePdfFolderTree,
  buildFolderTree,
  usePdfFolderAssignment,
  usePdfFolderAssignmentsForBuilding,
  usePdfFolderAssignmentsForProject,
} from "@ff/data/hooks";
import { createPdfFolder, deletePdfFolder } from "@ff/data/db/tables/pdfFolders";
import { createPdfFolderAssignment, setAssignmentForPdf } from "@ff/data/db/tables/pdfFolderAssignments";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import type { PdfFolderRecord } from "@ff/types";

import { resetDb } from "../db/helpers";

async function makeContext() {
  const p = await createProject({ name: "HookTest", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { project: p, building: b };
}

describe("buildFolderTree (pure helper)", () => {
  it("returns [] for an empty list", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("puts a flat list into a single-level tree with depth=0", () => {
    const folders: PdfFolderRecord[] = [
      mkFolder("a", "B", null),
      mkFolder("b", "A", null),
    ];
    const tree = buildFolderTree(folders);
    expect(tree.length).toBe(2);
    expect(tree[0].folder.name).toBe("A");
    expect(tree[0].depth).toBe(0);
    expect(tree[1].folder.name).toBe("B");
  });

  it("nests children under their parent", () => {
    const root = mkFolder("r", "Root", null);
    const child = mkFolder("c", "Child", root.id);
    const grandchild = mkFolder("g", "Grandchild", child.id);
    const tree = buildFolderTree([root, child, grandchild]);
    expect(tree.length).toBe(1);
    expect(tree[0].folder.name).toBe("Root");
    expect(tree[0].children.length).toBe(1);
    expect(tree[0].children[0].folder.name).toBe("Child");
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].folder.name).toBe("Grandchild");
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("surfaces orphan rows as roots", () => {
    // parentId points at a non-existent id — surface as root so
    // the user doesn't lose data on a malformed migration.
    const orphan = mkFolder("o", "Orphan", "no-such-folder");
    const tree = buildFolderTree([orphan]);
    expect(tree.length).toBe(1);
    expect(tree[0].folder.name).toBe("Orphan");
    expect(tree[0].depth).toBe(0);
  });

  it("sorts siblings by name at every level", () => {
    const root = mkFolder("r", "Root", null);
    const c = mkFolder("c", "Z", root.id);
    const b = mkFolder("b", "A", root.id);
    const d = mkFolder("d", "M", root.id);
    const tree = buildFolderTree([root, c, b, d]);
    const names = tree[0].children.map((n) => n.folder.name);
    expect(names).toEqual(["A", "M", "Z"]);
  });
});

function mkFolder(id: string, name: string, parentId: string | null): PdfFolderRecord {
  return {
    id,
    projectId: "p",
    parentId,
    name,
    color: "blue",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("usePdfFolders + usePdfFolderTree (live queries)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetDb("usePdfFolders");
  });

  it("usePdfFolders returns [] when projectId is null", async () => {
    const { result } = renderHook(() => usePdfFolders(null));
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("usePdfFolders reflects inserts live", async () => {
    const { project } = await makeContext();
    const { result } = renderHook(() => usePdfFolders(project.id));
    await waitFor(() => expect(result.current).toEqual([]));

    await act(async () => {
      await createPdfFolder({ projectId: project.id, name: "Arch" });
    });
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].name).toBe("Arch");

    await act(async () => {
      await createPdfFolder({ projectId: project.id, name: "Finishes" });
    });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((f) => f.name)).toEqual(["Arch", "Finishes"]);
  });

  it("usePdfFolderTree nests children under their parent", async () => {
    const { project } = await makeContext();
    const root = await createPdfFolder({ projectId: project.id, name: "Plans" });
    await createPdfFolder({
      projectId: project.id,
      name: "Floor",
      parentId: root.id,
    });

    const { result } = renderHook(() => usePdfFolderTree(project.id));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].folder.name).toBe("Plans");
    expect(result.current[0].children.length).toBe(1);
    expect(result.current[0].children[0].folder.name).toBe("Floor");
    expect(result.current[0].children[0].depth).toBe(1);
  });

  it("usePdfFolderTree reflects deletes (parent cascade)", async () => {
    const { project } = await makeContext();
    const root = await createPdfFolder({ projectId: project.id, name: "Plans" });
    await createPdfFolder({
      projectId: project.id,
      name: "Floor",
      parentId: root.id,
    });

    const { result } = renderHook(() => usePdfFolderTree(project.id));
    await waitFor(() => expect(result.current.length).toBe(1));
    await act(async () => {
      await deletePdfFolder(root.id);
    });
    await waitFor(() => expect(result.current.length).toBe(0));
  });
});

describe("usePdfFolderAssignment (single-PDF live query)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetDb("usePdfFolderAssignment");
  });

  it("returns undefined when pdfFileId is null", async () => {
    const { result } = renderHook(() => usePdfFolderAssignment(null));
    await waitFor(() => expect(result.current).toBeUndefined());
  });

  it("returns the assignment row when present", async () => {
    const { project, building } = await makeContext();
    const f = await createPdfFile({ buildingId: building.id, name: "p.pdf" });
    const folder = await createPdfFolder({ projectId: project.id, name: "X" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });

    const { result } = renderHook(() => usePdfFolderAssignment(f.id));
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.folderId).toBe(folder.id);
  });

  it("returns undefined after the assignment is cleared", async () => {
    const { project, building } = await makeContext();
    const f = await createPdfFile({ buildingId: building.id, name: "p.pdf" });
    const folder = await createPdfFolder({ projectId: project.id, name: "X" });
    await createPdfFolderAssignment({ pdfFileId: f.id, folderId: folder.id });

    const { result } = renderHook(() => usePdfFolderAssignment(f.id));
    await waitFor(() => expect(result.current).toBeDefined());

    await act(async () => {
      await setAssignmentForPdf(f.id, null);
    });
    await waitFor(() => expect(result.current).toBeUndefined());
  });
});

describe("usePdfFolderAssignmentsForBuilding", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetDb("usePdfFolderAssignmentsForBuilding");
  });

  it("returns [] when buildingId is null", async () => {
    const { result } = renderHook(() =>
      usePdfFolderAssignmentsForBuilding(null),
    );
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("returns assignments for PDFs in the active building only", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b1 = await createBuilding({ projectId: p.id, name: "B1", metadata: {} });
    const b2 = await createBuilding({ projectId: p.id, name: "B2", metadata: {} });
    const f1 = await createPdfFile({ buildingId: b1.id, name: "1.pdf" });
    const f2 = await createPdfFile({ buildingId: b2.id, name: "2.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "X" });
    await createPdfFolderAssignment({ pdfFileId: f1.id, folderId: folder.id });
    await createPdfFolderAssignment({ pdfFileId: f2.id, folderId: folder.id });

    const { result } = renderHook(() =>
      usePdfFolderAssignmentsForBuilding(b1.id),
    );
    await waitFor(() => expect(result.current?.length).toBe(1));
    expect(result.current![0].pdfFileId).toBe(f1.id);
  });
});

describe("usePdfFolderAssignmentsForProject", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetDb("usePdfFolderAssignmentsForProject");
  });

  it("returns assignments across all buildings in a project", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b1 = await createBuilding({ projectId: p.id, name: "B1", metadata: {} });
    const b2 = await createBuilding({ projectId: p.id, name: "B2", metadata: {} });
    const f1 = await createPdfFile({ buildingId: b1.id, name: "1.pdf" });
    const f2 = await createPdfFile({ buildingId: b2.id, name: "2.pdf" });
    const folder = await createPdfFolder({ projectId: p.id, name: "X" });
    await createPdfFolderAssignment({ pdfFileId: f1.id, folderId: folder.id });
    await createPdfFolderAssignment({ pdfFileId: f2.id, folderId: folder.id });

    const { result } = renderHook(() =>
      usePdfFolderAssignmentsForProject(p.id),
    );
    await waitFor(() => expect(result.current?.length).toBe(2));
  });

  it("ignores PDFs in other projects", async () => {
    const p1 = await createProject({ name: "P1", metadata: {} });
    const p2 = await createProject({ name: "P2", metadata: {} });
    const b1 = await createBuilding({ projectId: p1.id, name: "B1", metadata: {} });
    const b2 = await createBuilding({ projectId: p2.id, name: "B2", metadata: {} });
    const f1 = await createPdfFile({ buildingId: b1.id, name: "1.pdf" });
    const f2 = await createPdfFile({ buildingId: b2.id, name: "2.pdf" });
    const folder = await createPdfFolder({ projectId: p1.id, name: "X" });
    await createPdfFolderAssignment({ pdfFileId: f1.id, folderId: folder.id });
    await createPdfFolderAssignment({ pdfFileId: f2.id, folderId: folder.id });

    const { result } = renderHook(() =>
      usePdfFolderAssignmentsForProject(p1.id),
    );
    await waitFor(() => expect(result.current?.length).toBe(1));
    expect(result.current![0].pdfFileId).toBe(f1.id);
  });
});