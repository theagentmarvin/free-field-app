// __tests__/components/MappedCalibrationsList.test.tsx
//
// Tests for <MappedCalibrationsList>: empty state, one row,
// expansion + sub-rows, delete cascade.

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import MappedCalibrationsList from "@components/MappedCalibrationsList";
import { useViewerStore } from "@store/useViewerStore";
import { db } from "@ff/data/db/database";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";
import { createCalibration } from "@ff/data/db/tables/calibrations";

import { resetDb } from "../db/helpers";

async function makeContext() {
  const p = await createProject({ name: "MappedList", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { project: p, building: b };
}

async function makeCalibration(
  pdfFileId: string,
  storeyName: string,
  projectId = "default-project",
) {
  return createCalibration({
    projectId,
    pdfFileId,
    storeyName,
    pointPairs: [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 1, worldX: 2, worldZ: 2 },
    ] as never,
    transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
    confidence: 1,
  });
}

describe("<MappedCalibrationsList>", () => {
  beforeEach(async () => {
    await resetDb("MappedCalibrationsList");
    useViewerStore.setState({
      activePdfVersionId: null,
      activeStoreyName: null,
      calibrationFlow: null,
    });
  });

  it("renders the empty state when no calibrations exist", async () => {
    render(
      <MappedCalibrationsList projectId="default-project" buildingId="b" />,
    );
    const empty = await screen.findByTestId("mapped-list-empty");
    expect(empty.textContent).toMatch(/No mappings yet/);
  });

  it("renders one row per file with at least one calibration", async () => {
    const { building } = await makeContext();
    const f1 = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    const f2 = await createPdfFile({ buildingId: building.id, name: "b.pdf" });
    await makeCalibration(f1.id, "L1");
    await makeCalibration(f2.id, "L1");
    render(
      <MappedCalibrationsList projectId="default-project" buildingId={building.id} />,
    );
    const rows = await screen.findAllByTestId("mapped-row");
    expect(rows).toHaveLength(2);
    // Each row shows a count of calibrations.
    expect(
      within(rows[0]!).getByText("1"),
    ).toBeTruthy();
  });

  it("expanding a file row reveals the per-level sub-rows", async () => {
    const { building } = await makeContext();
    const f = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    await makeCalibration(f.id, "L1");
    await makeCalibration(f.id, "L2");
    render(
      <MappedCalibrationsList projectId="default-project" buildingId={building.id} />,
    );
    const row = (await screen.findAllByTestId("mapped-row"))[0]!;
    const chevron = within(row).getByTestId("mapped-row-chevron");
    // Initially collapsed.
    expect(chevron.dataset.expanded).toBe("false");
    fireEvent.click(chevron);
    await waitFor(() => {
      expect(chevron.dataset.expanded).toBe("true");
    });
    const subRows = await within(row).findAllByTestId("mapped-subrow");
    expect(subRows).toHaveLength(2);
  });

  it("clicking a file row opens the PDF in the right panel (live query resolves before click)", async () => {
    const { building } = await makeContext();
    // Add a PdfVersion so the latest-version lookup succeeds.
    const { createPdfVersion } = await import("@ff/data/db/tables/pdfVersions");
    const { putPdfBlob } = await import("@ff/data/db/tables/pdfBlobs");
    const f = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    const v = await createPdfVersion({
      pdfFileId: f.id,
      versionNumber: 1,
      name: "a.pdf",
      size: 9,
      contentHash: "h",
      pageCount: 1,
      width: 612,
      height: 792,
      blobKey: "k",
      isLatest: true,
    });
    await putPdfBlob("k", new Blob([new Uint8Array([1, 2, 3])]));
    await makeCalibration(f.id, "L1");
    render(
      <MappedCalibrationsList projectId="default-project" buildingId={building.id} />,
    );
    const row = (await screen.findAllByTestId("mapped-row"))[0]!;
    const header = within(row).getByTestId("mapped-row-header");
    // Wait for the live query to populate the `files` array
    // (usePdfFiles depends on Dexie's live query — async).
    await waitFor(() => {
      // After live-query resolves, the click handler will see
      // a non-null latestVersion. We can detect this by
      // clicking and asserting the active id is set.
      fireEvent.click(header);
      const id = useViewerStore.getState().activePdfVersionId;
      expect(id).toBe(v.id);
    });
  });

  it("deleting a sub-row removes the calibration (with confirm)", async () => {
    const { building } = await makeContext();
    const f = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    await makeCalibration(f.id, "L1");
    await makeCalibration(f.id, "L2");
    render(
      <MappedCalibrationsList projectId="default-project" buildingId={building.id} />,
    );
    const row = (await screen.findAllByTestId("mapped-row"))[0]!;
    const chevron = within(row).getByTestId("mapped-row-chevron");
    fireEvent.click(chevron);
    const subRows = await within(row).findAllByTestId("mapped-subrow");
    expect(subRows).toHaveLength(2);
    // Click delete on the first sub-row.
    const deleteBtn = within(subRows[0]!).getByTestId("mapped-subrow-delete");
    fireEvent.click(deleteBtn);
    // Confirm dialog opens — click the confirm button (text
    // "Delete" inside the modal).
    const confirmBtn = await screen.findByText("Delete", { selector: "button" });
    fireEvent.click(confirmBtn);
    await waitFor(async () => {
      const after = await db.calibrations.toArray();
      expect(after).toHaveLength(1);
    });
  });
});
