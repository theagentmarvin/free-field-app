import { describe, expect, it } from "vitest";

import type { TaskTableRow } from "../src/tableColumns";
import {
  DAY_MS,
  applyColumnFilters,
  countActiveFilters,
  distinctOptions,
  endOfDay,
  endOfWeek,
  filterSelectionCount,
  isFilterEmpty,
  matchesDatePreset,
  matchesDeadlinePreset,
  startOfDay,
  startOfWeek,
  type ActiveFilters,
} from "../src/columnFilters";

/**
 * Wave 10 · pure per-column filter logic. Node env — all date windows use
 * a fixed `now` so boundaries are deterministic regardless of host TZ
 * (boundaries are derived with the same exported helpers the module uses).
 */

function mk(over: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: "t1",
    num: 1,
    title: "A task",
    status: 20,
    updatedAt: 100,
    assigneeName: null,
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

// A fixed clock that lands mid-week (2026-11-03 is a Tuesday) so
// today/week windows have room on both sides.
const NOW = new Date("2026-11-03T12:00:00").getTime();

describe("distinctOptions — value extraction incl. null grouping", () => {
  it("groups null/undefined into (none) and counts repeats", () => {
    const rows = [
      mk({ type: "Defect" }),
      mk({ type: "Defect" }),
      mk({ type: null }),
      mk({ type: "RFI" }),
    ];
    expect(distinctOptions(rows, "type").map((o) => [o.key, o.count])).toEqual([
      ["(none)", 1],
      ["Defect", 2],
      ["RFI", 1],
    ]);
  });

  it("status surfaces the label and counts", () => {
    const rows = [mk({ status: 10 }), mk({ status: 10 }), mk({ status: 20 })];
    expect(distinctOptions(rows, "status")).toEqual([
      { key: "Inbox", label: "Inbox", count: 2 },
      { key: "Ongoing", label: "Ongoing", count: 1 },
    ]);
  });
});

describe("applyColumnFilters — OR within, AND across", () => {
  it("distinct is OR within a column", () => {
    const rows = [
      mk({ id: "a", status: 20 }),
      mk({ id: "b", status: 10 }),
      mk({ id: "c", status: 40 }),
    ];
    const f: ActiveFilters = { status: { kind: "distinct", keys: ["Ongoing", "Inbox"] } };
    expect(applyColumnFilters(rows, f, NOW).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("empty filters are ignored", () => {
    const rows = [mk({ id: "a" }), mk({ id: "b" })];
    const f: ActiveFilters = { num: { kind: "number", min: null, max: null } };
    expect(applyColumnFilters(rows, f, NOW).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("AND across columns", () => {
    const rows = [
      mk({ id: "a", status: 20, type: "Defect" }),
      mk({ id: "b", status: 20, type: "RFI" }),
      mk({ id: "c", status: 40, type: "Defect" }),
    ];
    const f: ActiveFilters = {
      status: { kind: "distinct", keys: ["Ongoing"] },
      type: { kind: "distinct", keys: ["Defect"] },
    };
    expect(applyColumnFilters(rows, f, NOW).map((r) => r.id)).toEqual(["a"]);
  });

  it("text contains is case-insensitive", () => {
    const rows = [mk({ id: "a", title: "Crack In Slab" }), mk({ id: "b", title: "Paint" })];
    const hit: ActiveFilters = { title: { kind: "contains", query: "IN SLAB" } };
    const miss: ActiveFilters = { title: { kind: "contains", query: "zzz" } };
    expect(applyColumnFilters(rows, hit, NOW).map((r) => r.id)).toEqual(["a"]);
    expect(applyColumnFilters(rows, miss, NOW).map((r) => r.id)).toEqual([]);
  });

  it("number min/max edges", () => {
    const rows = [mk({ id: "a", num: 2 }), mk({ id: "b", num: 5 }), mk({ id: "c", num: 9 })];
    const between: ActiveFilters = { num: { kind: "number", min: 3, max: 6 } };
    expect(applyColumnFilters(rows, between, NOW).map((r) => r.id)).toEqual(["b"]);
    const onlyMin: ActiveFilters = { num: { kind: "number", min: 5, max: null } };
    expect(applyColumnFilters(rows, onlyMin, NOW).map((r) => r.id)).toEqual(["b", "c"]);
    const onlyMax: ActiveFilters = { num: { kind: "number", min: null, max: 2 } };
    expect(applyColumnFilters(rows, onlyMax, NOW).map((r) => r.id)).toEqual(["a"]);
    const impossible: ActiveFilters = { num: { kind: "number", min: 3, max: 3 } };
    expect(applyColumnFilters(rows, impossible, NOW).map((r) => r.id)).toEqual([]);
  });
});

describe("date/deadline preset boundaries (fixed now)", () => {
  const dayStart = startOfDay(NOW);
  const dayEnd = endOfDay(NOW);
  const weekStart = startOfWeek(NOW);
  const weekEnd = endOfWeek(NOW);

  it("today window", () => {
    expect(matchesDatePreset(dayStart, "today", NOW)).toBe(true);
    expect(matchesDatePreset(dayEnd, "today", NOW)).toBe(true);
    expect(matchesDatePreset(dayStart - 1, "today", NOW)).toBe(false);
    expect(matchesDatePreset(dayEnd + 1, "today", NOW)).toBe(false);
    expect(matchesDatePreset(null, "today", NOW)).toBe(false);
  });

  it("thisWeek window (Monday-first)", () => {
    expect(matchesDatePreset(weekStart, "thisWeek", NOW)).toBe(true);
    expect(matchesDatePreset(weekEnd, "thisWeek", NOW)).toBe(true);
    expect(matchesDatePreset(weekStart - 1, "thisWeek", NOW)).toBe(false);
    expect(matchesDatePreset(weekEnd + 1, "thisWeek", NOW)).toBe(false);
  });

  it("past7 rolling window", () => {
    expect(matchesDatePreset(NOW - 7 * DAY_MS, "past7", NOW)).toBe(true);
    expect(matchesDatePreset(NOW, "past7", NOW)).toBe(true);
    expect(matchesDatePreset(NOW - 7 * DAY_MS - 1, "past7", NOW)).toBe(false);
    expect(matchesDatePreset(NOW + 1, "past7", NOW)).toBe(false);
  });

  it("deadline next7 rolling window", () => {
    expect(matchesDeadlinePreset(mk({ deadline: NOW }), "next7", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: NOW + 7 * DAY_MS - 1 }), "next7", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: NOW + 7 * DAY_MS }), "next7", NOW)).toBe(false);
    expect(matchesDeadlinePreset(mk({ deadline: NOW - 1 }), "next7", NOW)).toBe(false);
  });

  it("deadline no-deadline grouping", () => {
    expect(matchesDeadlinePreset(mk({ deadline: undefined }), "none", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: null }), "none", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: 0 }), "none", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: NOW + 10 }), "none", NOW)).toBe(false);
  });

  it("deadline overdue: past-due + non-terminal only", () => {
    expect(matchesDeadlinePreset(mk({ deadline: NOW - 1000, status: 20 }), "overdue", NOW)).toBe(true);
    expect(matchesDeadlinePreset(mk({ deadline: NOW - 1000, status: 65 }), "overdue", NOW)).toBe(false);
    expect(matchesDeadlinePreset(mk({ deadline: NOW + 1000, status: 20 }), "overdue", NOW)).toBe(false);
    expect(matchesDeadlinePreset(mk({ deadline: undefined, status: 20 }), "overdue", NOW)).toBe(false);
  });
});

