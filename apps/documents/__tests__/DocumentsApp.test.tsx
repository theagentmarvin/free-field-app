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
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@ff/viewer-react", () => ({
  PdfOverlay: (props: { pdfVersionId: string; allowMultiPage?: boolean }) => (
    <div
      data-testid="mock-pdf-overlay"
      data-version={props.pdfVersionId}
      data-multipage={String(props.allowMultiPage ?? false)}
    />
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

// The toolbar's Tasks entry reads the building's task rows; stub the source
// (no Firebase in jsdom) with rows the tests can re-arm.
const t = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@ff/tasks-react", async (orig) => ({
  ...(await orig<typeof import("@ff/tasks-react")>()),
  usePanelTasks: () => t.rows,
  usePanelActorUid: () => "u1",
}));

import { useModelsToolStore } from "../../../packages/ff-viewer-tools/src/modelsToolStore";

import { DocumentsApp, useDocumentsViewState } from "../src";
import { useCompareStore } from "../src/compare/compareStore";
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
  useCompareStore.getState().close();
  useModelsToolStore.setState({ activeBuildingId: null });
  h.groups = { tree: [], folderGroups: new Map(), rows: [] };
  t.rows = [];
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

    // Documents is PDF-only: the Documents + Outline + Compare revisions
    // tenants (the model tools live in Models / LinkView, 2026-11-14).
    const toolbar = screen.getByTestId("documents-nav-toolbar");
    expect(toolbar.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTitle("Compare revisions")).toBeInTheDocument();
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

  it("opens the compare tenant, prefilled from the open PDF, and Exit restores the PDF", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = {
      tree: [],
      folderGroups: new Map(),
      rows: [
        {
          latestVersionId: "f1-v2",
          file: { id: "f1" },
          versions: [
            { id: "f1-v1", pdfFileId: "f1", versionNumber: 1 },
            { id: "f1-v2", pdfFileId: "f1", versionNumber: 2 },
          ],
        },
      ] as never,
    };
    renderApp();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-compare"));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-panel", "compare");
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent("Compare revisions");
    expect(screen.getByTestId("documents-compare-panel")).toBeInTheDocument();
    const st = useCompareStore.getState();
    expect(st.active).toBe(true);
    expect(st.base?.pdfVersionId).toBe("f1-v1");
    expect(st.revision?.pdfVersionId).toBe("f1-v2");
    // The compare viewer replaces the PDF overlay.
    expect(screen.getByTestId("documents-compare-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-pdf-overlay")).toBeNull();
    expect(useDocumentsViewState.getState().pdfOpen).toBe(true);

    // Closing the panel keeps compare active.
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-compare"));
    expect(useCompareStore.getState().active).toBe(true);
    expect(screen.getByTestId("documents-compare-viewer")).toBeInTheDocument();

    // Exit compare restores the PDF.
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-compare"));
    fireEvent.click(screen.getByTestId("documents-compare-exit"));
    expect(useCompareStore.getState().active).toBe(false);
    expect(screen.getByTestId("mock-pdf-overlay").getAttribute("data-version")).toBe("f1-v2");
  });

  it("a building switch exits compare", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    renderApp();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-compare"));
    expect(useCompareStore.getState().active).toBe(true);
    act(() => {
      useModelsToolStore.setState({ activeBuildingId: "b2" });
    });
    expect(useCompareStore.getState().active).toBe(false);
  });

  it("a compare left over from another building (switched while unmounted) is closed on mount", () => {
    useModelsToolStore.setState({ activeBuildingId: "b2" });
    useCompareStore.getState().open(null, "b1");
    expect(useCompareStore.getState().active).toBe(true);
    renderApp();
    expect(useCompareStore.getState().active).toBe(false);
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

  it("a PDF open is reported to the shell and no × close control is rendered", () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v-first" }] };
    renderApp();
    expect(useDocumentsViewState.getState().pdfOpen).toBe(true);
    expect(screen.queryByTestId("mock-pdf-close")).toBeNull();
    expect(screen.queryByTestId("pdf-overlay-close")).toBeNull();
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

describe("DocumentsApp drawing-data toolbar buttons", async () => {
  const { useSheetDataStore } = await import("../src/sheetData/sheetDataStore");
  const { parseSheetPayload } = await import("../src/sheetData/sheetPayload");
  const mk = (schedules: unknown[]) =>
    parseSheetPayload(JSON.stringify({
      schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A101", sheetName: "Plan", viewports: [],
      elements: [{ gid: "D1", bbox: [0, 0, 10, 10] }, { gid: "W1", bbox: [20, 0, 30, 10] }],
      elementRecords: { D1: { gid: "D1", category: "Doors", params: {} }, W1: { gid: "W1", category: "Walls", params: {} } },
      links: [], schedules,
    }));
  const schedule = { name: "Door Schedule", columns: [{ heading: "Mark" }], rows: [{ gid: "D1", cells: ["D-1"] }] };

  it("adds Properties and Elements next to Outline only when the PDF has drawing data", () => {
    useSheetDataStore.setState({ payload: null, selectedGids: [], selectedCategory: null });
    renderApp();
    expect(screen.getByTestId("documents-nav-toolbar").querySelectorAll("button")).toHaveLength(3);
    act(() => useSheetDataStore.setState({ payload: mk([]) }));
    const buttons = [...screen.getByTestId("documents-nav-toolbar").querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(buttons).toEqual(["Documents", "Outline", "Properties", "Elements", "Compare revisions"]);
    expect(screen.queryByTitle("Schedules")).toBeNull();
  });

  it("shows Schedules only when the sheet has schedules, in the same panel slot", () => {
    useSheetDataStore.setState({ payload: mk([schedule]), selectedGids: [], selectedCategory: null });
    renderApp();
    const titles = [...screen.getByTestId("documents-nav-toolbar").querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(titles).toEqual(["Documents", "Outline", "Properties", "Elements", "Schedules", "Compare revisions"]);
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-schedules"));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-panel", "schedules");
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent("Schedules");
    expect(screen.getByTestId("schedule-item")).toBeInTheDocument();
  });

  it("Elements panel selects a whole category; Properties panel summarises it", () => {
    useSheetDataStore.setState({ payload: mk([]), selectedGids: [], selectedCategory: null });
    renderApp();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-elements"));
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent("Elements");
    fireEvent.click(screen.getAllByTestId("elements-category")[0]!);
    expect(useSheetDataStore.getState().selectedGids).toHaveLength(1);
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-properties"));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-panel", "properties");
  });

  it("closes a sheet panel when the PDF has no drawing data any more", () => {
    useSheetDataStore.setState({ payload: mk([]), selectedGids: [], selectedCategory: null });
    renderApp();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-elements"));
    act(() => useSheetDataStore.setState({ payload: null }));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-open", "false");
  });
});

describe("DocumentsApp Tasks toolbar button", () => {
  const task = (id: string, num: number, page: number) => ({
    id, num, title: `Task ${num}`, status: 1, location: { pdf: { page } },
  });
  const openSheet = () => {
    useModelsToolStore.setState({ activeBuildingId: "b1" });
    h.groups = { tree: [], folderGroups: new Map(), rows: [{ latestVersionId: "v1" }] };
    renderApp();
  };

  it("sits right after Outline with a count badge, and no right-edge rail exists", () => {
    t.rows = [task("a", 10, 1), task("b", 12, 1), task("c", 90, 2)];
    openSheet();
    const titles = [...screen.getByTestId("documents-nav-toolbar").querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(titles).toEqual(["Documents", "Outline", "Tasks", "Compare revisions"]);
    // Badge counts the tasks placed on the current page (page 1: two).
    expect(screen.getByTestId("documents-nav-toolbar-tasks")).toHaveTextContent("2");
    expect(screen.queryByTestId("task-mini-panel-rail-tab")).toBeNull();
    expect(screen.queryByTestId("task-mini-panel-pill")).toBeNull();
  });

  it("is absent while no sheet is open", () => {
    renderApp();
    expect(screen.queryByTestId("documents-nav-toolbar-tasks")).toBeNull();
  });

  it("opens the task list in the shared panel slot, exclusive with the other panels", () => {
    t.rows = [task("a", 10, 1), task("c", 90, 2)];
    openSheet();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-tasks"));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-panel", "tasks");
    expect(screen.getByTestId("documents-nav-panel-title")).toHaveTextContent("Tasks");
    // "In view" = this page only.
    expect(screen.getByTestId("documents-tasks-row-a")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-tasks-row-c")).toBeNull();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Task scope" })).getByRole("radio", { name: "All" }));
    expect(screen.getByTestId("documents-tasks-row-c")).toBeInTheDocument();
    // Swapping to Outline replaces it; the tasks body unmounts.
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-outline"));
    expect(screen.getByTestId("documents-nav-toolbar-outline")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("documents-nav-toolbar-tasks")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("documents-tasks-panel-body")).toBeNull();
    // The button reopens it; tapping it again closes it (toggle).
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-tasks"));
    expect(screen.getByTestId("documents-tasks-panel-body")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-tasks"));
    expect(screen.queryByTestId("documents-tasks-panel-body")).toBeNull();
  });

  it("is mutually exclusive with Documents", () => {
    t.rows = [task("a", 10, 1)];
    openSheet();
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-tasks"));
    fireEvent.click(screen.getByTestId("documents-nav-toolbar-docs"));
    expect(screen.getByTestId("documents-nav-panel")).toHaveAttribute("data-panel", "docs");
    expect(screen.queryByTestId("documents-tasks-panel-body")).toBeNull();
  });

});
