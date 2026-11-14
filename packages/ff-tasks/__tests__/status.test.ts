import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ALL_STATUSES,
  ALL_VERBS,
  transition,
  isLegal,
  legalVerbs,
  legalPairsFlat,
  STATUS_COLORS,
  TERMINAL_STATUSES,
  type TaskStatus,
} from "../src/status";

const RULES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ff-firestore",
  "firestore.rules"
);

describe("task state machine — plan §3", () => {
  it("exhaustive verb × status matrix: the legal set is exactly §3", () => {
    const expected: Record<string, TaskStatus | null> = {
      "create|null": 10,
      "comment|10": 10, "comment|20": 20, "comment|40": 40, "comment|60": 60,
      "edit|10": 10, "edit|20": 20, "edit|40": 40, "edit|60": 60,
      "assign|null": 20, "assign|10": 20, "assign|20": 20,
      "complete|20": 40, "complete|60": 40,
      "reject|40": 20,
      "approve|40": 65,
      "followup|40": 60,
      "discontinue|10": 80, "discontinue|20": 80, "discontinue|40": 80, "discontinue|60": 80,
    };
    for (const verb of ALL_VERBS) {
      for (const from of [...ALL_STATUSES, null]) {
        const key = `${verb}|${from}`;
        expect(transition(verb, from), key).toBe(expected[key] ?? null);
      }
    }
  });

  it("status 30 is unreachable in v1 (reject lands back in 20)", () => {
    for (const verb of ALL_VERBS) {
      for (const from of ALL_STATUSES) {
        expect(transition(verb, from)).not.toBe(30);
      }
      expect(transition(verb, 30)).toBeNull();
    }
  });

  it("terminals (65, 80) accept nothing", () => {
    for (const term of TERMINAL_STATUSES) {
      expect(legalVerbs(term)).toEqual([]);
      for (const verb of ALL_VERBS) expect(isLegal(verb, term)).toBe(false);
    }
  });

  it("action-bar sets per state", () => {
    expect(legalVerbs(10).sort()).toEqual(["assign", "comment", "discontinue", "edit"].sort());
    expect(legalVerbs(20).sort()).toEqual(["assign", "comment", "complete", "discontinue", "edit"].sort());
    expect(legalVerbs(40).sort()).toEqual(["approve", "comment", "discontinue", "edit", "followup", "reject"].sort());
    expect(legalVerbs(60).sort()).toEqual(["comment", "complete", "discontinue", "edit"].sort());
    expect(legalVerbs(null)).toEqual(["create", "assign"]);
  });

  it("fixed palette, Commercial Viewer parity", () => {
    expect(STATUS_COLORS).toMatchObject({
      10: "blue", 20: "yellow", 30: "red", 40: "orange",
      60: "teal", 65: "green", 80: "gray",
    });
  });
});

describe("client ↔ rules parity (task-39 deliverable 2)", () => {
  // The rules function is written in a JS-compatible dialect; extract
  // and evaluate it so the parity check runs against the REAL rules
  // text — a hand-copied mirror could silently drift.
  function loadRulesTransition(): (from: number, to: number) => boolean {
    const src = readFileSync(RULES_PATH, "utf8");
    const m = src.match(/function legalTaskTransition\(from, to\) \{[\s\S]*?\n {4}\}/);
    if (!m) throw new Error("legalTaskTransition not found in firestore.rules");
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return (${m[0]})`)() as (from: number, to: number) => boolean;
  }

  it("rules and client agree on every (from → to) update pair", () => {
    const rulesFn = loadRulesTransition();
    const clientPairs = new Set(legalPairsFlat());
    const mismatches: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const viaRules = rulesFn(from, to);
        const viaClient = clientPairs.has(`${from}->${to}`);
        if (viaRules !== viaClient) {
          mismatches.push(`${from}->${to}: rules=${viaRules} client=${viaClient}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("rules never produce the reserved 30", () => {
    const rulesFn = loadRulesTransition();
    for (const from of ALL_STATUSES) expect(rulesFn(from, 30)).toBe(false);
  });
});
