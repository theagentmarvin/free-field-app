// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Seam test for the 2D plan-pin layer (chunk 4). External feeds are
 * stubbed exactly like the 3D layer's test; what's under test here is
 * the layer's own surface protocol: annotation-layer resolution
 * (the portal node), the onReady first-paint gate, page filtering via
 * getCurrentPage (the tick doubles as the page-change signal), the
 * uv × pageSize × renderScale placement (scale derived from the
 * layer's own CSS width, Task 15b parity), and pending suppression.
 */

const h = vi.hoisted(() => ({
  cloudTasks: [] as unknown[],
  liveRows: [] as unknown[],
}));

vi.mock("@ff/auth", () => ({
  useAuthContext: () => ({ app: {}, isDemo: false }),
  useProjectId: () => "p1",
}));
vi.mock("firebase/firestore", async (importOriginal) => ({
  // passthrough: the layer's @ff/tasks import (partially mocked below)
  // pulls real repository helpers that bind setDoc/updateDoc/etc.
  ...(await importOriginal<typeof import("firebase/firestore")>()),
  getFirestore: () => ({}),
}));
vi.mock("@ff/data/db/database", () => ({
  db: { outbox: { toArray: async () => [], where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) } },
}));
vi.mock("@ff/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/tasks")>();
  return {
    ...actual,
    watchTasks: (
      _db: unknown,
      _pid: string,
      _st: unknown,
      cb: (tasks: unknown[]) => void,
    ) => {
      cb(h.cloudTasks);
      return () => {};
    },
  };
});
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => Promise<unknown>) => {
    void fn;
    return h.liveRows;
  },
}));

import { TaskCalloutLayer2D } from "../src/TaskCalloutLayer2D"; // after mocks
import type { PdfPinSurface } from "../src/pdfPins";

const PDF = { pdfFileId: "f1", page: 3, uv: [0.5, 0.25] as [number, number], calibId: "c1" };

function cloudTask(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    num: 1,
    title: "Set door frame",
    status: 20,
    updatedAt: 1,
    location: { pdf: PDF },
    ...over,
  };
}

function pendingCreateRow() {
  return {
    id: "g1",
    kind: "task-action",
    state: "added",
    projectId: "p1",
    clientGuid: "g1",
    createdAt: 5,
    attempts: 0,
    photoRefs: [],
    payload: {
      verb: "create",
      taskId: "t9",
      title: "Honeycomb edge",
      statusTo: 10,
      clientGuid: "g1",
      createDoc: { num: 0, location: { pdf: { pdfFileId: "f1", page: 3, uv: [0.3, 0.4], calibId: "c7" } } },
    },
  };
}

interface Fake {
  surface: PdfPinSurface;
  fireReady: () => void;
  fireScale: (renderScale: number) => void;
  setPage: (n: number) => void;
}

function fakeSurface(widthPx = 800): Fake {
  const layer = document.createElement("div");
  layer.style.width = `${widthPx}px`;
  layer.style.height = "600px";
  document.body.appendChild(layer);

  let page = 3;
  let readyCb: (() => void) | null = null;
  let scaleCb: ((e: { renderScale: number }) => void) | null = null;

  const surface: PdfPinSurface = {
    getAnnotationLayer: () => layer,
    getTotalScale: () => 1,
    getCurrentPage: () => page,
    goToPage: (n: number) => {
      page = n;
    },
    onReady: (cb: () => void) => {
      readyCb = cb;
    },
    setOnScaleChange: (cb: (e: { renderScale: number }) => void) => {
      scaleCb = cb;
      return () => {
        scaleCb = null;
      };
    },
  };

  return {
    surface,
    fireReady: () => readyCb?.(),
    fireScale: (renderScale: number) => scaleCb?.({ renderScale }),
    setPage: (n: number) => {
      page = n;
    },
  };
}

beforeEach(() => {
  h.cloudTasks = [];
  h.liveRows = [];
  document.body.innerHTML = "";
});

