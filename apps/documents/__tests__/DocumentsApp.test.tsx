// __tests__/DocumentsApp.test.tsx
//
// Wave 39 — the Documents route adopts the wave-35 toolbar chrome.
// Wave 56 — the toolbar MERGED the Models module's filter tenants and
// the route now registers the shared 3D surface host, so this now
// verifies the full-bleed viewer + ONE floating frosted toolbar
// (4 buttons: Models & Levels, Filters, Documents, Outline) + ONE
// panel slot defaulting to the `docs` tenant, plus the tenant swap,
// the surface host slot, and the empty states for the viewer and the
// outline tenant.
//
// PdfOverlay is mocked because it pulls in Three.js, which fails in
// jsdom. The shell test only cares that the layout mounts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@ff/viewer-react", () => ({
  PdfOverlay: (props: { pdfVersionId: string; onClose?: () => void; allowMultiPage?: boolean }) => (
    <div
      data-testid="mock-pdf-overlay"
      data-version={props.pdfVersionId}
      data-multipage={String(props.allowMultiPage ?? false)}
    >
      {props.onClose ? (
        <button type="button" data-testid="mock-pdf-close" onClick={props.onClose}>
          ×
        </button>
      ) : null}
    </div>
  ),
}));

// Wave 41 — the auto-open effect reads the grouped PDF list; stub the
// hook with a hoisted shape the tests can re-arm per case (default:
// empty groups, matching the no-PDFs-seeded shell tests).
const h = vi.hoisted(() => ({
  groups: {
    tree: [] as unknown[],
    folderGroups: new Map<string, unknown>(),
    rows: [] as Array<{ latestVersionId: string }>,
  },
}));
vi.mock("../src/hooks/useDocumentsGroups", () => ({
  useDocumentsGroups: () => h.groups,
}));

import { useModelsToolStore } from "../../../packages/ff-viewer-tools/src/modelsToolStore";

import { DocumentsApp, useDocumentsViewState } from "../src";
import { act, waitFor } from "@testing-library/react";
import { db } from "@ff/data/db/database";

/** Wave 56 — the route receives the shared-viewer host seam props. */
function renderApp() {
  return render(
    <DocumentsApp
      viewerRef={{ current: null } as never}
      registerHost={() => {}}
    />,
  );
}

beforeEach(() => {
  useModelsToolStore.setState({ activeBuildingId: null });
  h.groups = { tree: [], folderGroups: new Map(), rows: [] };
});

