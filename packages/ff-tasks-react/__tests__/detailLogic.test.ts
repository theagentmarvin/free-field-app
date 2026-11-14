import { describe, expect, it } from "vitest";

import { isLegal, type TaskStatus, type TaskVerb } from "@ff/tasks";

import {
  ACTION_BAR_VERBS,
  ACTION_LABELS,
  activityCount,
  barVerbsFor,
  latestEntryActor,
  transitionBadge,
  VERB_ICONS,
  VERB_LABELS,
} from "../src/detailLogic";

/**
 * Chunk 5 — the detail sheet's pure wiring (plan §7 screen 3). The
 * action bar is the shared state machine made visible: only legal
 * transition verbs render, terminals get nothing, and the badge text
 * is label-pure (self-pairs and creation never badge).
 */

const legal = (v: TaskVerb, from: number) => isLegal(v, from as TaskStatus);

describe("barVerbsFor (state machine → action bar)", () => {
  it("inbox: discontinue only", () => {
    expect(barVerbsFor(10, legal)).toEqual(["discontinue"]);
  });
  it("ongoing: complete + discontinue", () => {
    expect(barVerbsFor(20, legal)).toEqual(["complete", "discontinue"]);
  });
  it("awaiting approval: reject / approve / followup / discontinue — never complete", () => {
    expect(barVerbsFor(40, legal)).toEqual([
      "reject",
      "approve",
      "followup",
      "discontinue",
    ]);
  });
  it("follow-up: back to complete", () => {
    expect(barVerbsFor(60, legal)).toEqual(["complete", "discontinue"]);
  });
  it("terminals (65/80): nothing", () => {
    expect(barVerbsFor(65, legal)).toEqual([]);
    expect(barVerbsFor(80, legal)).toEqual([]);
  });
});

describe("transitionBadge", () => {
  it("labels status-changing edges", () => {
    expect(transitionBadge(20, 40)).toBe("Ongoing → Awaiting approval");
    expect(transitionBadge(40, 20)).toBe("Awaiting approval → Ongoing");
    expect(transitionBadge(40, 65)).toBe("Awaiting approval → Approved");
  });
  it("silent for self-pairs and creation", () => {
    expect(transitionBadge(20, 20)).toBeNull(); // comment/edit
    expect(transitionBadge(null, 10)).toBeNull(); // create
    expect(transitionBadge(65, null)).toBeNull();
  });
});

describe("label/icon tables", () => {
  it("cover every verb the UI can meet", () => {
    for (const v of [...ACTION_BAR_VERBS, "comment", "create"] as TaskVerb[]) {
      expect(VERB_ICONS[v]).toBeTruthy();
      expect(VERB_LABELS[v]).toBeTruthy();
    }
    for (const v of ACTION_BAR_VERBS) expect(ACTION_LABELS[v]).toBeTruthy();
  });
});

describe("activity count + updated-by derivation", () => {
  it("activityCount reports the full merged entry list length", () => {
    expect(activityCount([])).toBe(0);
    expect(activityCount([{ clientGuid: "a" }, { clientGuid: "b" }, { clientGuid: "c" }])).toBe(3);
  });

  it("latestEntryActor returns the newest entry's actor (trimmed)", () => {
    expect(
      latestEntryActor([
        { by: "Ana" },
        { by: "  Alex Rivera  " },
      ])
    ).toBe("Alex Rivera");
  });

  it("latestEntryActor is null when there are no entries (never fake)", () => {
    expect(latestEntryActor([])).toBeNull();
  });

  it("latestEntryActor is null when the newest actor is blank", () => {
    expect(latestEntryActor([{ by: "  " }])).toBeNull();
  });
});
