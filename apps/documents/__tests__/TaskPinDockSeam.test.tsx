// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";

/**
 * Wave 9 seam test — the Documents host mounts <TaskMiniPanel> alongside
 * the existing 2D marker (TaskCalloutLayer2D) and threads the CURRENT
 * PDF page into the panel's scope anchor. @ff/tasks-react is stubbed so
 * the seam is what's under test, not the panel's internals (which the
 * package's own TaskMiniPanel.test.tsx covers).
 */

const panelProps = vi.hoisted(() => ({
  pdfPage: undefined as number | null | undefined,
}));

vi.mock("@ff/tasks-react", async () => {
  const React = await import("react");
  const Marker2D = () => React.createElement("div", { "data-testid": "seam-marker-2d" });
  const Nullish = () => null;
  return {
    TapCreateMarker2D: Nullish,
    TaskCalloutLayer2D: Marker2D,
    TaskComposeSheet: Nullish,
    TaskDetailHost: Nullish,
    TaskMiniPanel: (props: { pdfPage?: number | null; variant?: string }) => {
      panelProps.pdfPage = props.pdfPage;
      return React.createElement("div", {
        "data-testid": "seam-panel",
        "data-page": props.pdfPage ?? "",
      });
    },
    usePanelTasks: () => [],
    usePanelActorUid: () => "admin",
    useTaskEngine: () => null,
    useTaskPeople: () => ({ actor: { uid: "admin", name: "Admin" }, members: [], ensureMembers: async () => {} }),
    useTaskPhotoResolver: () => undefined,
    useTasksFirestore: () => null,
    draftTable: {},
    latestCalibration: (rows: unknown[]) => rows[0] ?? null,
    locationFromPdfClick: () => null,
    attachSnapshotThumb: (_d: unknown, _p: unknown, _t: unknown, loc: unknown) => ({ location: loc, thumb: null }),
  };
});

// The `db` import inside TaskPinDock resolves against fake-indexeddb
// (documents setup already installs it); nothing here triggers a query.
import { act } from "@testing-library/react";
import {
  PAGE_ONE_HINT,
  TaskPinDock,
  calibrationsForProject,
  type PinVersionMeta,
  type TaskPinDockHandle,
} from "../src/TaskPinDock";

function fakeSurface(page = 4) {
  return {
    getAnnotationLayer: () => null,
    getTotalScale: () => 1,
    getCurrentPage: () => page,
    goToPage: vi.fn(),
    onReady: () => {},
    setOnScaleChange: () => () => {},
  };
}

describe("TaskPinDock — panel seam (2D)", () => {
  const version: PinVersionMeta = { pdfFileId: "f1", width: 612, height: 792 };
  const ref = createRef<TaskPinDockHandle>();

  it("mounts the panel alongside the marker and forwards the current page", async () => {
    render(<TaskPinDock ref={ref} version={version} getSurface={fakeSurface} />);

    expect(screen.getByTestId("seam-marker-2d")).toBeInTheDocument();
    expect(screen.getByTestId("seam-panel")).toBeInTheDocument();

    // The panel's page anchor resolves from getSurface().getCurrentPage()
    // via the 250 ms tick; wait for the tick to settle.
    await vi.waitFor(() => expect(panelProps.pdfPage).toBe(4));
    expect(screen.getByTestId("seam-panel").getAttribute("data-page")).toBe("4");
  });
});

describe("calibration lookup (wave 66)", () => {
  it("returns only the current project's calibrations", () => {
    const rows = [
      { id: "a", projectId: "default-project" },
      { id: "b", projectId: "p-real" },
    ];
    expect(calibrationsForProject(rows, "p-real").map((r) => r.id)).toEqual(["b"]);
    expect(calibrationsForProject([{ id: "a", projectId: "default-project" }], "p-real")).toEqual([]);
  });
});

describe("multi-page PDFs (wave 64)", () => {
  const version: PinVersionMeta = { pdfFileId: "f1", width: 612, height: 792 };

  it("refuses to create a pin on a page other than the calibrated page 1", async () => {
    const ref = createRef<TaskPinDockHandle>();
    render(<TaskPinDock ref={ref} version={version} getSurface={() => fakeSurface(2)} />);
    await act(async () => {
      await ref.current!.handleTap({ x: 10, y: 10 });
    });
    expect(screen.getByTestId("task-pin-hint")).toHaveTextContent(PAGE_ONE_HINT);
  });

  it("still resolves the calibration on page 1", async () => {
    const ref = createRef<TaskPinDockHandle>();
    render(<TaskPinDock ref={ref} version={version} getSurface={() => fakeSurface(1)} />);
    await act(async () => {
      await ref.current!.handleTap({ x: 10, y: 10 });
    });
    // No calibration rows in the empty test DB → the calibration hint,
    // NOT the page-1 hint.
    expect(screen.getByTestId("task-pin-hint")).not.toHaveTextContent(PAGE_ONE_HINT);
    expect(screen.getByTestId("task-pin-hint")).toHaveTextContent(/Calibrate this plan first/);
  });
});

describe("no project (wave 66)", () => {
  const version: PinVersionMeta = { pdfFileId: "f1", width: 612, height: 792 };

  it("a tap reads and writes nothing: no hint, no marker", async () => {
    (globalThis as { __ffNoProject?: boolean }).__ffNoProject = true;
    try {
      const ref = createRef<TaskPinDockHandle>();
      render(<TaskPinDock ref={ref} version={version} getSurface={() => fakeSurface(1)} />);
      await act(async () => {
        await ref.current!.handleTap({ x: 10, y: 10 });
      });
      expect(screen.queryByTestId("task-pin-hint")).toBeNull();
    } finally {
      (globalThis as { __ffNoProject?: boolean }).__ffNoProject = false;
    }
  });
});
