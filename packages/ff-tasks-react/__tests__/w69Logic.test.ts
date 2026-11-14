import { describe, expect, it } from "vitest";

import {
  applyQuickFilters,
  chipCounts,
  deadlineSignal,
  matchesChip,
} from "../src/logic";
import { planBulk, rangeIds, toggleId, bulkSummary, type BulkRowInput } from "../src/bulkLogic";
import { activeMention, insertMention, mentionCandidates, mentionedUids, splitMentions } from "../src/mentions";
import { adjacentColumn, planBoardMove } from "../src/boardMove";
import { buildCsv, buildTasksReportHtml, csvCell } from "../src/exportTasks";
import type { TaskTableRow } from "../src/tableColumns";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime();
const at = (days: number) => new Date(2026, 10, 13 + days, 12, 0, 0).getTime();

describe("deadlineSignal", () => {
  it("overdue only from the next calendar day; due today..3d is soon", () => {
    expect(deadlineSignal(at(-1), 20, NOW)).toBe("overdue");
    expect(deadlineSignal(new Date(2026, 10, 13, 8).getTime(), 20, NOW)).toBe("soon"); // earlier today
    expect(deadlineSignal(at(0), 20, NOW)).toBe("soon");
    expect(deadlineSignal(at(3), 20, NOW)).toBe("soon");
    expect(deadlineSignal(at(4), 20, NOW)).toBeNull();
    expect(deadlineSignal(null, 20, NOW)).toBeNull();
  });
  it("terminal tasks never signal", () => {
    expect(deadlineSignal(at(-5), 65, NOW)).toBeNull();
    expect(deadlineSignal(at(1), 80, NOW)).toBeNull();
  });
});

