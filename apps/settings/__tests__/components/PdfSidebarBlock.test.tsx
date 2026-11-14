// __tests__/components/PdfSidebarBlock.test.tsx
//
// Tests for <PdfSidebarBlock>.
//
// Task 5 (Mapped Levels sub-section) — three tests verifying the
// sub-section header renders, that the empty state shows up when
// the building has no extracted storeys, and that extracted rows
// render in elevation order. <MappedStoreysSection> still lives
// in the same place and is rendered the same way.
//
// Task 11 (PDF Canvas) — replaces the previous "MOCK_MAPPED
// placeholder" assertion (the mock is gone). The new behaviors
// covered here:
//   - With no building selected, the `+` icon is a non-clickable
//     hint (cannot upload).
//   - The empty state for the PDF list shows when no PDFs exist
//     for the active building.
//   - The "Mapped" sub-section stays empty (Step 2) — its
//     empty-state copy is rendered when the chevron is open.
//   - The `+` icon wires to a hidden file input. When
//     `buildingId` is set, a label and a file input are present.
//
// We don't exercise the upload handler here — the pipeline is
// exercised via `usePdfPipeline` (covered by loadPdf.test.ts and
// the pipeline integration tests).

import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ projectId: "p-1" as string | undefined }));
vi.mock("@ff/auth", async (orig) => ({
  ...(await orig<typeof import("@ff/auth")>()),
  useProjectId: () => auth.projectId,
}));

import { fireEvent } from "@testing-library/react";
import { useViewerStore } from "@store/useViewerStore";
import { createRef, type ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";

import PdfSidebarBlock from "@components/PdfSidebarBlock";
import { ViewerHandleProvider } from "@ff/viewer-react";
import type { IfcViewerHandle } from "@ff/viewer-react";
import { db } from "@ff/data/db/database";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { createStorey } from "@ff/data/db/tables/storeys";
import { setExtracted } from "@ff/data/db/tables/extractedStoreys";

import { resetDb } from "../db/helpers";

/** Wrap a React element in a <ViewerHandleProvider> with a no-op ref. */
function withViewerHandle(ui: ReactElement): ReactElement {
  const ref = createRef<IfcViewerHandle>();
  return (
    <ViewerHandleProvider viewerRef={ref}>{ui}</ViewerHandleProvider>
  );
}

async function makeContext() {
  const p = await createProject({ name: "PdfBlock", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  const f = await createIfcFile({
    buildingId: b.id,
    name: "model.ifc",
    currentVersionId: "placeholder",
  });
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 0,
    isLatest: true,
  });
  await db.ifcFiles.update(f.id, { currentVersionId: v.id });
  return { project: p, building: b, file: f, version: v };
}

describe("<PdfSidebarBlock> — Mapped Levels sub-section (Task 5)", () => {
  beforeEach(async () => {
    await resetDb("PdfSidebarBlock");
  });

  it("renders without a building selected (no levels section visible)", () => {
    // The outer "Mapped Levels" wrapper was removed in Task 20
    // follow-up (it was a duplicate header — MappedStoreysSection
    // renders its own "Mapped" header internally). With no
    // building, MappedStoreysSection returns null, so neither
    // header nor rows should be present.
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    expect(
      screen.queryByRole("button", { name: /Mapped Levels/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("mapped-section")).not.toBeInTheDocument();
  });

  it("renders no mapped level rows when the building has no extracted storeys", async () => {
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    const empty = await screen.findByTestId("mapped-section-empty");
    expect(empty).toHaveTextContent(
      "No levels mapped yet. Click 'Get Levels' to extract.",
    );
    expect(screen.queryAllByTestId("mapped-section-row")).toHaveLength(0);
  });

  it("renders one row per extracted storey under the building, in elevation order", async () => {
    const { building, file, version } = await makeContext();
    const mid = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Mid",
      elevation: 5,
      expressId: 1,
      height: null,
    });
    const low = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Low",
      elevation: 1,
      expressId: 2,
      height: null,
    });
    const high = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "High",
      elevation: 10,
      expressId: 3,
      height: null,
    });
    await setExtracted(building.id, mid.id, true);
    await setExtracted(building.id, low.id, true);
    await setExtracted(building.id, high.id, true);

    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    const root = await screen.findByTestId("mapped-section");
    await waitFor(() => {
      expect(
        within(root).getAllByTestId("mapped-section-row"),
      ).toHaveLength(3);
    });
    const rows = within(root).getAllByTestId("mapped-section-row");
    const namesInOrder = rows.map((r) => r.textContent ?? "");
    const lowIdx = namesInOrder.findIndex((t) => t.includes("Low"));
    const midIdx = namesInOrder.findIndex((t) => t.includes("Mid"));
    const highIdx = namesInOrder.findIndex((t) => t.includes("High"));
    expect(lowIdx).toBe(0);
    expect(midIdx).toBe(1);
    expect(highIdx).toBe(2);
  });
});

