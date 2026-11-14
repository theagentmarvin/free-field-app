import { describe, it, expect } from "vitest";

import type { OutboxRecord } from "@ff/types";

import {
  clusterProjectedPins,
  extractPins,
  mergePins,
  pendingPins,
  projectPins,
  restorePinView,
  type CalloutHandle,
  type LocatableTask,
  type PinPose,
  type TaskPin,
} from "../src/callouts";

const POSE: PinPose = { pos: [10, 10, 10], target: [1, 2, 3], fov: 45, isOrtho: false };

function task(over: Partial<LocatableTask> = {}): LocatableTask {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 1,
    location: {
      bim: {
        elements: [{ modelId: "m1", expressId: 451 }],
        worldPoint: [1, 2, 3],
        cameraPose: POSE,
      },
    },
    ...over,
  };
}

function row(state: OutboxRecord["state"], payload: Record<string, unknown>): OutboxRecord {
  return {
    id: String(payload.clientGuid ?? "g"),
    kind: "task-action",
    state,
    projectId: "p1",
    payload,
    photoRefs: [],
    attempts: 0,
    clientGuid: String(payload.clientGuid ?? "g"),
    createdAt: 5,
  };
}

function createPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verb: "create",
    taskId: "t9",
    title: "Honeycomb edge",
    statusTo: 10,
    createDoc: {
      num: 0,
      location: { bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [4, 5, 6], cameraPose: POSE } },
    },
    ...over,
  };
}

describe("extractPins", () => {
  it("keeps 3D-anchored cloud tasks and drops the rest", () => {
    const pins = extractPins([
      task(),
      task({ id: "t2", location: null }),
      task({ id: "t3", location: { bim: { elements: [], worldPoint: null, cameraPose: null } } }),
      task({ id: "t4", location: { bim: null } }),
    ]);
    expect(pins.map((p) => p.taskId)).toEqual(["t1"]);
    expect(pins[0].worldPoint).toEqual([1, 2, 3]);
    expect(pins[0].cameraPose).toEqual(POSE);
    expect(pins[0].elements).toEqual([{ modelId: "m1", expressId: 451 }]);
    expect(pins[0].pending).toBe(false);
  });
});

describe("pendingPins", () => {
  it("surfaces queued/failed creates with a 3D location, half-alpha", () => {
    const pins = pendingPins([
      row("added", createPayload({ clientGuid: "g1" })),
      row("failed", createPayload({ clientGuid: "g2", taskId: "t8" })),
      row("sending", createPayload({ clientGuid: "g3" })), // D5: suppressed
      row("sent", createPayload({ clientGuid: "g4" })),
      row("added", { verb: "comment", taskId: "t1", clientGuid: "g5" }), // not a create
    ]);
    expect(pins.map((p) => p.taskId).sort()).toEqual(["t8", "t9"]);
    expect(pins.every((p) => p.pending)).toBe(true);
  });

  it("ignores creates without a world point (2D-only pins)", () => {
    expect(
      pendingPins([row("added", createPayload({ clientGuid: "g6", createDoc: { location: { bim: null } } }))])
    ).toEqual([]);
  });
});

describe("mergePins", () => {
  it("pending shadows the cloud row for the same task; others survive", () => {
    const cloud: TaskPin[] = [
      { taskId: "t1", num: 1, title: "a", status: 20, pending: false, worldPoint: [1, 2, 3], cameraPose: null, elements: [] },
      { taskId: "t2", num: 2, title: "b", status: 20, pending: false, worldPoint: [1, 2, 3], cameraPose: null, elements: [] },
    ];
    const pend: TaskPin[] = [
      { taskId: "t1", num: 0, title: "a", status: 10, pending: true, worldPoint: [9, 9, 9], cameraPose: null, elements: [] },
    ];
    const out = mergePins(cloud, pend);
    expect(out.map((p) => `${p.taskId}:${p.pending ? "p" : "c"}`).sort()).toEqual(["t1:p", "t2:c"]);
  });
});

describe("projectPins", () => {
  it("keeps projected coords and drops nulls (behind camera / not mounted)", () => {
    const fake: CalloutHandle["worldToScreen"] = (p) => (p.x < 0 ? null : { x: p.x * 2, y: p.y * 2 });
    const pins: TaskPin[] = [
      { taskId: "a", num: 1, title: "", status: 10, pending: false, worldPoint: [1, 2, 3], cameraPose: null, elements: [] },
      { taskId: "b", num: 2, title: "", status: 10, pending: false, worldPoint: [-1, 2, 3], cameraPose: null, elements: [] },
    ];
    const out = projectPins(pins, fake);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ taskId: "a", x: 2, y: 4 });
  });
});

