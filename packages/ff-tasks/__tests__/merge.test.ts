import { describe, it, expect } from "vitest";

import { mergeTaskViews, type TaskView } from "../src/merge";
import { composePhotoPath } from "../src/photos";
import type { OutboxRecord } from "@ff/types";
import type { TaskActionPayload } from "../src/action";

/**
 * D5 (task-39), revised wave 63: transactions are NOT applied to the
 * local cache before the server acks them, so `sending` rows overlay
 * like `added`/`failed` — except once the cloud doc already carries
 * the action (landed, row not yet flipped to `sent`).
 */

function cloudTask(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 100,
    assigneeName: "Ana",
    lastAction: "assign",
    entryCount: 2,
    ...over,
  };
}

function row(state: OutboxRecord["state"], payload: Partial<TaskActionPayload> = {}, over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: `g-${state}-${over.createdAt ?? 0}`,
    kind: "task-action",
    state,
    projectId: "p1",
    payload: {
      verb: "approve",
      projectId: "p1",
      taskId: "t1",
      clientGuid: "g1",
      actor: { uid: "u1", name: "Bob" },
      at: 300,
      title: "Crack in slab",
      statusFrom: 40,
      statusTo: 65,
      text: "",
      photoRefs: [],
      ...payload,
    } as unknown as Record<string, unknown>,
    photoRefs: [],
    attempts: state === "failed" ? 3 : 0,
    clientGuid: "g1",
    createdAt: 300,
    ...over,
  };
}

