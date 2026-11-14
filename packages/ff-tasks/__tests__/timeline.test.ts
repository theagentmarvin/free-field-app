import { describe, expect, it } from "vitest";

import type { TaskEntry } from "@ff/firestore";
import type { OutboxRecord } from "@ff/types";

import { displayStatus, mergeTaskEntries, outboxSheetRows } from "../src/timeline";
import type { TaskStatus } from "../src/status";

/**
 * Chunk 5 — timeline assembly (plan §7 screen 3). The cloud
 * subcollection is the truth feed; queued `added`/`failed` rows
 * overlay as pending entries — sending/sent never do (D5: they are
 * already optimistic in Firestore's local cache), and a row whose
 * clientGuid matches a committed entry id is dropped exactly (entry
 * doc id == clientGuid is the idempotency key).
 */

function entry(over: Partial<TaskEntry> & { id: string; clientGuid: string }): TaskEntry {
  return {
    action: "comment",
    text: "",
    by: "Sam",
    byUid: "u1",
    at: 0,
    statusFrom: 20,
    statusTo: 20,
    photos: [],
    ...over,
  } as TaskEntry;
}

function actionPayload(over: Record<string, unknown>): Record<string, unknown> {
  return {
    verb: "comment",
    projectId: "p1",
    taskId: "t1",
    clientGuid: "g1",
    actor: { uid: "u1", name: "Sam" },
    at: 1,
    title: "Set door frame",
    statusFrom: 20,
    statusTo: 20,
    text: "queued note",
    photoRefs: [],
    ...over,
  };
}

function row(state: OutboxRecord["state"], payload: Record<string, unknown>, createdAt = 0): OutboxRecord {
  return {
    id: String(payload.clientGuid ?? "g"),
    kind: "task-action",
    state,
    projectId: "p1",
    payload,
    photoRefs: [],
    attempts: 0,
    clientGuid: String(payload.clientGuid ?? "g"),
    createdAt,
  };
}

describe("mergeTaskEntries", () => {
  it("overlays added/failed rows for the task, sorted, flagged; never sending/sent/other-task", () => {
    const cloud = [
      entry({ id: "c1", clientGuid: "c1", at: 10, text: "first" }),
      entry({ id: "c2", clientGuid: "c2", at: 30, text: "second" }),
    ];
    const rows = [
      row("added", actionPayload({ clientGuid: "gA", at: 20 })),
      row("sending", actionPayload({ clientGuid: "gB", at: 25 })), // D5: suppressed
      row("failed", actionPayload({ clientGuid: "gC", at: 5 })),
      row("sent", actionPayload({ clientGuid: "gD", at: 12 })),
      row("added", actionPayload({ clientGuid: "gE", taskId: "other", at: 15 })),
    ];
    const merged = mergeTaskEntries(cloud, rows, "t1");
    // order by at: gC(5), c1(10), gA(20), c2(30)
    expect(merged.map((e) => e.id)).toEqual(["gC", "c1", "gA", "c2"]);
    const failed = merged.find((e) => e.id === "gC")!;
    expect(failed).toMatchObject({ pending: true, failed: true, text: "queued note" });
    const queued = merged.find((e) => e.id === "gA")!;
    expect(queued).toMatchObject({ pending: true, failed: false });
    expect(merged.find((e) => e.id === "c1")!.pending).toBe(false);
    expect(merged.some((e) => e.id === "gB" || e.id === "gD" || e.id === "gE")).toBe(false);
  });

  it("drops a pending row whose clientGuid already committed (exact idempotency dedupe)", () => {
    const cloud = [entry({ id: "gX", clientGuid: "gX", at: 10 })];
    const rows = [row("added", actionPayload({ clientGuid: "gX", at: 10 }))];
    const merged = mergeTaskEntries(cloud, rows, "t1");
    expect(merged).toHaveLength(1);
    expect(merged[0].pending).toBe(false);
  });
});

describe("outboxSheetRows", () => {
  it("keeps added/sending/failed sorted by enqueue time, drops sent/killed", () => {
    const rows = [
      row("sent", actionPayload({ clientGuid: "s1" }), 1),
      row("added", actionPayload({ clientGuid: "a1" }), 3),
      row("killed", actionPayload({ clientGuid: "k1" }), 0),
      row("failed", actionPayload({ clientGuid: "f1" }), 2),
      row("sending", actionPayload({ clientGuid: "n1" }), 4),
    ];
    expect(outboxSheetRows(rows).map((r) => r.id)).toEqual(["f1", "a1", "n1"]);
  });
});

describe("displayStatus", () => {
  const v = (at: number, statusTo: TaskStatus | null, pending = true) =>
    ({ ...entry({ id: `x${at}`, clientGuid: `x${at}`, at, statusTo, text: "" }), pending, failed: false });

  it("falls back to the committed status with no pending entries", () => {
    expect(displayStatus(20, [])).toBe(20);
  });

  it("the newest pending statusTo wins", () => {
    expect(displayStatus(20, [v(10, 40), v(20, 65)])).toBe(65);
  });

  it("pending entries without a target status don't shadow older ones", () => {
    expect(displayStatus(20, [v(20, 40), v(30, null)])).toBe(40);
  });

  it("null committed stays null when nothing is queued", () => {
    expect(displayStatus(null, [])).toBeNull();
  });
});