describe("TaskCalloutLayer2D", () => {
  it("gates first paint on onReady: no markers before the viewer settles", async () => {
    h.cloudTasks = [cloudTask()];
    const fx = fakeSurface();
    render(<TaskCalloutLayer2D getSurface={() => fx.surface} pdfFileId="f1" pageSize={{ width: 800, height: 600 }} />);

    // effect runs synchronously on mount (first tick attaches)
    await waitFor(() => expect(fx.surface.getAnnotationLayer()).toBeTruthy());
    expect(screen.queryByLabelText(/Set door frame/)).toBeNull();

    fx.fireReady();
    const chip = await screen.findByLabelText(/Set door frame/);
    expect(chip).toBeTruthy();
  });

  it("places markers at uv × pageSize × renderScale (scale derived from the layer width)", async () => {
    h.cloudTasks = [cloudTask()];
    // layer CSS width 1600px over an 800pt page => renderScale 2
    const fx = fakeSurface(1600);
    render(<TaskCalloutLayer2D getSurface={() => fx.surface} pdfFileId="f1" pageSize={{ width: 800, height: 600 }} />);
    fx.fireReady();

    const chip = await screen.findByLabelText(/Set door frame/);
    expect(chip.style.left).toBe("800px");
    expect(chip.style.top).toBe("300px");
  });

  it("shows only the pins on the page the viewer reports", async () => {
    h.cloudTasks = [cloudTask()]; // pin is on page 3
    const fx = fakeSurface();
    fx.setPage(2);
    render(<TaskCalloutLayer2D getSurface={() => fx.surface} pdfFileId="f1" pageSize={{ width: 800, height: 600 }} />);
    fx.fireReady();
    await waitFor(() => expect(fx.surface.getCurrentPage()).toBe(2));
    expect(screen.queryByLabelText(/Set door frame/)).toBeNull();

    // page turns have no dedicated event — the scale signal re-reads it
    fx.setPage(3);
    fx.fireScale(1);
    expect(await screen.findByLabelText(/Set door frame/)).toBeTruthy();
  });

  it("filters to the active pdfFileId and flags queued creates as pending", async () => {
    h.cloudTasks = [cloudTask(), cloudTask({ id: "t2", title: "Other file", location: { pdf: { ...PDF, pdfFileId: "zz" } } })];
    h.liveRows = [pendingCreateRow()];
    const fx = fakeSurface();
    render(<TaskCalloutLayer2D getSurface={() => fx.surface} pdfFileId="f1" pageSize={{ width: 800, height: 600 }} />);
    fx.fireReady();

    const pendingChip = await screen.findByLabelText(/Honeycomb edge/);
    expect(pendingChip.textContent).toContain("⋯");
    expect(await screen.findByLabelText(/Set door frame/)).toBeTruthy();
    expect(screen.queryByLabelText(/Other file/)).toBeNull();
  });

  it("clicking a pin hands it to onOpenTask", async () => {
    h.cloudTasks = [cloudTask()];
    const fx = fakeSurface();
    const onOpenTask = vi.fn();
    render(
      <TaskCalloutLayer2D
        getSurface={() => fx.surface}
        pdfFileId="f1"
        pageSize={{ width: 800, height: 600 }}
        onOpenTask={onOpenTask}
      />,
    );
    fx.fireReady();

    fireEvent.click(await screen.findByLabelText(/Set door frame/));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0][0]).toMatchObject({ taskId: "t1", uv: [0.5, 0.25], calibId: "c1", page: 3 });
  });

  it("waits for the viewer: a surface whose annotation layer is still null never registers onReady", async () => {
    h.cloudTasks = [cloudTask()];
    let readyCalls = 0;
    const empty: PdfPinSurface = {
      getAnnotationLayer: () => null,
      getTotalScale: () => 1,
      getCurrentPage: () => 1,
      goToPage: () => {},
      onReady: (cb: () => void) => {
        readyCalls += 1;
        void cb;
      },
      setOnScaleChange: () => () => {},
    };
    render(<TaskCalloutLayer2D getSurface={() => empty} pdfFileId="f1" pageSize={{ width: 800, height: 600 }} />);
    await waitFor(() => expect(readyCalls).toBe(0)); // never attached — PdfOverlay.onReady would drop the cb
    expect(screen.queryByLabelText(/Set door frame/)).toBeNull();
  });
});
