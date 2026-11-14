import { describe, it, expect } from "vitest";

import { buildActionPayload, IllegalTransitionError, type ActionRequest } from "../src/action";

const actor = { uid: "u1", name: "Ana" };

function req(over: Partial<ActionRequest>): ActionRequest {
  return {
    verb: "comment",
    projectId: "p1",
    taskId: "t1",
    statusFrom: 20,
    actor,
    title: "Crack in slab",
    guid: "g-fixed",
    at: 1234,
    ...over,
  };
}

describe("buildActionPayload (task-39 deliverable 4)", () => {
  it("derives the target status from the verb", () => {
    const p = buildActionPayload(req({ verb: "assign", statusFrom: 10 }));
    expect(p.statusTo).toBe(20);
    expect(p.statusFrom).toBe(10);
    expect(p.verb).toBe("assign");
  });

  it("throws IllegalTransitionError on illegal verbs — no status edit escape", () => {
    expect(() => buildActionPayload(req({ verb: "reject", statusFrom: 20 }))).toThrow(IllegalTransitionError);
    expect(() => buildActionPayload(req({ verb: "complete", statusFrom: 65 }))).toThrow(IllegalTransitionError);
    expect(() => buildActionPayload(req({ verb: "approve", statusFrom: null }))).toThrow(IllegalTransitionError);
  });

  it("clientGuid is the caller's — the outbox passes one and retries with the SAME one", () => {
    const a = buildActionPayload(req({}));
    const b = buildActionPayload(req({}));
    expect(a.clientGuid).toBe("g-fixed");
    expect(b.clientGuid).toBe(a.clientGuid); // determinism under injected guid (replay-stable)
    expect(a.at).toBe(1234); // timestamp frozen at enqueue
  });

  it("create from null lands inbox; assign-with-assignee compose lands ongoing via chained verb", () => {
    const c = buildActionPayload(req({ verb: "create", statusFrom: null, title: "New" }));
    expect(c.statusTo).toBe(10);
    const a = buildActionPayload(req({ verb: "assign", statusFrom: null }));
    expect(a.statusTo).toBe(20); // auto-assign flip, plan §3
  });

  it("defaults text/photos to empty, keeps patch through verbatim", () => {
    const p = buildActionPayload(req({ verb: "edit", patch: { title: "Renamed", deadline: 99 } }));
    expect(p.text).toBe("");
    expect(p.photoRefs).toEqual([]);
    expect(p.patch).toEqual({ title: "Renamed", deadline: 99 });
  });
});
