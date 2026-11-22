// __tests__/DocumentsPanelBody.test.tsx
//
// Wave 39 — the `docs` tenant body (formerly DocumentsSidebar's file
// list). Verifies the folder-first PDF list renders correctly, the
// empty state appears when there are no PDFs, and the building
// dimension is read from the SHARED modelsToolStore.activeBuildingId
// (the rail's combined switcher owns it now).
//
// Same Dexie seeding strategy the retired DocumentsSidebar.test.tsx
// used: seed db.pdfFiles + db.pdfVersions + db.buildings per test,
// render <DocumentsPanelBody>, and assert the DOM reflects the state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import type {
  BuildingRecord,
  PdfFileRecord,
  PdfVersionRecord,
} from "@ff/types";

import { useModelsToolStore } from "../../../packages/ff-viewer-tools/src/modelsToolStore";

import DocumentsPanelBody from "../src/DocumentsPanelBody";

async function clearAllTables(): Promise<void> {
  await db.transaction(
    "rw",
    db.tables,
    async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    },
  );
}

async function seedBuilding(name: string): Promise<BuildingRecord> {
  const building: BuildingRecord = {
    id: `b-${name.toLowerCase().replace(/\s+/g, "-")}`,
    projectId: "default-project",
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
  await db.buildings.add(building);
  return building;
}

async function seedPdf(
  building: BuildingRecord,
  filename: string,
  versionNumber = 1,
): Promise<{ file: PdfFileRecord; version: PdfVersionRecord }> {
  const file: PdfFileRecord = {
    id: `pdf-${building.id}-${filename}`,
    buildingId: building.id,
    name: filename,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.pdfFiles.add(file);
  const version: PdfVersionRecord = {
    id: `pdfv-${file.id}-v${versionNumber}`,
    pdfFileId: file.id,
    versionNumber,
    name: filename,
    size: 1024,
    contentHash: `hash-${file.id}-${versionNumber}`,
    pageCount: 1,
    width: 595,
    height: 842,
    storedAt: Date.now(),
    blobKey: `blob-${file.id}-${versionNumber}`,
    isLatest: true,
  };
  await db.pdfVersions.add(version);
  return { file, version };
}

function setActiveBuilding(buildingId: string | null): void {
  useModelsToolStore.setState({ activeBuildingId: buildingId });
}

describe("DocumentsPanelBody", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    setActiveBuilding(null);
  });

  it("renders the empty state when there are no PDFs", () => {
    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );
    expect(screen.getByTestId("documents-panel-empty")).toBeInTheDocument();
    expect(screen.getByText(/No documents yet/i)).toBeInTheDocument();
  });

  it("renders PDFs as a flat list under each folder (no per-building sub-group)", async () => {
    const torreA = await seedBuilding("Torre A");
    const torreB = await seedBuilding("Torre B");
    await seedPdf(torreA, "A-floor-3.pdf");
    const { file: bFile } = await seedPdf(torreB, "B-site-plan.pdf");
    await import("@ff/data/db/tables/pdfFolders").then((m) =>
      m.createPdfFolder({ projectId: "default-project", name: "Architecture" }),
    );

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    expect(await screen.findByText("A-floor-3.pdf")).toBeInTheDocument();
    expect(await screen.findByText("B-site-plan.pdf")).toBeInTheDocument();
    expect(await screen.findByText("Architecture")).toBeInTheDocument();
    expect(bFile.id).not.toBe("");
  });

  it("does not list PDFs whose building is gone (they belong to no project)", async () => {
    const orphan: PdfFileRecord = {
      id: "pdf-orphan",
      buildingId: "deleted-building-id",
      name: "orphan.pdf",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.pdfFiles.add(orphan);
    await db.pdfVersions.add({
      id: "pdfv-orphan-v1",
      pdfFileId: "pdf-orphan",
      versionNumber: 1,
      name: "orphan.pdf",
      size: 1024,
      contentHash: "h-orphan",
      pageCount: 1,
      width: 595,
      height: 842,
      storedAt: Date.now(),
      blobKey: "blob-orphan",
      isLatest: true,
    });

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    // Scoped to the current project's buildings (wave 66): an orphan
    // cannot be attributed to a project, so it is not shown.
    expect(await screen.findByTestId("documents-panel-empty")).toBeInTheDocument();
    expect(screen.queryByText("orphan.pdf")).toBeNull();
  });

  it("calls onActivate with the latest version id when a row is clicked", async () => {
    const building = await seedBuilding("Torre A");
    const { file, version } = await seedPdf(building, "plan.pdf");

    const onActivate = vi.fn();
    render(
      <DocumentsPanelBody
        activePdfVersionId={null}
        onActivate={onActivate}
      />,
    );

    const row = await screen.findByTestId(
      `documents-sidebar-row-${file.id}`,
    );
    fireEvent.click(row);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(version.id);
  });

  it("highlights the row whose versionId matches activePdfVersionId", async () => {
    const building = await seedBuilding("Torre A");
    const { file, version } = await seedPdf(building, "plan.pdf");

    const { container } = render(
      <DocumentsPanelBody
        activePdfVersionId={version.id}
        onActivate={() => {}}
      />,
    );

    const row = await waitFor(() => {
      const el = container.querySelector(
        `[data-testid="documents-sidebar-row-${file.id}"]`,
      );
      if (!el) throw new Error("row not yet rendered");
      return el as HTMLElement;
    });

    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("filters PDFs to the shared store's selected building only", async () => {
    const torreA = await seedBuilding("Torre A");
    const torreB = await seedBuilding("Torre B");
    await seedPdf(torreA, "A-only.pdf");
    await seedPdf(torreB, "B-only.pdf");

    setActiveBuilding(torreA.id);
    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    expect(await screen.findByText("A-only.pdf")).toBeInTheDocument();
    expect(screen.queryByText("B-only.pdf")).toBeNull();
  });
});

// ─── Folder wiring (Task 20F) ──────────────────────────────────

describe("DocumentsPanelBody — folder grouping (Task 20F)", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    setActiveBuilding(null);
  });

  it("groups PDFs by folder when folders exist", async () => {
    const torreA = await seedBuilding("Torre A");
    const torreB = await seedBuilding("Torre B");
    const archFolder = await import("@ff/data/db/tables/pdfFolders").then((m) =>
      m.createPdfFolder({ projectId: "default-project", name: "Architecture" }),
    );
    const finishesFolder = await import("@ff/data/db/tables/pdfFolders").then(
      (m) => m.createPdfFolder({ projectId: "default-project", name: "Finishes" }),
    );
    const { file: archA } = await seedPdf(torreA, "A-floor-3.pdf");
    await seedPdf(torreB, "B-sections.pdf");
    const { file: finB } = await seedPdf(torreB, "B-tile-layout.pdf");

    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({ pdfFileId: archA.id, folderId: archFolder.id }),
    );
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({ pdfFileId: finB.id, folderId: finishesFolder.id }),
    );

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    expect(await screen.findByText("Architecture")).toBeInTheDocument();
    expect(await screen.findByText("Finishes")).toBeInTheDocument();
    expect(await screen.findByText("A-floor-3.pdf")).toBeInTheDocument();
    expect(await screen.findByText("B-tile-layout.pdf")).toBeInTheDocument();
    expect(await screen.findByText("B-sections.pdf")).toBeInTheDocument();
    expect(await screen.findByText("Unfiled")).toBeInTheDocument();
  });

  it("does NOT render an Unfiled pseudo-folder when every PDF is filed", async () => {
    const torreA = await seedBuilding("Torre A");
    const folder = await import("@ff/data/db/tables/pdfFolders").then((m) =>
      m.createPdfFolder({ projectId: "default-project", name: "Architecture" }),
    );
    const { file } = await seedPdf(torreA, "plan.pdf");
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({ pdfFileId: file.id, folderId: folder.id }),
    );

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    await screen.findByText("Architecture");
    expect(screen.queryByText("Unfiled")).toBeNull();
  });

  it("renders nested folders with depth-based indentation", async () => {
    const torreA = await seedBuilding("Torre A");
    const { createPdfFolder } = await import("@ff/data/db/tables/pdfFolders");
    const root = await createPdfFolder({
      projectId: "default-project",
      name: "Plans",
    });
    const child = await createPdfFolder({
      projectId: "default-project",
      name: "Floor Plans",
      parentId: root.id,
    });
    const { file } = await seedPdf(torreA, "L1.pdf");
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({ pdfFileId: file.id, folderId: child.id }),
    );

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    expect(
      (await screen.findByTestId(`documents-folder-${root.id}`)).getAttribute(
        "data-folder-depth",
      ),
    ).toBe("0");
    expect(
      (await screen.findByTestId(`documents-folder-${child.id}`)).getAttribute(
        "data-folder-depth",
      ),
    ).toBe("1");
  });

  it("toggles a folder's open state when its header is clicked", async () => {
    const torreA = await seedBuilding("Torre A");
    const folder = await import("@ff/data/db/tables/pdfFolders").then((m) =>
      m.createPdfFolder({ projectId: "default-project", name: "Architecture" }),
    );
    const { file } = await seedPdf(torreA, "plan.pdf");
    await import("@ff/data/db/tables/pdfFolderAssignments").then((m) =>
      m.createPdfFolderAssignment({ pdfFileId: file.id, folderId: folder.id }),
    );

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    const header = await screen.findByTestId(
      `documents-folder-header-${folder.id}`,
    );
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(
      await screen.findByTestId(`documents-folder-body-${folder.id}`),
    ).toBeInTheDocument();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByTestId(`documents-folder-body-${folder.id}`),
    ).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("sorts folders alphabetically at each level", async () => {
    const { createPdfFolder } = await import("@ff/data/db/tables/pdfFolders");
    await createPdfFolder({ projectId: "default-project", name: "Finishes" });
    await createPdfFolder({ projectId: "default-project", name: "Architecture" });
    await createPdfFolder({ projectId: "default-project", name: "Furniture" });

    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={() => {}} />,
    );

    const folderHeaders = await screen.findAllByText(
      /^(Architecture|Finishes|Furniture)$/,
    );
    const labels = folderHeaders.map((n) => n.textContent);
    expect(labels).toEqual(["Architecture", "Finishes", "Furniture"]);
  });
});