describe("<PdfSidebarBlock> — PDF file list (Task 11)", () => {
  beforeEach(async () => {
    await resetDb("PdfSidebarBlock-Task11");
  });

  it("renders the empty PDF list with the upload prompt when no PDFs exist", async () => {
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    await waitFor(() => {
      expect(
        screen.getByText(
          "No PDF files yet. Click + above to upload a PDF (calibration uses page 1).",
        ),
      ).toBeInTheDocument();
    });
  });

  it("shows a non-interactive upload hint when no building is selected", () => {
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    // The label is replaced by a non-interactive <span> when no
    // building is selected. The hidden file input still exists in
    // the markup (it always does — see the disabled-hint span
    // click handler in the component), but the visible trigger
    // is the disabled hint.
    expect(
      screen.getByTestId("pdf-upload-trigger-disabled"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-upload-trigger")).toBeNull();
  });

  it("wires the `+` icon to a hidden file input when a building is selected", async () => {
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    const trigger = await screen.findByTestId("pdf-upload-trigger");
    expect(trigger.tagName).toBe("LABEL");
    expect(trigger.getAttribute("for")).toBe("pdf-upload-input");
    const input = screen.getByTestId("pdf-upload-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("application/pdf");
  });

  it("renders the Mapped sub-section with the new pointer to the Map sub-tab", async () => {
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    const empty = await screen.findByTestId("pdf-mapped-empty");
    // Task 12a Part 2: the Step-2-placeholder copy was
    // replaced with a pointer to the Map sub-tab. The
    // sub-tab itself is fully functional now.
    expect(empty.textContent).toMatch(/Map sub-tab/i);
  });
});

// ─── Task 12a Part 2: Map sub-tab + Map button ─────────────

describe("<PdfSidebarBlock> — Map sub-tab (Task 12a Part 2)", () => {
  beforeEach(async () => {
    await resetDb("PdfSidebarBlock-MapTab");
    useViewerStore.setState({
      calibrationFlow: null,
      activePdfVersionId: null,
      activeStoreyName: null,
    });
  });

  it("renders the Map sub-tab", () => {
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    expect(screen.getByTestId("pdf-subtab-map")).toBeTruthy();
  });

  it("clicking the Map sub-tab shows the MappedCalibrationsList empty state", async () => {
    const { building } = await makeContext();
    render(
      withViewerHandle(<PdfSidebarBlock buildingId={building.id} />),
    );
    fireEvent.click(screen.getByTestId("pdf-subtab-map"));
    const empty = await screen.findByTestId("mapped-list-empty");
    expect(empty.textContent).toMatch(/No mappings yet/);
  });

  it("shows a Map button on each Unmapped PDF row (disabled when no level is open)", async () => {
    const { building } = await makeContext();
    // Add a PDF row to the building.
    const { createPdfFile } = await import("@ff/data/db/tables/pdfFiles");
    const { createPdfVersion } = await import(
      "@ff/data/db/tables/pdfVersions"
    );
    const { putPdfBlob } = await import("@ff/data/db/tables/pdfBlobs");
    const pdfFile = await createPdfFile({
      buildingId: building.id,
      name: "x.pdf",
    });
    await createPdfVersion({
      pdfFileId: pdfFile.id,
      versionNumber: 1,
      name: "x.pdf",
      size: 9,
      contentHash: "h",
      pageCount: 1,
      width: 612,
      height: 792,
      blobKey: "k",
      isLatest: true,
    });
    await putPdfBlob("k", new Blob([new Uint8Array([1, 2, 3])]));

    render(
      withViewerHandle(<PdfSidebarBlock buildingId={building.id} />),
    );
    const mapBtn = await screen.findByTestId("pdf-list-item-map");
    expect(mapBtn).toBeTruthy();
    // No level is open → button is disabled.
    expect((mapBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Map button is enabled when a level is open, and clicking opens the calibration wizard", async () => {
    const { building } = await makeContext();
    const { createPdfFile } = await import("@ff/data/db/tables/pdfFiles");
    const { createPdfVersion } = await import(
      "@ff/data/db/tables/pdfVersions"
    );
    const { putPdfBlob } = await import("@ff/data/db/tables/pdfBlobs");
    const pdfFile = await createPdfFile({
      buildingId: building.id,
      name: "x.pdf",
    });
    await createPdfVersion({
      pdfFileId: pdfFile.id,
      versionNumber: 1,
      name: "x.pdf",
      size: 9,
      contentHash: "h",
      pageCount: 1,
      width: 612,
      height: 792,
      blobKey: "k",
      isLatest: true,
    });
    await putPdfBlob("k", new Blob([new Uint8Array([1, 2, 3])]));

    // Mark a level as active (mock the IfcViewer's openLevel).
    useViewerStore.getState().setActiveStoreyName("Level 1");
    render(
      withViewerHandle(<PdfSidebarBlock buildingId={building.id} />),
    );
    const mapBtn = await screen.findByTestId("pdf-list-item-map");
    expect((mapBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mapBtn);
    const flow = useViewerStore.getState().calibrationFlow;
    expect(flow).not.toBeNull();
    expect(flow?.pdfFileId).toBe(pdfFile.id);
    expect(flow?.storeyName).toBe("Level 1");
    expect(flow?.step).toBe("PICK_PDF_A");
  });
});

// ─── Task 20F: Folders sub-tab (PDF folder grouping) ───────

describe("<PdfSidebarBlock> — Folders sub-tab (Task 20F)", () => {
  beforeEach(async () => {
    await resetDb("PdfSidebarBlock-FoldersTab");
    useViewerStore.setState({
      calibrationFlow: null,
      activePdfVersionId: null,
      activeStoreyName: null,
    });
  });

  it("renders the Folders sub-tab button (replaces the old Tags placeholder)", () => {
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    expect(screen.getByTestId("pdf-subtab-folders")).toBeTruthy();
    expect(screen.queryByText("Tags")).toBeNull();
  });

  it("clicking the Folders sub-tab mounts <PdfFoldersSidebar>", async () => {
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    fireEvent.click(screen.getByTestId("pdf-subtab-folders"));
    // The sidebar's empty state is the tell that we're in the
    // Folders body — not the old "Tags filter is coming soon" copy.
    const empty = await screen.findByTestId("folder-tree-empty");
    expect(empty.textContent).toMatch(/No folders yet/);
  });
});

describe("<PdfSidebarBlock> — project scoping (wave 66)", () => {
  beforeEach(async () => {
    await resetDb("PdfBlockScope");
    auth.projectId = "p-1";
  });

  it("with a project the Folders tab mounts the folders sidebar", async () => {
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    fireEvent.click(await screen.findByTestId("pdf-subtab-folders"));
    expect(await screen.findByTestId("pdf-folders-sidebar")).toBeInTheDocument();
  });

  it("with no project the Folders and Map tabs render nothing and do not throw", async () => {
    auth.projectId = undefined;
    const { building } = await makeContext();
    render(withViewerHandle(<PdfSidebarBlock buildingId={building.id} />));
    fireEvent.click(await screen.findByTestId("pdf-subtab-folders"));
    expect(screen.queryByTestId("pdf-folders-sidebar")).toBeNull();
    fireEvent.click(screen.getByTestId("pdf-subtab-map"));
    expect(screen.getByTestId("pdf-list").children.length).toBe(0);
  });
});
