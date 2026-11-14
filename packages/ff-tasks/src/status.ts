/**
 * Task state machine — the single client-side source of truth
 * (plan §3, task-39 deliverable 2). The rules function
 * `legalTaskTransition` in packages/ff-firestore/firestore.rules
 * encodes the SAME pair set; the parity test in
 * __tests__/status.test.ts pins the table both ways.
 *
 * Model: the client sends VERBS, never status edits. A verb either
 * maps to a legal (from → to) pair or it is rejected outright;
 * every accepted verb appends exactly one timeline entry and bumps
 * `entryCount` by one (the rules enforce the increment).
 *
 * 10 inbox · 20 ongoing · 30 rejected (enum parity, unreachable v1)
 * 40 awaiting_approval · 60 approved_followup · 65 approved ⊣
 * 80 discontinued ⊣
 */

export const TASK_STATUS = {
  INBOX: 10,
  ONGOING: 20,
  REJECTED: 30,
  AWAITING_APPROVAL: 40,
  APPROVED_FOLLOWUP: 60,
  APPROVED: 65,
  DISCONTINUED: 80,
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const ALL_STATUSES: readonly TaskStatus[] = [10, 20, 30, 40, 60, 65, 80];

export const TERMINAL_STATUSES: readonly TaskStatus[] = [65, 80];

/** Fixed palette — CSS tokens, Commercial Viewer parity (§3). */
export const STATUS_COLORS: Record<TaskStatus, string> = {
  10: "blue",
  20: "yellow",
  30: "red",
  40: "orange",
  60: "teal",
  65: "green",
  80: "gray",
};

export type TaskVerb =
  | "create"
  | "comment"
  | "edit"
  | "assign"
  | "complete"
  | "reject"
  | "approve"
  | "followup"
  | "discontinue";

export const ALL_VERBS: readonly TaskVerb[] = [
  "create",
  "comment",
  "edit",
  "assign",
  "complete",
  "reject",
  "approve",
  "followup",
  "discontinue",
];

/**
 * verb → list of legal [from, to] pairs. `null` from = doc creation.
 * comment/edit are self-pairs (timeline append, status untouched);
 * terminals (65/80) accept nothing, 30 is unreachable so has no
 * outgoing pair.
 */
const PAIRS: Record<TaskVerb, readonly (readonly [TaskStatus | null, TaskStatus])[]> = {
  create: [[null, 10]],
  comment: [[10, 10], [20, 20], [40, 40], [60, 60]],
  edit: [[10, 10], [20, 20], [40, 40], [60, 60]],
  assign: [[null, 20], [10, 20], [20, 20]],
  complete: [[20, 40], [60, 40]],
  reject: [[40, 20]],
  approve: [[40, 65]],
  followup: [[40, 60]],
  discontinue: [[10, 80], [20, 80], [40, 80], [60, 80]],
};

/** The target status for `verb` from `from`, or null when illegal. */
export function transition(verb: TaskVerb, from: TaskStatus | null): TaskStatus | null {
  for (const [pf, pt] of PAIRS[verb]) {
    if (pf === from) return pt;
  }
  return null;
}

export function isLegal(verb: TaskVerb, from: TaskStatus | null): boolean {
  return transition(verb, from) !== null;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Legal verbs from a state (UI action bar — plan §7 screen 3). */
export function legalVerbs(from: TaskStatus | null): TaskVerb[] {
  return ALL_VERBS.filter((v) => isLegal(v, from));
}

/**
 * The full legal pair set as a flat sorted list, exactly as the
 * rules function must see it (parity assertion helper).
 */
export function legalPairsFlat(): readonly string[] {
  const out: string[] = [];
  for (const verb of ALL_VERBS) {
    for (const [from, to] of PAIRS[verb]) {
      if (from === null) continue; // creation pair, not an update
      const key = `${from}->${to}`;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out.sort();
}
