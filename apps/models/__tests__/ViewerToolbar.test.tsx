// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IfcViewerHandle,
  MeasureReadout,
  MeasurementEntry,
} from "@ff/viewer-react";

// Wave 13 + Wave 50 — bottom viewer toolbar render seams. The heavy
// viewer + tasks + data barrels are stubbed; only the local
// `toolbarState` + `viewpointStore` + the real `ViewerToolbar` markup
// run. Wave 50 removed Select + Section: navigation is the default
// mode and the toolbar keeps Measure (variant menu) + Save view /
// Saved views.

const dataMocks = vi.hoisted(() => ({
  createViewerViewpoint: vi.fn(
    async (input: { projectId: string; name: string; blob: string }) =>
      ({ id: "v-created", createdAt: Date.now(), ...input }),
  ),
  deleteViewerViewpoint: vi.fn(async (_id: string) => undefined),
  listViewerViewpoints: vi.fn(async () => [] as Array<Record<string, unknown>>),
  replaceOverlay: vi.fn(),
}));

vi.mock("@ff/data", () => ({
  createViewerViewpoint: dataMocks.createViewerViewpoint,
  deleteViewerViewpoint: dataMocks.deleteViewerViewpoint,
  listViewerViewpoints: dataMocks.listViewerViewpoints,
}));

vi.mock("@ff/tasks-react", () => ({
  tokens: {
    color: {
      surface: "#ffffff",
      surface2: "#fafbfc",
      border: "#e7e9ec",
      borderStrong: "#d6dbe1",
      primary: "#181c22",
      onPrimary: "#ffffff",
      text: "#1b1f24",
      text2: "#5b626b",
      muted: "#8a919c",
      focusRingTint: "rgba(47,111,228,0.08)",
      focusRingLine: "rgba(47,111,228,0.22)",
      focusRingInk: "#2a5bb8",
      danger: "#d64545",
    },
    radius: { md: 12, pill: 999 },
    space: { s2: 8 },
    fontSize: { sm: 12, md: 13 },
    font: "system-ui, sans-serif",
    shadow: { popup: "0 -10px 30px rgba(16,24,40,0.22)" },
  },
}));

vi.mock("@ff/viewer-tools", async () => ({
  // Pure presentational bar primitives (no heavy deps): use the real ones.
  ...(await import("../../../packages/ff-viewer-tools/src/components/floatingBar")),
  useIsMobile: () => false,
  // Wave 54 — ViewerToolbar now reads the manual-visibility overlay when
  // saving a view (capture) and replaces it when restoring. The mock only
  // needs getState(); the hook form is never called here.
  useManualVisibilityStore: Object.assign(() => null, {
    getState: () => ({
      hidden: new Map(),
      isolate: null,
      replaceOverlay: dataMocks.replaceOverlay,
      showAll: () => {},
      hideIds: () => {},
      isolateTo: () => {},
      clearModel: () => {},
    }),
  }),
}));

import ViewerToolbar from "../src/ViewerToolbar";
import { useViewerToolModeStore } from "../src/viewerToolModeStore";