describe("DocumentsPanelBody compare row action", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    setActiveBuilding(null);
  });

  it("shows only on rows with more than one version and fires onCompare", async () => {
    const b = await seedBuilding("Torre C");
    const { file: multi } = await seedPdf(b, "multi.pdf", 1);
    await db.pdfVersions.update(`pdfv-${multi.id}-v1`, { isLatest: false });
    await db.pdfVersions.add({
      id: `pdfv-${multi.id}-v2`,
      pdfFileId: multi.id,
      versionNumber: 2,
      name: "multi.pdf",
      size: 1,
      contentHash: "h2",
      pageCount: 1,
      width: 595,
      height: 842,
      storedAt: Date.now(),
      blobKey: "k2",
      isLatest: true,
    });
    const { file: single } = await seedPdf(b, "single.pdf", 1);
    const onCompare = vi.fn();
    const onActivate = vi.fn();
    render(
      <DocumentsPanelBody activePdfVersionId={null} onActivate={onActivate} onCompare={onCompare} />,
    );
    const btn = await screen.findByTestId(`documents-compare-row-${multi.id}`);
    expect(screen.queryByTestId(`documents-compare-row-${single.id}`)).toBeNull();
    fireEvent.click(btn);
    expect(onCompare).toHaveBeenCalledWith(multi.id);
    // does not activate the row
    expect(onActivate).not.toHaveBeenCalled();
  });
});