describe("restorePinView", () => {
  it("setViewPose first (animate), then element highlight", () => {
    const calls: string[] = [];
    const handle: CalloutHandle = {
      worldToScreen: () => null,
      setViewPose: (pose, opts) => calls.push(`pose ${pose.fov} ${String(opts?.animate)}`),
      selectElement: (m, e) => calls.push(`select ${m}:${String(e)}`),
    };
    restorePinView(handle, {
      taskId: "t1",
      num: 1,
      title: "",
      status: 10,
      pending: false,
      worldPoint: [1, 2, 3],
      cameraPose: POSE,
      elements: [{ modelId: "m1", expressId: 451 }],
    });
    expect(calls).toEqual(["pose 45 true", "select m1:451"]);
  });

  it("no cameraPose → selection only; no elements → pose only", () => {
    const calls: string[] = [];
    const handle: CalloutHandle = {
      worldToScreen: () => null,
      setViewPose: () => calls.push("pose"),
      selectElement: () => calls.push("select"),
    };
    restorePinView(handle, { ...extractPins([task()])[0], cameraPose: null });
    expect(calls).toEqual(["select"]);
    calls.length = 0;
    restorePinView(handle, { ...extractPins([task()])[0], elements: [] });
    expect(calls).toEqual(["pose"]);
  });
});

/**
 * Callout density (Wave 1A): overlapping chips are unreadable, so the
 * visible pins are bucketed on a screen grid and each bucket renders
 * ONE chip. The representative is the LOWEST T-num — a camera jitter
 * moves pixels, and the chip's identity must not swap with it.
 */
describe("clusterProjectedPins", () => {
  it("groups pins that share a grid cell", () => {
    const clusters = clusterProjectedPins([
      { key: "1:t1", x: 10, y: 10 },
      { key: "2:t2", x: 20, y: 20 },
      { key: "3:t3", x: 200, y: 200 },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].keys).toEqual(["1:t1", "2:t2"]);
    expect(clusters[1].count).toBe(1);
    expect(clusters[1].keys).toEqual(["3:t3"]);
  });

  it("buckets across cell edges — 47 and 48 land in different cells", () => {
    const clusters = clusterProjectedPins([
      { key: "1:t1", x: 47, y: 0 },
      { key: "2:t2", x: 48, y: 0 },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.count === 1)).toBe(true);
    expect(clusters.map((c) => c.bucketX)).toEqual([0, 1]);
  });

  it("negative coordinates bucket on the floor of the grid", () => {
    const clusters = clusterProjectedPins([
      { key: "1:t1", x: -1, y: -1 },
      { key: "2:t2", x: -10, y: -10 },
      { key: "3:t3", x: -50, y: -50 },
    ]);
    // floor(-1/48) = -1 and floor(-10/48) = -1 share a cell; floor(-50/48) = -2
    expect(clusters.map((c) => `${c.bucketX}:${c.bucketY}`)).toEqual(["-2:-2", "-1:-1"]);
    expect(clusters[0].count).toBe(1);
    expect(clusters[1].count).toBe(2);
  });

  it("the representative is the LOWEST T-num in the bucket", () => {
    const clusters = clusterProjectedPins([
      { key: "9:t9", x: 10, y: 10 },
      { key: "4:t4", x: 12, y: 11 },
      { key: "7:t7", x: 13, y: 9 },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].representative.key).toBe("4:t4");
    expect(clusters[0].count).toBe(3);
  });

  it("the representative is STABLE under ±1px jitter", () => {
    const base = clusterProjectedPins([
      { key: "4:t4", x: 100, y: 100 },
      { key: "9:t9", x: 101, y: 101 },
    ]);
    const jittered = clusterProjectedPins([
      { key: "4:t4", x: 99, y: 99 },
      { key: "9:t9", x: 102, y: 102 },
    ]);
    expect(base[0].representative.key).toBe("4:t4");
    expect(jittered[0].representative.key).toBe("4:t4");
    expect(jittered[0].count).toBe(2);
  });

  it("a single pin is its own cluster — the chip renders exactly as today", () => {
    const clusters = clusterProjectedPins([{ key: "1:t1", x: 123.5, y: 45.25 }]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
    expect(clusters[0].representative).toEqual({ key: "1:t1", x: 123.5, y: 45.25 });
    expect(clusters[0].x).toBe(123.5);
    expect(clusters[0].y).toBe(45.25);
  });

  it("output order is deterministic — by bucket, then representative key", () => {
    const clusters = clusterProjectedPins([
      { key: "5:t5", x: 200, y: 0 },
      { key: "2:t2", x: 100, y: 0 },
      { key: "3:t3", x: 100, y: 0 },
    ]);
    expect(clusters.map((c) => c.representative.key)).toEqual(["2:t2", "5:t5"]);
  });

  it("a custom cell size changes the bucketing", () => {
    const entries = [
      { key: "1:t1", x: 10, y: 0 },
      { key: "2:t2", x: 30, y: 0 },
    ];
    expect(clusterProjectedPins(entries, 48)).toHaveLength(1);
    expect(clusterProjectedPins(entries, 16)).toHaveLength(2);
  });

  it("an empty input yields no clusters", () => {
    expect(clusterProjectedPins([])).toEqual([]);
  });
});