function makeHandle() {
  const holder: {
    cb: ((r: MeasureReadout | null) => void) | null;
  } = { cb: null };

  const container = document.createElement("div");

  const setMeasureMode = vi.fn();
  const clearMeasurements = vi.fn();
  const onMeasureReadout = vi.fn(
    (cb: ((r: MeasureReadout | null) => void) | null) => {
      holder.cb = cb;
    },
  );

  // Wave 67 — measurements list surface.
  let entries: MeasurementEntry[] = [];
  const listHolder: { cb: ((e: MeasurementEntry[]) => void) | null } = { cb: null };
  const getMeasurements = vi.fn(() => entries);
  const onMeasurementsChange = vi.fn(
    (cb: ((e: MeasurementEntry[]) => void) | null) => {
      listHolder.cb = cb;
    },
  );
  const deleteMeasurement = vi.fn();
  const focusMeasurement = vi.fn(async () => true);
  const finishMeasureCreation = vi.fn();

  // Wave 13 section surface (still consumed by restoreViewpoint).
  let sectionCount = 0;
  const addSectionPlane = vi.fn((_p: unknown, _n: unknown) => {
    sectionCount += 1;
    return true;
  });
  const clearSectionPlanes = vi.fn(() => {
    sectionCount = 0;
  });
  const getSectionPlaneCount = vi.fn(() => sectionCount);
  const getSectionPlanes = vi.fn(() => []);
  const setViewPose = vi.fn();

  // Wave 50 — two-stage Escape surface.
  let measureInProgress = false;
  const isMeasureInProgress = vi.fn(() => measureInProgress);
  const cancelMeasureCreation = vi.fn();

  // Click-to-world surface (unused after wave 50 trims section mode).
  const getPose = vi.fn(() => ({
    pos: [0, 0, 10] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    fov: 45,
    isOrtho: false,
  }));
  const getContainer = vi.fn(() => container);

  return {
    container,
    setMeasureMode,
    clearMeasurements,
    onMeasureReadout,
    addSectionPlane,
    clearSectionPlanes,
    getSectionPlaneCount,
    getSectionPlanes,
    setViewPose,
    getPose,
    getContainer,
    isMeasureInProgress,
    cancelMeasureCreation,
    getMeasurements,
    onMeasurementsChange,
    deleteMeasurement,
    focusMeasurement,
    finishMeasureCreation,
    setEntries: (next: MeasurementEntry[]) => {
      entries = next;
      listHolder.cb?.(next);
    },
    setMeasureInProgress: (v: boolean) => {
      measureInProgress = v;
    },
    getReadoutCb: () => holder.cb,
    asHandle: (): IfcViewerHandle =>
      ({
        setMeasureMode,
        clearMeasurements,
        onMeasureReadout,
        addSectionPlane,
        clearSectionPlanes,
        getSectionPlaneCount,
        getSectionPlanes,
        setViewPose,
        getPose,
        getContainer,
        isMeasureInProgress,
        cancelMeasureCreation,
        getMeasurements,
        onMeasurementsChange,
        deleteMeasurement,
        focusMeasurement,
        finishMeasureCreation,
      }) as unknown as IfcViewerHandle,
  };
}

function renderToolbar() {
  const h = makeHandle();
  const view = render(
    <ViewerToolbar getHandle={() => h.asHandle()} projectId="project-1" />,
  );
  return { h, ...view };
}

beforeEach(() => {
  useViewerToolModeStore.setState({ mode: "navigation", sectionRev: 0 });
});

