// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Seam test for the 3D callout layer (chunk 3). Everything external is
 * stubbed — auth context, Firestore, Dexie, the live queries — so what
 * is actually under test is the layer's own behavior: cloud + pending
 * pin merging, the rAF projection loop, pending half-alpha, and the
 * click → `restorePinView` path (setViewPose animate + element pick).
 */

const h = vi.hoisted(() => ({
  cloudTasks: [] as unknown[],
  liveRows: [] as unknown[],
  // the feed callback the layer subscribed with, so a test can push a
  // new task list after mount (wave 30: pins-change invalidation)
  pushTasks: null as ((tasks: unknown[]) => void) | null,
  lastMax: undefined as number | undefined,
  // IfcFile rows (model id → building) for the building-scope index
  ifcFiles: [] as { id: string; buildingId: string }[],
  indexFor: null as unknown,
  index: null as unknown,
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
  db: {
    outbox: { toArray: async () => [], where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) },
  },
}));
vi.mock("@ff/tasks", async (importOriginal) => {
  // partial: keep STATUS_COLORS + the real module, swap only the feed
  const actual = await importOriginal<typeof import("@ff/tasks")>();
  return {
    ...actual,
    watchTasks: (
      _db: unknown,
      _pid: string,
      _st: unknown,
      cb: (tasks: unknown[]) => void,
      max?: number,
    ) => {
      h.lastMax = max;
      h.pushTasks = cb;
      cb(h.cloudTasks);
      return () => {};
    },
  };
});
// Building-scope index (model → building) from the test's ifcFiles; the
// real hook reads Dexie through useLiveQuery, which is stubbed below.
vi.mock("../src/taskBuilding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/taskBuilding")>();
  return {
    ...actual,
    // stable identity per ifcFiles list, like the real live query
    useTaskBuildingIndex: () => {
      if (h.indexFor !== h.ifcFiles) {
        h.indexFor = h.ifcFiles;
        h.index = {
          modelToBuilding: new Map(h.ifcFiles.map((f) => [f.id, f.buildingId])),
          pdfToBuilding: new Map(),
        };
      }
      return h.index;
    },
  };
});
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => Promise<unknown>) => {
    void fn;
    return h.liveRows;
  },
}));

import { TaskCalloutLayer3D } from "../src/TaskCalloutLayer3D"; // after mocks
import { IDLE_REPROJECT_MS, PIN_FEED_LIMIT, type CalloutHandle } from "../src/callouts";

const POSE = { pos: [0, 0, 5], target: [1, 2, 3], fov: 45, isOrtho: false };

function cloudTask() {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 1,
    location: {
      bim: { elements: [{ modelId: "m1", expressId: 5 }], worldPoint: [1, 2, 3], cameraPose: POSE },
    },
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
      createDoc: {
        num: 0,
        location: { bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [4, 5, 6], cameraPose: POSE } },
      },
    },
  };
}

function fakeHandle(): CalloutHandle & {
  setViewPose: ReturnType<typeof vi.fn>;
  selectElement: ReturnType<typeof vi.fn>;
} {
  return {
    worldToScreen: () => ({ x: 10, y: 20 }),
    getContainer: () => null,
    setViewPose: vi.fn(),
    selectElement: vi.fn(),
  } as unknown as CalloutHandle & {
    setViewPose: ReturnType<typeof vi.fn>;
    selectElement: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  h.cloudTasks = [];
  h.liveRows = [];
});