describe("chip counts + quick filters", () => {
  const rows = [
    { id: "a", status: 10, assigneeUid: "me", deadline: at(-2) },
    { id: "b", status: 20, assigneeUid: "me", deadline: at(5) },
    { id: "c", status: 20, assigneeUid: "x", deadline: at(-1) },
    { id: "d", status: 65, assigneeUid: "me", deadline: at(-9) },
  ];
  it("counts per chip", () => {
    expect(chipCounts(rows)).toMatchObject({ all: 4, open: 3, closed: 1, "10": 1, "20": 2, "65": 1 });
    expect(matchesChip(20, "open")).toBe(true);
    expect(matchesChip(65, "open")).toBe(false);
    expect(matchesChip(20, 20)).toBe(true);
  });
  it("My tasks / Overdue quick filters AND together", () => {
    expect(applyQuickFilters(rows, { mine: true }, "me", NOW).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(applyQuickFilters(rows, { overdue: true }, "me", NOW).map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyQuickFilters(rows, { mine: true, overdue: true }, "me", NOW).map((r) => r.id)).toEqual(["a"]);
    expect(applyQuickFilters(rows, { mine: true }, null, NOW)).toEqual([]);
  });
});

describe("selection", () => {
  it("toggle + shift-range in display order", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect([...toggleId(new Set(["a"]), "b")]).toEqual(["a", "b"]);
    expect([...toggleId(new Set(["a"]), "a")]).toEqual([]);
    expect(rangeIds(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(order, null, "c")).toEqual(["c"]);
    expect(rangeIds(order, "zz", "c")).toEqual(["c"]);
  });
});

describe("planBulk", () => {
  const rows: BulkRowInput[] = [
    { id: "a", title: "A", status: 20, assigneeUid: "u1", assigneeName: "Ana", deadline: at(1) },
    { id: "b", title: "B", status: 10 },
    { id: "c", title: "C", status: 65 },
    { id: "d", title: "D", status: 40, pending: true },
  ];
  it("status: skips illegal/terminal/pending, keeps undo only when reversible", () => {
    const p = planBulk(rows, { kind: "status", verb: "complete" });
    expect(p.actions.map((a) => [a.taskId, a.verb])).toEqual([["a", "complete"]]);
    expect(p.actions[0]!.undo).toMatchObject({ verb: "reject", statusFrom: 40 });
    expect(p.skipped).toEqual([
      { taskId: "b", reason: "illegal" },
      { taskId: "c", reason: "closed" },
      { taskId: "d", reason: "pending" },
    ]);
    expect(p.reversible).toBe(true);
    const disc = planBulk(rows.slice(0, 2), { kind: "status", verb: "discontinue" });
    expect(disc.reversible).toBe(false);
  });
  it("deadline: patch + wording + inverse restores the old date", () => {
    const p = planBulk(rows.slice(0, 2), { kind: "deadline", deadline: at(10) });
    expect(p.actions).toHaveLength(2);
    expect(p.actions[0]!.verb).toBe("edit");
    expect(p.actions[0]!.patch).toEqual({ deadline: at(10) });
    expect(p.actions[0]!.text).toMatch(/^changed deadline from .* to .*$/);
    expect(p.actions[0]!.undo!.patch).toEqual({ deadline: at(1) });
    expect(p.actions[1]!.undo!.patch).toEqual({ deadline: null });
  });
  it("assignee on an inbox task uses assign (status flips), unchanged is skipped", () => {
    const p = planBulk(rows.slice(0, 2), { kind: "assignee", uid: "u1", name: "Ana" });
    expect(p.actions.map((a) => [a.taskId, a.verb])).toEqual([["b", "assign"]]);
    expect(p.skipped).toEqual([{ taskId: "a", reason: "unchanged" }]);
    expect(p.actions[0]!.patch).toEqual({ assigneeUid: "u1", assigneeName: "Ana" });
    expect(p.actions[0]!.undo!.verb).toBe("assign");
  });
  it("closed tasks cannot be edited", () => {
    const p = planBulk([rows[2]!], { kind: "type", type: "Defect" });
    expect(p.actions).toEqual([]);
    expect(p.skipped[0]!.reason).toBe("closed");
    expect(bulkSummary("Updated", planBulk([rows[0]!], { kind: "priority", priority: "high" }))).toBe("Updated 1 task");
  });
});

describe("mentions", () => {
  const people = [
    { uid: "1", name: "Ana Silva" },
    { uid: "2", name: "Ana" },
    { uid: "3", name: "Mateo Rojas" },
  ];
  it("detects the mention being typed", () => {
    expect(activeMention("hi @ma", 6)).toEqual({ start: 3, query: "ma" });
    expect(activeMention("hi @Ana S", 9)).toEqual({ start: 3, query: "Ana S" });
    expect(activeMention("mail me@x.com", 13)).toBeNull();
    expect(activeMention("no mention", 5)).toBeNull();
  });
  it("ranks candidates and inserts the full name", () => {
    expect(mentionCandidates(people, "ro").map((p) => p.uid)).toEqual(["3"]);
    expect(mentionCandidates(people, "ana")[0]!.name).toBe("Ana");
    const a = activeMention("hi @ma", 6)!;
    expect(insertMention("hi @ma", 6, a, people[2]!)).toEqual({ text: "hi @Mateo Rojas ", caret: 16 });
  });
  it("splits/resolves mentions, longest name first", () => {
    const parts = splitMentions("ping @Ana Silva and @Mateo Rojas, ok @nobody", people);
    expect(parts.filter((p) => p.uid).map((p) => [p.text, p.uid])).toEqual([
      ["@Ana Silva", "1"],
      ["@Mateo Rojas", "3"],
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("ping @Ana Silva and @Mateo Rojas, ok @nobody");
    expect(mentionedUids("@Ana and @Ana Silva @Ana", people)).toEqual(["2", "1"]);
    expect(splitMentions("plain", [])).toEqual([{ text: "plain" }]);
  });
});

describe("planBoardMove", () => {
  it("maps column drops onto legal verbs only", () => {
    expect(planBoardMove(20, "40")).toEqual({ verb: "complete", destructive: false });
    expect(planBoardMove(40, "20")).toEqual({ verb: "reject", destructive: false });
    expect(planBoardMove(40, "60")).toEqual({ verb: "followup", destructive: false });
    expect(planBoardMove(60, "40")).toEqual({ verb: "complete", destructive: false });
    expect(planBoardMove(10, "20")).toEqual({ verb: "assign", destructive: false });
    expect(planBoardMove(40, "terminal")).toEqual({ verb: "approve", destructive: true });
    expect(planBoardMove(20, "terminal")).toEqual({ verb: "discontinue", destructive: true });
    expect(planBoardMove(20, "10")).toBeNull();
    expect(planBoardMove(65, "20")).toBeNull();
    expect(planBoardMove(20, "20")).toBeNull();
    expect(planBoardMove(10, "40")).toBeNull();
  });
  it("adjacent columns", () => {
    expect(adjacentColumn("20", 1)).toBe("40");
    expect(adjacentColumn("10", -1)).toBeNull();
    expect(adjacentColumn("terminal", 1)).toBeNull();
  });
});

describe("export", () => {
  const row = (over: Partial<TaskTableRow> & Record<string, unknown> = {}): TaskTableRow => ({
    id: "t1", num: 7, title: 'Crack, "big"', status: 20, updatedAt: at(0), assigneeName: "Ana", lastAction: "create", entryCount: 1,
    deadline: at(-1), createdAt: at(-5), createdBy: "Bo", type: "Defect", buildingName: "North", storeyName: "L2", photos: [{ storagePath: "x" }],
    ...over,
  });
  it("quotes cells and guards formula injection", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
  it("builds a BOM'd CRLF csv for the view", () => {
    const csv = buildCsv([row(), row({ id: "t2", num: 8, title: "=cmd", priority: "high", checklist: [{ id: "a", text: "x", done: true }, { id: "b", text: "y", done: false }] })], NOW);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Number,Title,Description/);
    expect(lines[1]).toContain('T007,"Crack, ""big"""');
    expect(lines[1]).toContain(",overdue,");
    expect(lines[2]).toContain("'=cmd");
    expect(lines[2]).toContain("High");
    expect(lines[2]).toContain("1/2");
  });
  it("report html escapes, shows signals, photos and truncation note", () => {
    const html = buildTasksReportHtml(
      [{ row: row({ title: "<b>x</b>" }), photoUrls: ["data:image/png;base64,AA"], locationThumbUrl: "data:image/png;base64,BB" }],
      { now: NOW, projectName: "P1", totalInView: 5, printedAt: "now" }
    );
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Overdue");
    expect(html).toContain('class="ph"');
    expect(html).toContain('class="loc"');
    expect(html).toContain("first 1 of 5");
  });
});