describe("<ViewerToolbar>", () => {
  it("renders Measure + Save view; no Select or Section buttons", () => {
    renderToolbar();
    expect(screen.getByTestId("viewer-toolbar-measure")).toBeInTheDocument();
    expect(
      screen.getByTestId("viewer-toolbar-save-view-button"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-toolbar-select")).toBeNull();
    expect(screen.queryByTestId("viewer-toolbar-section")).toBeNull();
    expect(screen.queryByTestId("viewer-toolbar-section-menu")).toBeNull();
  });

  it("starts in navigation mode (Measure is not pressed)", () => {
    renderToolbar();
    expect(
      screen.getByTestId("viewer-toolbar-measure").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("opens the variant menu from the Measure caret and lists all four", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));

    expect(screen.getByTestId("viewer-toolbar-menu")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-variant-length")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-variant-area")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-variant-angle")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-variant-volume")).toBeInTheDocument();
  });

  it("choosing a variant arms measure mode and drives the handle", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-area"));

    expect(
      screen.getByTestId("viewer-toolbar-measure").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("viewer-toolbar-measure")).toHaveTextContent("Area");
    expect(h.setMeasureMode).toHaveBeenCalledWith("measure", "area");
    expect(screen.getByTestId("viewer-toolbar-clear")).toBeInTheDocument();
  });

  it("the clear button calls clearMeasurements once", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-clear"));
    expect(h.clearMeasurements).toHaveBeenCalledTimes(1);
  });

  it("renders the readout chip with value + unit from the readout feed", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));

    act(() => {
      h.getReadoutCb()?.({ value: 12.4, unit: "m" });
    });

    expect(screen.getByTestId("viewer-toolbar-readout")).toHaveTextContent("12.40 m");
  });

  // ── Wave 67: measurements list + finish ───────────────────────

  const sample: MeasurementEntry[] = [
    { id: "a", variant: "length", label: "Length 1", value: 5, unit: "m", text: "5.00 m" },
    { id: "b", variant: "area", label: "Area 1", value: 12.5, unit: "m2", text: "12.50 m²" },
  ];

  it("shows no list button until a measurement exists, then lists them", async () => {
    const { h } = renderToolbar();
    expect(screen.queryByTestId("viewer-toolbar-list-button")).toBeNull();
    act(() => h.setEntries(sample));
    const btn = await screen.findByTestId("viewer-toolbar-list-button");
    expect(btn).toHaveTextContent("2");
    fireEvent.click(btn);
    expect(screen.getByTestId("viewer-toolbar-list-row-a")).toHaveTextContent("Length 1");
    expect(screen.getByTestId("viewer-toolbar-list-row-b")).toHaveTextContent("12.50 m²");
  });

  it("list rows focus and delete individually; Clear all clears", async () => {
    const { h } = renderToolbar();
    act(() => h.setEntries(sample));
    fireEvent.click(await screen.findByTestId("viewer-toolbar-list-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-list-focus-b"));
    expect(h.focusMeasurement).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByTestId("viewer-toolbar-list-delete-a"));
    expect(h.deleteMeasurement).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByTestId("viewer-toolbar-list-clear"));
    expect(h.clearMeasurements).toHaveBeenCalledTimes(1);
  });

  it("measurements stay listed after the tool is disarmed", async () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));
    act(() => h.setEntries(sample));
    fireEvent.keyDown(window, { key: "Escape" }); // idle -> exit tool
    expect(h.setMeasureMode).toHaveBeenLastCalledWith("select");
    expect(await screen.findByTestId("viewer-toolbar-list-button")).toBeInTheDocument();
  });

  it("area / volume show a Done button that finishes the measurement; length does not", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));
    expect(screen.queryByTestId("viewer-toolbar-finish")).toBeNull();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-area"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-finish"));
    expect(h.finishMeasureCreation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("viewer-toolbar-hint")).toHaveTextContent(/double-click or Enter/);
  });

  // ── Wave 50: two-stage measure Escape ─────────────────────────

  it("Escape while measuring in-progress cancels the line and stays armed", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));
    expect(h.setMeasureMode).toHaveBeenLastCalledWith("measure", "length");

    h.setMeasureInProgress(true);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(h.cancelMeasureCreation).toHaveBeenCalledTimes(1);
    // Tool stays armed — no exit to navigation.
    expect(h.setMeasureMode).toHaveBeenLastCalledWith("measure", "length");
    expect(
      screen.getByTestId("viewer-toolbar-measure").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("Escape while idle exits the tool to navigation", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-volume"));
    expect(h.setMeasureMode).toHaveBeenLastCalledWith("measure", "volume");

    // idle (in-progress stays false)
    fireEvent.keyDown(window, { key: "Escape" });

    expect(h.cancelMeasureCreation).not.toHaveBeenCalled();
    expect(h.setMeasureMode).toHaveBeenLastCalledWith("select");
    expect(
      screen.getByTestId("viewer-toolbar-measure").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(useViewerToolModeStore.getState().mode).toBe("navigation");
  });

  it("Escape with a menu open dismisses the menu and does not touch the tool", () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    expect(screen.getByTestId("viewer-toolbar-menu")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("viewer-toolbar-menu")).toBeNull();
    // Only the initial mount mirrored "select" — no re-arm, no cancel, no exit.
    expect(h.cancelMeasureCreation).not.toHaveBeenCalled();
    const selectCalls = h.setMeasureMode.mock.calls.filter(
      (c: unknown[]) => c[0] === "select",
    );
    expect(selectCalls.length).toBe(1); // just the initial mount mirror
  });

  // ── Wave 50: tool-mode publish never emits "section" ──────────

  it("publishes measure/navigation only — never section", () => {
    const { h } = renderToolbar();
    expect(useViewerToolModeStore.getState().mode).toBe("navigation");

    fireEvent.click(screen.getByTestId("viewer-toolbar-measure"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-variant-length"));
    expect(useViewerToolModeStore.getState().mode).toBe("measure");

    h.setMeasureInProgress(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useViewerToolModeStore.getState().mode).toBe("navigation");
    expect(useViewerToolModeStore.getState().mode).not.toBe("section");
  });

  // ── Wave 13 (kept): save view / saved views seams ────────────

  it("opens the save-view menu with Save view… / Saved views ▸", () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));

    expect(
      screen.getByTestId("viewer-toolbar-save-view-menu"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-save-view")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-toolbar-saved-views")).toBeInTheDocument();
  });

  it("restoring a saved view drives the handle (pose + planes)", async () => {
    dataMocks.listViewerViewpoints.mockResolvedValueOnce([
      {
        id: "vp-1",
        projectId: "project-1",
        name: "Front cut",
        createdAt: 1,
        blob: JSON.stringify({
          pose: {
            pos: [0, 0, 9],
            target: [0, 0, 0],
            fov: 45,
            isOrtho: false,
          },
          sectionPlanes: [{ point: { x: 1, y: 1, z: 1 }, normal: { x: 0, y: 0, z: -1 } }],
        }),
      },
    ]);

    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-saved-views"));

    await waitFor(() => {
      expect(screen.getByTestId("viewer-toolbar-restore-vp-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("viewer-toolbar-restore-vp-1"));

    expect(h.setViewPose).toHaveBeenCalled();
    expect(h.clearSectionPlanes).toHaveBeenCalled();
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 0, z: -1 },
    );
  });

  it("Save view… persists the current snapshot under the typed name", async () => {
    const { h } = renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view"));

    fireEvent.change(screen.getByTestId("viewer-toolbar-save-input"), {
      target: { value: "My view" },
    });
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-confirm"));

    await waitFor(() => {
      expect(dataMocks.createViewerViewpoint).toHaveBeenCalled();
    });
    const input = dataMocks.createViewerViewpoint.mock.calls[0][0];
    expect(input.projectId).toBe("project-1");
    expect(input.name).toBe("My view");
    expect(JSON.parse(input.blob as string)).toHaveProperty("pose");
    expect(h.getPose).toHaveBeenCalled();
  });

  it("restoring a clean saved view (visibility: null) clears the overlay (wave 63)", async () => {
    dataMocks.replaceOverlay.mockClear();
    dataMocks.listViewerViewpoints.mockResolvedValueOnce([
      {
        id: "vp-clean",
        projectId: "project-1",
        name: "Clean",
        createdAt: 1,
        blob: JSON.stringify({ pose: null, sectionPlanes: [], visibility: null }),
      },
    ]);
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-saved-views"));
    await waitFor(() => {
      expect(screen.getByTestId("viewer-toolbar-restore-vp-clean")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("viewer-toolbar-restore-vp-clean"));
    expect(dataMocks.replaceOverlay).toHaveBeenCalledWith(null);
  });

  it("a rejected delete shows a notice instead of an unhandled rejection (wave 63)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dataMocks.listViewerViewpoints.mockResolvedValueOnce([
      { id: "vp-d", projectId: "project-1", name: "D", createdAt: 1, blob: "{}" },
    ]);
    dataMocks.deleteViewerViewpoint.mockRejectedValueOnce(new Error("boom"));
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-saved-views"));
    await waitFor(() => {
      expect(screen.getByTestId("viewer-toolbar-delete-vp-d")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("viewer-toolbar-delete-vp-d"));
    await waitFor(() => {
      expect(screen.getByTestId("viewer-toolbar-notice")).toHaveTextContent("Delete failed");
    });
    warn.mockRestore();
  });

  it("warns before a save evicts the oldest view at the 12-view cap (wave 63)", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `vp-${i}`,
      projectId: "project-1",
      name: `View ${i}`,
      createdAt: i,
      blob: "{}",
    }));
    dataMocks.listViewerViewpoints.mockResolvedValueOnce(rows);
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view"));
    await waitFor(() => {
      expect(screen.getByTestId("viewer-toolbar-save-cap-warning")).toHaveTextContent(
        "View 0",
      );
    });
  });

  it("no cap warning below 12 views", async () => {
    dataMocks.listViewerViewpoints.mockResolvedValueOnce([]);
    renderToolbar();
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view-button"));
    fireEvent.click(screen.getByTestId("viewer-toolbar-save-view"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("viewer-toolbar-save-cap-warning")).toBeNull();
  });
});
