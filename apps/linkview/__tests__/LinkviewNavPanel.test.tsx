// apps/linkview/__tests__/LinkviewNavPanel.test.tsx
//
// Wave 55 — panel-slot tests (replaces LinkviewSidebar.test.tsx).
// The Mapped PDFs / Model Floor Plans lists moved from the persistent
// sidebar into the ONE floating panel slot (tenant of the tools
// toolbar). The filtering rules, row callbacks, and active-row
// highlighting are unchanged, so the wave-52 fixtures and assertions
// carry over verbatim per tenant.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { db } from "@ff/data/db/database";
import type {
  BuildingRecord,
  CalibrationRecord,
  ExtractedStoreyRecord,
  PdfFileRecord,
  PdfVersionRecord,
  StoreyRecord,
} from "@ff/types";

const authMock = vi.hoisted(() => ({ projectId: "p1" as string | undefined }));
vi.mock("@ff/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ff/auth")>()),
  useProjectId: () => authMock.projectId,
}));

import LinkviewNavPanel from "../src/LinkviewNavPanel";

/** Render the panel slot directly (no provider needed). */
function renderPanel(
  overrides: Partial<ComponentProps<typeof LinkviewNavPanel>> = {},
) {
  const props: ComponentProps<typeof LinkviewNavPanel> = {
    activePanel: "pdfs",
    onClose: () => {},
    buildingId: null,
    onBuildingChange: () => {},
    activePdfVersionId: null,
    onActivatePdf: () => {},
    activeStoreyId: null,
    onActivateStorey: () => {},
    ...overrides,
  };
  return render(<LinkviewNavPanel {...props} />);
}

// ── Test fixtures ─────────────────────────────────────────────────────

async function clearAllTables(): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
}