describe("mergeTaskViews (D5 optimistic overlay)", () => {
  it("a sending row whose action already landed in the cloud doc is not applied twice", () => {
    const cloud = [cloudTask({ status: 65, lastAction: "approve", updatedAt: 300, entryCount: 3 })];
    const out = mergeTaskViews(cloud, [row("sending")]);
    expect(out).toHaveLength(1);
    expect(out[0].pending).toBeUndefined();
    expect(out[0].status).toBe(65); // cloud (optimistic) state wins untouched
  });

  it("wave 63: an in-flight (or backing-off) sending row overlays on the cloud path", () => {
    const cloud = [cloudTask()]; // updatedAt 100 < action at 300
    const out = mergeTaskViews(cloud, [row("sending")]);
    expect(out[0].pending).toBe(true);
    expect(out[0].status).toBe(65);
    expect(out[0].entryCount).toBe(3);
    // a queued create in `sending` shows up before the server acks it
    const create = row("sending", { verb: "create", taskId: "t9", statusFrom: null, statusTo: 10, createDoc: {} });
    const out2 = mergeTaskViews([], [create]);
    expect(out2.map((t) => t.id)).toEqual(["t9"]);
    // and never duplicates a doc that exists
    expect(mergeTaskViews([cloudTask({ id: "t9" })], [create])).toHaveLength(1);
  });

  it("added rows overlay as pending; failed rows carry the ⚠ flag", () => {
    const cloud = [cloudTask()];
    const out = mergeTaskViews(cloud, [row("added"), row("failed")]);
    expect(out[0].pending).toBe(true);
    expect(out[0].failed).toBeDefined();
    expect(out[0].status).toBe(65); // optimistic preview of the approve
    expect(out[0].entryCount).toBe(4); // +1 per queued row (both overlay t1)
  });

  it("queued create synthesizes a pending row from the payload", () => {
    const createRow = row("added", {
      verb: "create",
      statusFrom: null,
      statusTo: 10,
      title: "New observation",
      createDoc: { assigneeName: "Ana" },
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    expect(out[0].id).toBe("t1");
    const synth = out.find((t) => t.title === "New observation");
    expect(synth?.pending).toBe(true);
    expect(synth?.status).toBe(10);
    expect(synth?.assigneeName).toBe("Ana");
  });

  it("sent / killed rows never appear in the overlay", () => {
    const out = mergeTaskViews([cloudTask()], [row("sent"), row("killed")]);
    expect(out).toHaveLength(1);
    expect(out[0].pending).toBeUndefined();
  });

  it("result rows sort newest-first", () => {
    const out = mergeTaskViews(
      [cloudTask(), cloudTask({ id: "a", updatedAt: 100 }), cloudTask({ id: "b", updatedAt: 200 })],
      [row("added", {}, { id: "g-x", createdAt: 500 })]
    );
    expect(out.map((t) => t.id)).toEqual(["t1", "b", "a"]); // t1 bumped to 300 by the queued approve
  });
});

/**
 * VDC 2026-11-02 · list-row photo thumb (Wave 1A): the cloud task doc
 * carries `photos[]` (ff-firestore schema) — the list renders a 24px
 * thumb from the FIRST entry's Storage path. Queued rows pass through
 * only what the local outbox already knows.
 */
describe("mergeTaskViews — photo passthrough", () => {
  /** The cloud doc carries the FULL ff-firestore `TaskPhoto` shape; the
   *  view only needs the path, so the extra fields are tolerated. */
  function cloudPhoto(storagePath: string): { storagePath: string } {
    return {
      storagePath,
      sha256: "a".repeat(64),
      size: 3,
      mime: "image/jpeg",
    } as unknown as { storagePath: string };
  }

  it("cloud photos ride through as { storagePath } entries", () => {
    const cloud = cloudTask({
      photos: [
        cloudPhoto("projects/p1/tasks/t1/a-0.jpg"),
        cloudPhoto("projects/p1/tasks/t1/b-1.jpg"),
      ],
    });
    const out = mergeTaskViews([cloud], []);
    expect(out[0].photos).toEqual([
      { storagePath: "projects/p1/tasks/t1/a-0.jpg" },
      { storagePath: "projects/p1/tasks/t1/b-1.jpg" },
    ]);
  });

  it("a cloud task without photos has NO photos key (no thumb)", () => {
    const out = mergeTaskViews([cloudTask()], []);
    expect(out[0].photos).toBeUndefined();
  });

  it("a cloud task with an empty photo array has NO photos key", () => {
    const out = mergeTaskViews([cloudTask({ photos: [] })], []);
    expect(out[0].photos).toBeUndefined();
  });

  it("a queued create passes through the doc-shaped createDoc.photos", () => {
    const createRow = row("added", {
      verb: "create",
      taskId: "t-new",
      statusFrom: null,
      statusTo: 10,
      title: "New observation",
      createDoc: {
        photos: [cloudPhoto("projects/p1/tasks/t-new/x-0.jpg")],
      },
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    const synth = out.find((t) => t.id === "t-new");
    expect(synth?.photos).toEqual([{ storagePath: "projects/p1/tasks/t-new/x-0.jpg" }]);
  });

  it("a queued create without createDoc.photos derives the sha-named path from its refs", () => {
    const sha = "d".repeat(64);
    const createRow = row("added", {
      verb: "create",
      taskId: "t-new",
      statusFrom: null,
      statusTo: 10,
      title: "Queued with photo",
      photoRefs: [{ blobKey: "b1", sha256: sha, size: 12, mime: "image/jpeg" }],
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    const synth = out.find((t) => t.id === "t-new");
    expect(synth?.photos).toEqual([
      { storagePath: composePhotoPath("p1", "t-new", 0, sha, "image/jpeg") },
    ]);
    expect(synth?.photos?.[0].storagePath).toContain("projects/p1/tasks/t-new/");
  });

  it("a queued row with no photo info carries no photos (absence reads as 'no thumb')", () => {
    const createRow = row("added", {
      verb: "create",
      taskId: "t-new",
      statusFrom: null,
      statusTo: 10,
      title: "No photos",
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    const synth = out.find((t) => t.id === "t-new");
    expect(synth?.photos).toBeUndefined();
  });
});

describe("mergeTaskViews — buildingId passthrough (UI-refresh v1)", () => {
  it("a cloud doc's buildingId rides through the merge", () => {
    const out = mergeTaskViews([cloudTask({ buildingId: "b-9" })], []);
    expect(out[0].buildingId).toBe("b-9");
  });

  it("a queued create synthesizes its buildingId from the createDoc", () => {
    const createRow = row("added", {
      verb: "create",
      taskId: "t-new",
      statusFrom: null,
      statusTo: 10,
      title: "Scoped create",
      createDoc: { buildingId: "b-7", deadline: null },
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    expect(out.find((t) => t.id === "t-new")?.buildingId).toBe("b-7");
  });

  it("legacy rows without the field merge as undefined/null (never dropped)", () => {
    const createRow = row("added", {
      verb: "create",
      taskId: "t-old",
      statusFrom: null,
      statusTo: 10,
      title: "Legacy create",
      createDoc: {},
    });
    const out = mergeTaskViews([cloudTask()], [createRow]);
    expect(out.find((t) => t.id === "t-old")).toBeDefined();
    expect(out.find((t) => t.id === "t-old")?.buildingId).toBeNull();
  });
});
