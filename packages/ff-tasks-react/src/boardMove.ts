import { isLegal, type TaskStatus, type TaskVerb } from "@ff/tasks";

/**
 * Board drag-and-drop / keyboard moves: which workflow verb carries a
 * card from its status column to a target column. Only edges the state
 * machine (and the Firestore rules mirror) allows are offered, so a
 * drop can never produce an illegal write.
 */

export interface MovePlan {
  verb: TaskVerb;
  /** terminal / hard-to-reverse — the UI confirms first */
  destructive: boolean;
}

const COLUMN_STATUS: Record<string, number | null> = {
  "10": 10,
  "20": 20,
  "40": 40,
  "60": 60,
  terminal: null,
};

/** Board column order, used by the keyboard alternative (Alt+←/→). */
export const MOVE_COLUMN_ORDER: readonly string[] = ["10", "20", "40", "60", "terminal"];

export function planBoardMove(status: number, targetColumn: string): MovePlan | null {
  if (!(targetColumn in COLUMN_STATUS)) return null;
  const s = status as TaskStatus;
  if (targetColumn === "terminal") {
    if (status === 65 || status === 80 || status === 30) return null;
    if (isLegal("approve", s)) return { verb: "approve", destructive: true };
    if (isLegal("discontinue", s)) return { verb: "discontinue", destructive: true };
    return null;
  }
  const to = COLUMN_STATUS[targetColumn] as number;
  if (to === status) return null;
  if (to === 20) {
    if (isLegal("reject", s)) return { verb: "reject", destructive: false };
    if (status === 10) return { verb: "assign", destructive: false };
    return null;
  }
  if (to === 40 && isLegal("complete", s)) return { verb: "complete", destructive: false };
  if (to === 60 && isLegal("followup", s)) return { verb: "followup", destructive: false };
  return null;
}

/** Neighbouring column for the keyboard alternative. */
export function adjacentColumn(columnKey: string, dir: -1 | 1): string | null {
  const i = MOVE_COLUMN_ORDER.indexOf(columnKey);
  if (i < 0) return null;
  return MOVE_COLUMN_ORDER[i + dir] ?? null;
}