async function seedBuilding(
  id: string,
  name: string,
  projectId = "p1",
): Promise<BuildingRecord> {
  const building: BuildingRecord = {
    id,
    projectId,
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
  fileId: string,
  filename: string,
  versionNumber = 1,
): Promise<{ file: PdfFileRecord; version: PdfVersionRecord }> {
  const file: PdfFileRecord = {
    id: fileId,
    buildingId: building.id,
    name: filename,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.pdfFiles.add(file);
  const version: PdfVersionRecord = {
    id: `${fileId}-v${versionNumber}`,
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

async function seedStorey(
  building: BuildingRecord,
  id: string,
  name: string,
  elevation: number,
  ifcVersionId = "ifcv-test",
): Promise<StoreyRecord> {
  const storey: StoreyRecord = {
    id,
    buildingId: building.id,
    ifcVersionId,
    sourceIfcFileId: "ifc-test",
    name,
    elevation,
    expressId: 1,
    height: 3,
    containedElementIds: [],
  };
  await db.storeys.add(storey);
  return storey;
}

async function seedCalibration(
  pdfFileId: string,
  storeyName: string,
  projectId = "p1",
): Promise<CalibrationRecord> {
  const cal: CalibrationRecord = {
    id: `cal-${pdfFileId}-${storeyName}`,
    projectId,
    pdfFileId,
    storeyName,
    pointPairs: [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 1, worldX: 1, worldZ: 1 },
    ],
    transformParams: {
      scale: 1,
      rotation: 0,
      translateX: 0,
      translateZ: 0,
    },
    confidence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.calibrations.add(cal);
  return cal;
}

async function seedExtracted(
  building: BuildingRecord,
  storeyId: string,
): Promise<ExtractedStoreyRecord> {
  const e: ExtractedStoreyRecord = {
    id: `ext-${building.id}-${storeyId}`,
    buildingId: building.id,
    storeyId,
    updatedAt: Date.now(),
  };
  await db.extractedStoreys.add(e);
  return e;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("LinkviewNavPanel", () => {
  beforeEach(async () => {
    authMock.projectId = "p1";
    if (!db.isOpen()) await db.open();
    await clearAllTables();
  });

  it("renders no building picker and no data while the project id is undefined", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    authMock.projectId = undefined;
    renderPanel({ buildingId: building.id, activePanel: "pdfs" });
    expect(await screen.findByTestId("linkview-nav-panel")).toBeInTheDocument();
    expect(screen.queryByText("Torre A")).not.toBeInTheDocument();
    expect(await screen.findByTestId("linkview-section-empty")).toBeInTheDocument();
  });

  it("scopes the mapped PDFs to the current project", async () => {
    const building = await seedBuilding("b-mine", "Mine", "p1");
    await seedStorey(building, "s1", "Ground", 0);
    const { file } = await seedPdf(building, "f1", "plan.pdf");
    await seedCalibration(file.id, "Ground", "p2");
    renderPanel({ buildingId: building.id, activePanel: "pdfs" });
    expect(await screen.findByTestId("linkview-section-empty")).toBeInTheDocument();
    expect(screen.queryByText("plan.pdf")).not.toBeInTheDocument();
  });

  it("renders the shared panel slot shell", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    renderPanel({ buildingId: building.id });
    expect(await screen.findByTestId("linkview-nav-panel")).toBeInTheDocument();
  });

  it("shows the empty hint in the pdfs tenant when there are no mapped PDFs", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");

    renderPanel({ buildingId: building.id, activePanel: "pdfs" });

    expect(
      await screen.findByTestId("linkview-section-empty"),
    ).toBeInTheDocument();
    expect(screen.getByText(/No PDFs mapped to a level/i)).toBeInTheDocument();
  });

  it("shows the empty hint in the plans tenant when nothing is extracted", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");

    renderPanel({ buildingId: building.id, activePanel: "plans" });

    expect(
      await screen.findByTestId("linkview-section-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No extracted model floor plans/i),
    ).toBeInTheDocument();
  });

  it("shows a PDF in Mapped PDFs when its calibration matches a storey in the same building", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    const torreB = await seedBuilding("b-torre-b", "Torre B");
    const { file: planA } = await seedPdf(torreA, "pdf-plan-a", "Plan A.pdf");
    await seedPdf(torreB, "pdf-plan-b", "Plan B.pdf");
    await seedStorey(torreA, "st-a-ground", "Ground Floor", 0, "ifcv-a");
    await seedStorey(torreB, "st-b-ground", "Ground Floor", 0, "ifcv-b");
    await seedCalibration(planA.id, "Ground Floor");
    await seedCalibration("pdf-plan-b", "Ground Floor");

    renderPanel({ buildingId: torreA.id, activePanel: "pdfs" });

    expect(
      await screen.findByTestId(`linkview-pdf-row-${planA.name}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("linkview-pdf-row-Plan B.pdf"),
    ).not.toBeInTheDocument();
  });

  it("hides PDFs whose calibration storey is not in the active building", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    const { file } = await seedPdf(torreA, "pdf-orphan", "Orphan Plan.pdf");
    await seedStorey(torreA, "st-a-ground", "Ground Floor", 0);
    await seedCalibration(file.id, "Level 99");

    renderPanel({ buildingId: torreA.id, activePanel: "pdfs" });

    expect(
      await screen.findByText(/No PDFs mapped to a level/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("linkview-pdf-row-Orphan Plan.pdf"),
    ).not.toBeInTheDocument();
  });

  it("shows extracted storeys in the Model Floor Plans tenant", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(torreA, "st-a-ground", "Ground Floor", 0);
    const first = await seedStorey(torreA, "st-a-first", "First Floor", 3);
    await seedStorey(torreA, "st-a-roof", "Roof", 12);
    await seedExtracted(torreA, ground.id);
    await seedExtracted(torreA, first.id);

    renderPanel({ buildingId: torreA.id, activePanel: "plans" });

    expect(
      await screen.findByTestId(`linkview-storey-row-${ground.name}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`linkview-storey-row-${first.name}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("linkview-storey-row-Roof"),
    ).not.toBeInTheDocument();
  });

  it("calls onActivatePdf with the latest version id when a PDF row is clicked", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    await seedStorey(torreA, "st-a-ground", "Ground Floor", 0);
    const { file, version } = await seedPdf(torreA, "pdf-plan-a", "Plan A.pdf");
    await seedCalibration(file.id, "Ground Floor");

    const onActivatePdf = vi.fn();
    renderPanel({
      buildingId: torreA.id,
      activePanel: "pdfs",
      onActivatePdf,
    });

    const row = await screen.findByTestId(`linkview-pdf-row-${file.name}`);
    fireEvent.click(row);

    expect(onActivatePdf).toHaveBeenCalledTimes(1);
    expect(onActivatePdf).toHaveBeenCalledWith(version.id);
  });

  it("calls onActivateStorey with the storey id when a Model Floor Plans row is clicked", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(torreA, "st-a-ground", "Ground Floor", 0);
    await seedExtracted(torreA, ground.id);

    const onActivateStorey = vi.fn();
    renderPanel({
      buildingId: torreA.id,
      activePanel: "plans",
      onActivateStorey,
    });

    const row = await screen.findByTestId(`linkview-storey-row-${ground.name}`);
    fireEvent.click(row);

    expect(onActivateStorey).toHaveBeenCalledTimes(1);
    expect(onActivateStorey).toHaveBeenCalledWith(ground.id);
  });

  it("highlights the row whose id matches the active prop", async () => {
    const torreA = await seedBuilding("b-torre-a", "Torre A");
    await seedStorey(torreA, "st-a-ground", "Ground Floor", 0);
    const { file, version } = await seedPdf(torreA, "pdf-plan-a", "Plan A.pdf");
    await seedCalibration(file.id, "Ground Floor");

    renderPanel({
      buildingId: torreA.id,
      activePanel: "pdfs",
      activePdfVersionId: version.id,
    });

    const row = await screen.findByTestId(`linkview-pdf-row-${file.name}`);
    await waitFor(() => {
      expect(row.getAttribute("aria-current")).toBe("true");
    });
  });
});