describe("affordance helpers", () => {
  it("isFilterEmpty / filterSelectionCount / countActiveFilters", () => {
    expect(isFilterEmpty(undefined)).toBe(true);
    expect(isFilterEmpty({ kind: "contains", query: "  " })).toBe(true);
    expect(isFilterEmpty({ kind: "number", min: 0, max: 0 })).toBe(false);
    expect(filterSelectionCount({ kind: "distinct", keys: ["a", "b"] })).toBe(2);
    expect(filterSelectionCount({ kind: "number", min: 0, max: null })).toBe(1);
    const f: ActiveFilters = {
      status: { kind: "distinct", keys: ["Ongoing"] },
      num: { kind: "number", min: null, max: null },
      title: { kind: "contains", query: "" },
    };
    expect(countActiveFilters(f)).toBe(1);
  });
});
describe("building column filter (UI-refresh v1 §4)", () => {
  const rows = [
    mk({ id: "a", buildingId: "b1", buildingName: "North Tower" }),
    mk({ id: "b", buildingId: "b2", buildingName: "East Wing" }),
    mk({ id: "c", buildingId: "b1", buildingName: "North Tower" }),
    mk({ id: "d", buildingId: null }),
  ];

  it("distinct options group by the enriched building name; legacy → (none)", () => {
    expect(distinctOptions(rows, "building").map((o) => [o.key, o.count])).toEqual([
      ["(none)", 1],
      ["East Wing", 1],
      ["North Tower", 2],
    ]);
  });

  it("selecting a building filters; legacy row stays out only when picked away", () => {
    const f: ActiveFilters = { building: { kind: "distinct", keys: ["North Tower"] } };
    expect(applyColumnFilters(rows, f, NOW).map((r) => r.id)).toEqual(["a", "c"]);
    const f2: ActiveFilters = { building: { kind: "distinct", keys: ["(none)"] } };
    expect(applyColumnFilters(rows, f2, NOW).map((r) => r.id)).toEqual(["d"]);
  });
});