describe("DocumentsApp shell", () => {
  it("renders the full-bleed viewer, floating toolbar and the docs panel by default", () => {
    renderApp();

    // The shared 3D surface host slot renders behind the PDF panel.
    expect(
      screen.getByTestId("documents-viewer-surface"),
    ).toBeInTheDocument();

    // Viewer panel mounts with its empty state (no PDF selected).
    expect(screen.getByTestId("documents-viewer-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Pick a PDF from the sidebar/i),
    ).toBeInTheDocument();

    // Documents is PDF-only: just the Documents + Outline tenants
    // (the model tools live in Models / LinkView, 2026-11-14).
    const toolbar = screen.getByTestId("documents-nav-toolbar");
    expect(toolbar.querySelectorAll("button")).toHaveLength(2);
    expect(screen.queryByTitle("Models & Levels")).toBeNull();
    expect(screen.queryByTitle("Filters")).toBeNull();
    expect(screen.getByTitle("Documents")).toBeInTheDocument();
    expect(screen.getByTitle("Outline")).toBeInTheDocument();

    // The ONE panel slot is open on `docs` by default.
    const panel = screen.getByTestId("documents-nav-panel");
    expect(panel).toHaveAttribute("data-open", "true");
    expect(panel).toHaveAttribute("data-panel", "docs");
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent(
      "Documents",
    );

    // The docs tenant shows its empty state (no PDFs seeded).
    expect(screen.getByTestId("documents-panel-empty")).toBeInTheDocument();
  });

  it("swaps to the outline tenant and shows the empty state with no PDF open", () => {
    renderApp();

    fireEvent.click(screen.getByTestId("documents-nav-toolbar-outline"));

    const panel = screen.getByTestId("documents-nav-panel");
    expect(panel).toHaveAttribute("data-panel", "outline");
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent(
      "Outline",
    );
    expect(
      screen.getByTestId("documents-nav-panel-outline-empty"),
    ).toHaveTextContent(/Open a PDF to see its outline/i);
  });

  it("sits at the default offset while no PDF is open (nothing to clear)", () => {
    renderApp();
    expect(screen.getByTestId("documents-nav-toolbar").style.top).toBe("14px");
    expect(screen.getByTestId("documents-nav-panel").style.top).toBe("66px");
  });

  it("closes the panel when the active tenant is toggled again", () => {
    renderApp();

    const docsButton = screen.getByTestId("documents-nav-toolbar-docs");
    expect(
      screen.getByTestId("documents-nav-panel"),
    ).toHaveAttribute("data-open", "true");

    fireEvent.click(docsButton);

    expect(
      screen.getByTestId("documents-nav-panel"),
    ).toHaveAttribute("data-open", "false");
  });
});

describe("DocumentsApp auto-open (wave 41)", () => {
  it("opens the first PDF by default so the view never starts blank", () => {
    h.groups = {
      tree: [],
      folderGroups: new Map(),
      rows: [
        { latestVersionId: "v-first" },
        { latestVersionId: "v-second" },
      ],
    };
    renderApp();

    // The viewer mounts the PDF overlay instead of the empty state.
    expect(screen.queryByTestId("documents-viewer-empty")).toBeNull();
    expect(
      screen.getByTestId("documents-viewer-pdf-overlay"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mock-pdf-overlay")).toBeInTheDocument();
    // Wave 64 — the reader opens every page of a multi-page PDF.
    expect(screen.getByTestId("mock-pdf-overlay").getAttribute("data-multipage")).toBe("true");
  });

  it("stays on the empty state when the building has no PDFs", () => {
    h.groups = { tree: [], folderGroups: new Map(), rows: [] };
    renderApp();

    expect(
      screen.getByTestId("documents-viewer-empty"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mock-pdf-overlay")).toBeNull();
  });

  it("wave 63: the × closes the PDF and a PDF open is reported to the shell", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v-first" }] };
    renderApp();
    expect(useDocumentsViewState.getState().pdfOpen).toBe(true);
    fireEvent.click(screen.getByTestId("mock-pdf-close"));
    expect(screen.getByTestId("documents-viewer-empty")).toBeInTheDocument();
    expect(useDocumentsViewState.getState().pdfOpen).toBe(false);
  });

  it("wave 63: a building switch closes the old building's PDF and opens the new one's", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v-b1" }] };
    renderApp();
    expect(screen.getByTestId("mock-pdf-overlay").getAttribute("data-version")).toBe("v-b1");

    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v-b2" }] };
    act(() => {
      useModelsToolStore.setState({ activeBuildingId: "b2" });
    });
    expect(screen.getByTestId("mock-pdf-overlay").getAttribute("data-version")).toBe("v-b2");
  });

  it("wave 63: a building with no PDFs leaves the old PDF closed", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v-b1" }] };
    renderApp();
    h.groups = { tree: [], folderGroups: new Map(), rows: [] };
    act(() => {
      useModelsToolStore.setState({ activeBuildingId: "b2" });
    });
    expect(screen.queryByTestId("mock-pdf-overlay")).toBeNull();
  });
});

describe("DocumentsApp first-building pick (wave 66)", () => {
  const bld = (id: string, projectId: string, createdAt: number) => ({
    id, projectId, name: id, createdAt, updatedAt: createdAt, metadata: {},
  });

  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.buildings.clear();
    await db.buildings.bulkPut([bld("other", "other-project", 1), bld("mine", "default-project", 2)]);
  });

  it("picks the first building of the CURRENT project only", async () => {
    renderApp();
    await waitFor(() => expect(useModelsToolStore.getState().activeBuildingId).toBe("mine"));
  });

  it("picks nothing while there is no project", async () => {
    (globalThis as { __ffNoProject?: boolean }).__ffNoProject = true;
    try {
      renderApp();
      await new Promise((r) => setTimeout(r, 80));
      expect(useModelsToolStore.getState().activeBuildingId).toBeNull();
    } finally {
      (globalThis as { __ffNoProject?: boolean }).__ffNoProject = false;
    }
  });
});
