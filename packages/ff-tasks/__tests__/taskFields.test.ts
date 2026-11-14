import { describe, it, expect } from "vitest";

import {
  buildEditPatch,
  checklistProgress,
  diffTaskFields,
  inverseVerb,
  isEditableStatus,
  normalizeChecklist,
  parseDateInput,
  priorityOf,
  toDateInput,
  validateTitle,
  verbForEdit,
} from "../src/taskFields";
import { mergeTaskViews, type TaskView } from "../src/merge";
import { buildActionPayload } from "../src/action";
import { DemoTaskSource, type DemoTaskStore } from "../src/demoTaskSource";
import type { OutboxRecord } from "@ff/types";

describe("task fields", () => {
  it("validates titles", () => {
    expect(validateTitle("  ")).toMatch(/required/);
    expect(validateTitle("x".repeat(201))).toMatch(/limited/);
    expect(validateTitle("ok")).toBeNull();
  });

  it("round-trips date inputs at local noon", () => {
    const ts = parseDateInput("2026-11-20");
    expect(ts).not.toBeNull();
    expect(toDateInput(ts)).toBe("2026-11-20");
    expect(parseDateInput("nope")).toBeNull();
    expect(toDateInput(null)).toBe("");
  });

  it("diff drops no-ops and words the change for the activity log", () => {
    const before = { title: "A", deadline: parseDateInput("2026-11-10"), assigneeUid: "u1", assigneeName: "Ana", priority: "normal" as const };
    expect(diffTaskFields(before, { title: " A ", priority: "normal" })).toEqual([]);
    const ch = diffTaskFields(before, { deadline: parseDateInput("2026-11-20"), priority: "high", assigneeUid: null, assigneeName: null });
    expect(ch.map((c) => c.key)).toEqual(["deadline", "assigneeUid", "priority"]);
    expect(ch[0]!.text).toMatch(/^changed deadline from 10 Nov 2026 to 20 Nov 2026$/);
    expect(ch[1]!.text).toBe("changed assignee from Ana to unassigned");
    expect(ch[2]!.text).toBe("changed priority from normal to high");
  });

  it("building changes use the resolver for names", () => {
    const ch = diffTaskFields({ buildingId: "b1" }, { buildingId: "b2" }, { buildingName: (id) => (id === "b1" ? "North" : "South") });
    expect(ch[0]!.text).toBe("changed building from North to South");
  });

  it("buildEditPatch keeps pins when editing storey/note and clears assignee name", () => {
    const loc = { storeyName: "L1", bim: { elements: [], worldPoint: null, cameraPose: null }, pdf: null };
    const next = { storeyName: "L2", locationText: "near stair", assigneeUid: null, assigneeName: "stale" };
    const ch = diffTaskFields({ storeyName: "L1", assigneeUid: "u1" }, next);
    const patch = buildEditPatch(next, ch, loc);
    expect(patch.assigneeUid).toBeNull();
    expect(patch.assigneeName).toBeNull();
    expect(patch.location).toMatchObject({ storeyName: "L2", text: "near stair", bim: loc.bim });
  });

  it("verbForEdit: assignee-only uses assign where legal; terminal is read-only", () => {
    const assignOnly = diffTaskFields({ assigneeUid: null }, { assigneeUid: "u2", assigneeName: "B" });
    expect(verbForEdit(10, assignOnly)).toBe("assign");
    expect(verbForEdit(40, assignOnly)).toBe("edit");
    const t = diffTaskFields({ title: "a" }, { title: "b" });
    expect(verbForEdit(20, t)).toBe("edit");
    expect(verbForEdit(65, t)).toBeNull();
    expect(isEditableStatus(80)).toBe(false);
    expect(isEditableStatus(60)).toBe(true);
  });

  it("inverse verbs only where the reversal is legal", () => {
    expect(inverseVerb("complete", 20)).toBe("reject");
    expect(inverseVerb("reject", 40)).toBe("complete");
    expect(inverseVerb("followup", 40)).toBe("complete");
    expect(inverseVerb("complete", 60)).toBeNull();
    expect(inverseVerb("approve", 40)).toBeNull();
    expect(inverseVerb("discontinue", 20)).toBeNull();
  });

  it("checklist helpers", () => {
    const list = normalizeChecklist([{ id: "a", text: "x", done: true }, { id: 1 }, null, { id: "b", text: "y" }]);
    expect(list).toEqual([{ id: "a", text: "x", done: true }, { id: "b", text: "y", done: false }]);
    expect(checklistProgress(list)).toEqual({ done: 1, total: 2 });
    expect(checklistProgress(undefined)).toEqual({ done: 0, total: 0 });
    expect(priorityOf("bogus")).toBe("normal");
    expect(priorityOf("critical")).toBe("critical");
  });
});

describe("patch overlay in mergeTaskViews", () => {
  it("an queued edit patch shows optimistically on the list row", () => {
    const cloud: TaskView[] = [{ id: "t1", num: 1, title: "Old", status: 20, updatedAt: 100, assigneeName: null, lastAction: "create", entryCount: 1 }];
    const payload = buildActionPayload({
      verb: "edit", projectId: "p", taskId: "t1", statusFrom: 20, actor: { uid: "u", name: "U" },
      title: "New", at: 500, guid: "g", text: "changed title",
      patch: { title: "New", deadline: 999, priority: "high", assigneeUid: "u2", assigneeName: "Bo" },
    });
    const row = { id: "g", kind: "task-action", state: "added", projectId: "p", payload, photoRefs: [], attempts: 0, clientGuid: "g", createdAt: 500 } as unknown as OutboxRecord;
    const [v] = mergeTaskViews(cloud, [row]);
    expect(v).toMatchObject({ title: "New", deadline: 999, priority: "high", assigneeUid: "u2", assigneeName: "Bo", pending: true });
  });
});

describe("DemoTaskSource.deleteTask", () => {
  it("removes the task and notifies watchers", async () => {
    const tasks = new Map<string, unknown>([["t1", { id: "t1", updatedAt: 1, status: 10 }]]);
    const store = {
      listTasks: async () => [...tasks.values()],
      deleteTask: async (_p: string, id: string) => { tasks.delete(id); },
    } as unknown as DemoTaskStore;
    const src = new DemoTaskSource({ store, latency: { wait: async () => undefined } });
    const seen: number[] = [];
    const un = src.watchTasks("p", null, (t) => seen.push(t.length));
    await new Promise((r) => setTimeout(r, 5));
    await src.deleteTask("p", "t1");
    await new Promise((r) => setTimeout(r, 5));
    un();
    expect(seen[0]).toBe(1);
    expect(seen[seen.length - 1]).toBe(0);
  });
});