describe("TaskCalloutLayer3D", () => {
  it("renders a cloud pin from the live-query feed and restores the pin view on click", async () => {
    h.cloudTasks = [cloudTask()];
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    const chip = await screen.findByLabelText(/Crack in slab/);
    expect(chip).toBeTruthy();

    fireEvent.click(chip);
    expect(handle.setViewPose).toHaveBeenCalledTimes(1);
    expect(handle.setViewPose.mock.calls[0][0]).toEqual(POSE);
    expect(handle.setViewPose.mock.calls[0][1]).toMatchObject({ animate: true });
    expect(handle.selectElement).toHaveBeenCalledWith("m1", 5);
  });

  it("shows queued creates as pending pins with the ⋯ marker", async () => {
    h.liveRows = [pendingCreateRow()];
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    const chip = await screen.findByLabelText(/Honeycomb edge/);
    expect(chip.textContent).toContain("⋯");
  });

  it("hides markers whose projection is null (behind camera / unmounted)", async () => {
    h.cloudTasks = [cloudTask()];
    const handle = fakeHandle();
    handle.worldToScreen = () => null;
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    await waitFor(() => expect(screen.queryAllByRole("group")).toHaveLength(0));
    expect(screen.queryByText(/Crack in slab/)).toBeNull();
  });

  it("clicking a pin with no elements still glides the camera", async () => {
    h.cloudTasks = [
      { ...cloudTask(), location: { bim: { elements: [], worldPoint: [1, 2, 3], cameraPose: POSE } } },
    ];
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    const chip = await screen.findByLabelText(/Crack in slab/);
    fireEvent.click(chip);
    expect(handle.setViewPose).toHaveBeenCalledTimes(1);
    expect(handle.selectElement).not.toHaveBeenCalled();
  });

  it("folds pins that share a screen cell into ONE '+1' chip", async () => {
    // the fake handle projects EVERY point to (10, 20) → one grid cell
    h.cloudTasks = [
      cloudTask(),
      { ...cloudTask(), id: "t2", num: 2, title: "Spalled beam" },
    ];
    const onOpenTask = vi.fn();
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} onOpenTask={onOpenTask} />);

    const chip = await screen.findByText("T001 +1");
    expect(chip).toBeTruthy();
    // the crowded pin's own title is NOT rendered any more
    expect(screen.queryByText("Spalled beam")).toBeNull();
    expect(screen.queryByText("Crack in slab")).toBeNull();

    // the cluster chip opens the REPRESENTATIVE (the lowest T-num)
    fireEvent.click(chip);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onOpenTask.mock.calls[0][0]).toMatchObject({ taskId: "t1", num: 1 });
  });

  it("a lone pin renders exactly as before — no '+0' suffix", async () => {
    h.cloudTasks = [cloudTask()];
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    await screen.findByLabelText(/Crack in slab/);
    expect(screen.queryByText(/T1 \+/)).toBeNull();
  });
});

// ─── Wave 30: idle-frame gate ──────────────────────────────────────
//
// With up to 50 pins this loop was the viewer's only app-owned
// per-frame JavaScript: every frame it allocated a Vector3 per pin,
// forced a layout read per pin, spread a new object per pin and built
// two O(pins) strings — 60× a second, even with the camera bolt still.
// It now projects only when the viewer's projection token changes
// (plus a heartbeat), and behaves exactly as before on hosts whose
// handle predates the token.

describe("TaskCalloutLayer3D wave 30 frame gate", () => {
  function pinHandle(revision?: () => number) {
    const worldToScreen = vi.fn(() => ({ x: 10, y: 20 }));
    const handle = {
      worldToScreen,
      getContainer: () => null,
      ...(revision ? { getViewportRevision: revision } : {}),
    } as unknown as CalloutHandle;
    return { handle, worldToScreen };
  }

  it("skips the projection burst while the viewport token is unchanged", async () => {
    h.cloudTasks = [cloudTask()];
    const { handle, worldToScreen } = pinHandle(() => 7);
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    await screen.findByLabelText(/Crack in slab/); // first burst happened
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const quiet = worldToScreen.mock.calls.length;
    expect(quiet).toBeGreaterThan(0);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(worldToScreen.mock.calls.length).toBe(quiet);

    let rev = 8;
    (handle as unknown as { getViewportRevision: () => number }).getViewportRevision = () => rev;
    await waitFor(() => {
      expect(worldToScreen.mock.calls.length).toBeGreaterThan(quiet);
    });
  });

  it("re-projects on a pins change even with the token frozen", async () => {
    // The token describes the VIEWPORT. A new pin is the layer's own
    // invalidation: `pins` is an effect dependency, so the burst must
    // run again instead of waiting for a camera move. Driven through
    // the outbox rows here because that is the feed this harness can
    // mutate after mount (the cloud mock fires once at subscribe).
    h.cloudTasks = [cloudTask()];
    const { handle, worldToScreen } = pinHandle(() => 7);
    const { rerender } = render(<TaskCalloutLayer3D getHandle={() => handle} />);
    await screen.findByLabelText(/Crack in slab/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    const before = worldToScreen.mock.calls.length;

    h.liveRows = [pendingCreateRow()]; // → mergePins grows to 2 pins
    rerender(<TaskCalloutLayer3D getHandle={() => handle} />);
    // A second chip appears AND the burst re-ran for both pins.
    await screen.findByLabelText(/Honeycomb edge/);
    expect(worldToScreen.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
  });

  it("re-projects on the heartbeat when the token never changes", async () => {
    // The safety net: the token covers camera and viewport only, so
    // the loop must still refresh itself periodically. Without this,
    // anything that moves a pin without moving the camera (an edit
    // under it, a layout shift) would stay stale until the user
    // orbited.
    h.cloudTasks = [cloudTask()];
    let clock = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { handle, worldToScreen } = pinHandle(() => 7);
    render(<TaskCalloutLayer3D getHandle={() => handle} />);
    await screen.findByLabelText(/Crack in slab/);

    clock = 50; // frames tick, the fake clock says "still idle"
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    const before = worldToScreen.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    clock = IDLE_REPROJECT_MS + 5_000; // a second has passed
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(worldToScreen.mock.calls.length).toBeGreaterThan(before);
    nowSpy.mockRestore();
  });

  it("keeps projecting every frame for a handle without the token", async () => {
    h.cloudTasks = [cloudTask()];
    const { handle, worldToScreen } = pinHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} />);
    await screen.findByLabelText(/Crack in slab/);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = worldToScreen.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(worldToScreen.mock.calls.length).toBeGreaterThan(before + 3);
  });
});

