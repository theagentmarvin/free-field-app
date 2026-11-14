import { describe, it, expect } from "vitest";

import type { OutboxRecord } from "@ff/types";
import type { TaskView } from "@ff/tasks";

import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  TYPE_OPTIONS,
  formatTaskNum,
  isCustomType,
  isOverdue,
  isOverdueDeadline,
  statusColor,
  visibleTasks,
} from "../src/logic";

const NOW = 1_700_000_000_000;

function t(over: Partial<TaskView> = {}): TaskView {
  return {
    id: crypto.randomUUID(),
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: NOW - 1000,
    assigneeName: "Ana",
    lastAction: "assign",
    entryCount: 2,
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
    createdAt: NOW,
  };
}

describe("formatTaskNum", () => {
  it("pads to three digits with the T prefix, no dash", () => {
    expect(formatTaskNum(123)).toBe("T123");
    expect(formatTaskNum(1)).toBe("T001");
    expect(formatTaskNum(42)).toBe("T042");
  });
  it("grows digits past 999 naturally", () => {
    expect(formatTaskNum(999)).toBe("T999");
    expect(formatTaskNum(1000)).toBe("T1000");
    expect(formatTaskNum(12345)).toBe("T12345");
  });
});

describe("visibleTasks — chips", () => {
  const cloud = [t({ status: 10 }), t({ status: 40 }), t({ status: 65 }), t({ status: 80 })];
  it("open/closed split by terminality; numeric chips are exact-equality", () => {
    expect(visibleTasks(cloud, [], { chip: "open" }).map((x) => x.status).sort()).toEqual([10, 40]);
    expect(visibleTasks(cloud, [], { chip: "closed" }).map((x) => x.status).sort()).toEqual([65, 80]);
    expect(visibleTasks(cloud, [], { chip: 40 }).map((x) => x.status)).toEqual([40]);
    expect(visibleTasks(cloud, [], { chip: "all" })).toHaveLength(4);
  });
  it("chip sets agree with the exported constants", () => {
    expect(OPEN_STATUSES).toEqual([10, 20, 40, 60]);
    expect(CLOSED_STATUSES).toEqual([65, 80]);
  });
});

describe("visibleTasks — search", () => {
  const cloud = [t({ title: "Formwork defect", num: 42, assigneeName: "Ana" }), t({ title: "Rebar", num: 43, assigneeName: "Bea" })];
  it("matches title, T-number, and assignee case-insensitively", () => {
    expect(visibleTasks(cloud, [], { search: "rebar" })).toHaveLength(1);
    expect(visibleTasks(cloud, [], { search: "T043" })[0]?.title).toBe("Rebar");
    expect(visibleTasks(cloud, [], { search: "BEA" })[0]?.title).toBe("Rebar");
    expect(visibleTasks(cloud, [], { search: "   " })).toHaveLength(2);
  });
});

describe("visibleTasks — sorts", () => {
  const a = t({ num: 1, updatedAt: NOW - 3000, deadline: NOW + 5000 });
  const b = t({ num: 9, updatedAt: NOW - 1000, deadline: null });
  const c = t({ num: 5, updatedAt: NOW - 2000, deadline: NOW + 1000 });
  it("updated (default) newest first", () => {
    expect(visibleTasks([a, b, c], [], { sort: "updated" }).map((x) => x.num)).toEqual([9, 5, 1]);
  });
  it("deadline soonest first, undated last", () => {
    expect(visibleTasks([a, b, c], [], { sort: "deadline" }).map((x) => x.num)).toEqual([5, 1, 9]);
  });
  it("created = per-project sequence desc", () => {
    expect(visibleTasks([a, b, c], [], { sort: "created" }).map((x) => x.num)).toEqual([9, 5, 1]);
  });
  it("limit caps rows", () => {
    expect(visibleTasks([a, b, c], [], { limit: 2 })).toHaveLength(2);
  });
});

describe("isOverdue", () => {
  it("flags only dated, still-open tasks past their deadline", () => {
    expect(isOverdue(t({ deadline: NOW - 1 }), NOW)).toBe(true);
    expect(isOverdue(t({ deadline: NOW + 1 }), NOW)).toBe(false);
    expect(isOverdue(t({ deadline: null }), NOW)).toBe(false);
    expect(isOverdue(t({ deadline: NOW - 1, status: 65 }), NOW)).toBe(false);
    expect(isOverdue(t({ deadline: NOW - 1, status: 80 }), NOW)).toBe(false);
  });
});

describe("visibleTasks — pending overlay via the outbox (D5 end-to-end)", () => {
  it("added overlays render (bumped, pending); sending never double-renders", () => {
    const cloud = [t({ id: "t1", num: 7, status: 40, updatedAt: NOW - 100 })];
    const approve = { verb: "approve", projectId: "p1", taskId: "t1", clientGuid: "gA", actor: { uid: "u1", name: "Maintainer" }, at: NOW, title: "Crack in slab", statusFrom: 40, statusTo: 65, text: "", photoRefs: [] };
    const rows = [row("added", approve), row("sending", { ...approve, clientGuid: "gB" })];
    const out = visibleTasks(cloud, rows);
    expect(out).toHaveLength(1); // sending suppressed; added overlays the same doc, not a new row
    expect(out[0].status).toBe(65); // optimistic preview
    expect(out[0].pending).toBe(true);
  });
});

describe("statusColor", () => {
  it("fixed palette, open + closed states covered", () => {
    expect(statusColor(10)).toBe("blue");
    expect(statusColor(40)).toBe("orange");
    expect(statusColor(65)).toBe("green");
    expect(statusColor(80)).toBe("gray");
  });
});

describe("type vocabulary", () => {
  it("TYPE_OPTIONS is the validated fixed set", () => {
    expect(TYPE_OPTIONS).toEqual(["Defect", "RFI", "Snag", "Safety", "Info", "Other"]);
  });

  it("isCustomType flags legacy free-text values only", () => {
    expect(isCustomType("RFI")).toBe(false);
    expect(isCustomType("Defect")).toBe(false);
    expect(isCustomType("observation")).toBe(true);
    expect(isCustomType("")).toBe(false);
    expect(isCustomType("  ")).toBe(false);
    expect(isCustomType(null)).toBe(false);
    expect(isCustomType(undefined)).toBe(false);
  });
});

describe("isOverdueDeadline", () => {
  it("red/Overdue only for dated, non-terminal tasks past deadline", () => {
    expect(isOverdueDeadline(NOW - 1, 20, NOW)).toBe(true);
    expect(isOverdueDeadline(NOW + 1, 20, NOW)).toBe(false);
    expect(isOverdueDeadline(null, 20, NOW)).toBe(false);
    expect(isOverdueDeadline(0, 20, NOW)).toBe(false);
    expect(isOverdueDeadline(NOW - 1, 65, NOW)).toBe(false); // approved ⊣
    expect(isOverdueDeadline(NOW - 1, 80, NOW)).toBe(false); // discontinued ⊣
    expect(isOverdueDeadline(NOW - 1, null, NOW)).toBe(false); // no status yet
  });
});
