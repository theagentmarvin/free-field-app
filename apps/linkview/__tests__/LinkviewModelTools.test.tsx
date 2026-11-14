// apps/linkview/__tests__/LinkviewModelTools.test.tsx
//
// 2026-11-14 — the Models module's filter tools in LinkView's right
// (3D) pane: the tools toolbar gains "Models & Levels" + "Filters",
// and the panel slot renders the SAME @ff/viewer-tools panels the
// Models / Documents modules use, so hiding a model here writes the
// shared store the persistent 3D surface applies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

import { db } from "@ff/data/db/database";
import { ViewerToolsProvider, useModelsToolStore } from "@ff/viewer-tools";

vi.mock("@ff/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ff/auth")>()),
  useProjectId: () => "p1",
}));

import LinkviewNavToolbar from "../src/LinkviewNavToolbar";
import LinkviewNavPanel from "../src/LinkviewNavPanel";
import { linkviewDataSource } from "../src/linkviewDataSource";

function renderPanel(
  overrides: Partial<ComponentProps<typeof LinkviewNavPanel>> = {},
) {
  const props: ComponentProps<typeof LinkviewNavPanel> = {
    activePanel: "models",
    onClose: () => {},
    buildingId: "b1",
    onBuildingChange: () => {},
    activePdfVersionId: null,
    onActivatePdf: () => {},
    activeStoreyId: null,
    onActivateStorey: () => {},
    ...overrides,
  };
  return render(
    <ViewerToolsProvider dataSource={linkviewDataSource}>
      <LinkviewNavPanel {...props} />
    </ViewerToolsProvider>,
  );
}

async function seed(): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
  const now = Date.now();
  await db.buildings.add({ id: "b1", projectId: "p1", name: "Tower", createdAt: now, updatedAt: now, metadata: {} });
  for (const [id, name] of [["f-arch", "ARCHITECTURAL.ifc"], ["f-mep", "MECHANICAL.ifc"]] as const) {
    await db.ifcFiles.add({ id, buildingId: "b1", name, currentVersionId: `${id}-v1`, createdAt: now, updatedAt: now });
    await db.ifcVersions.add({
      id: `${id}-v1`, ifcFileId: id, versionNumber: 1, ifcFileSize: 1, contentHash: id,
      fragBlobKey: `${id}__v1`, storeyCount: 0, isLatest: true, createdAt: now,
    } as never);
  }
}

beforeEach(async () => {
  useModelsToolStore.setState({ activeBuildingId: "b1" } as never);
  await seed();
});
afterEach(() => cleanup());

describe("LinkView tools toolbar — model tools", () => {
  it("offers Models & Levels and Filters before the PDF/plan panels", () => {
    const onToggle = vi.fn();
    render(
      <LinkviewNavToolbar
        activePanel="filters"
        onTogglePanel={onToggle}
        mode="split"
        onModeChange={() => {}}
      />,
    );
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 4)).toEqual([
      "Models & Levels",
      "Filters",
      "Mapped PDFs",
      "Model Floor Plans",
    ]);
    expect(screen.getByTestId("linkview-tools-filters")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("linkview-tools-models"));
    expect(onToggle).toHaveBeenCalledWith("models");
  });
});

describe("LinkView panel slot — model tools", () => {
  it("renders the shared Models & Levels panel with the building's models", async () => {
    renderPanel({ activePanel: "models" });
    expect(screen.getByTestId("models-levels-panel")).toBeInTheDocument();
    expect(await screen.findByText("ARCHITECTURAL.ifc")).toBeInTheDocument();
    expect(screen.getByText("MECHANICAL.ifc")).toBeInTheDocument();
    // The PDF-list building picker belongs to the PDF/plan tenants only.
    expect(screen.queryByTestId("linkview-section-mapped-pdfs")).toBeNull();
  });

  it("hiding a model flips its switch (shared visibility store)", async () => {
    renderPanel({ activePanel: "models" });
    const hide = await screen.findByLabelText("Hide ARCHITECTURAL.ifc");
    fireEvent.click(hide);
    await waitFor(() =>
      expect(screen.getByLabelText("Show ARCHITECTURAL.ifc")).toBeInTheDocument(),
    );
  });

  it("renders the shared Filters panel", () => {
    renderPanel({ activePanel: "filters" });
    expect(screen.getByTestId("custom-filters-panel")).toBeInTheDocument();
    expect(screen.getByTestId("filters-create-filter")).toBeInTheDocument();
  });
});