// ─── Perf: sub-pixel motion gate ───────────────────────────────────
// During camera motion the token changes every frame; a re-projection
// whose pins moved by ≤ 0.5 px must not commit (no React render), but a
// real move must still glue the chip to the model.
describe("TaskCalloutLayer3D sub-pixel gate", () => {
  it("ignores ≤ 0.5 px jitter and follows real moves", async () => {
    h.cloudTasks = [cloudTask()];
    let rev = 0;
    let pos = { x: 10, y: 20 };
    const handle = {
      worldToScreen: () => ({ x: pos.x, y: pos.y }),
      getContainer: () => null,
      getViewportRevision: () => ++rev, // "camera always moving"
    } as unknown as CalloutHandle;
    render(<TaskCalloutLayer3D getHandle={() => handle} />);

    const chip = await screen.findByLabelText(/Crack in slab/);
    expect(chip.style.left).toBe("10px");

    pos = { x: 10.4, y: 20.3 };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(chip.style.left).toBe("10px");
    expect(chip.style.top).toBe("20px");

    pos = { x: 42, y: 20 };
    await waitFor(() => {
      expect(chip.style.left).toBe("42px");
    });
  });

  it("scopes pins strictly to the active building (own building, else the model's) and subscribes past the 50-task list window", async () => {
    h.ifcFiles = [{ id: "m1", buildingId: "bA" }, { id: "m2", buildingId: "bB" }];
    const onModel = (modelId: string) => ({
      bim: { elements: [{ modelId, expressId: 5 }], worldPoint: [1, 2, 3], cameraPose: POSE },
    });
    h.cloudTasks = [
      { ...cloudTask(), id: "ta", title: "In A", buildingId: "bA" },
      { ...cloudTask(), id: "tb", num: 2, title: "In B", buildingId: "bB" },
      // no buildingId: placed by the model it is pinned to
      { ...cloudTask(), id: "tl", num: 3, title: "Legacy on A", location: onModel("m1") },
      { ...cloudTask(), id: "tm", num: 4, title: "Legacy on B", location: onModel("m2") },
      // no buildingId and an unknown model: belongs to no building
      { ...cloudTask(), id: "to", num: 5, title: "Orphan", location: onModel("m-gone") },
    ];
    const handle = fakeHandle();
    // spread the chips so they don't cluster
    let i = 0;
    handle.worldToScreen = () => ({ x: 100 * ++i, y: 20 });
    render(<TaskCalloutLayer3D getHandle={() => handle} buildingId="bA" />);
    expect(await screen.findByLabelText(/In A/)).toBeTruthy();
    expect(await screen.findByLabelText(/Legacy on A/)).toBeTruthy();
    expect(screen.queryByLabelText(/In B/)).toBeNull();
    expect(screen.queryByLabelText(/Legacy on B/)).toBeNull();
    expect(screen.queryByLabelText(/Orphan/)).toBeNull();
    expect(h.lastMax).toBe(PIN_FEED_LIMIT);
    expect(PIN_FEED_LIMIT).toBeGreaterThan(50);
    h.ifcFiles = [];
  });

  it("shows no pins when no building is selected", async () => {
    h.cloudTasks = [{ ...cloudTask(), id: "ta", title: "In A", buildingId: "bA" }];
    const handle = fakeHandle();
    render(<TaskCalloutLayer3D getHandle={() => handle} buildingId={null} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByLabelText(/In A/)).toBeNull();
  });
});
