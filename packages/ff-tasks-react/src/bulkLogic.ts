import {
  diffTaskFields,
  buildEditPatch,
  inverseVerb,
  isEditableStatus,
  transition,
  verbForEdit,
  type EditableTaskFields,
  type TaskPriority,
  type TaskStatus,
  type TaskVerb,
} from "@ff/tasks";

/**
 * Pure planning for multi-select + bulk actions. The UI turns each
 * PlannedAction into one outbox action (same path as a single edit), so
 * bulk changes inherit queueing, retries, idempotency and the rules
 * legality checks for free. Nothing here touches React or Firebase.
 */

/** Toggle one id in an immutable selection set. */
export function toggleId(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Inclusive id range between `anchor` and `target` in display order. */
export function rangeIds(order: readonly string[], anchor: string | null, target: string): string[] {
  const t = order.indexOf(target);
  if (t < 0) return [];
  const a = anchor === null ? -1 : order.indexOf(anchor);
  if (a < 0) return [target];
  const [lo, hi] = a < t ? [a, t] : [t, a];
  return order.slice(lo, hi + 1);
}

export interface BulkRowInput {
  id: string;
  title: string;
  status: number;
  assigneeUid?: string | null;
  assigneeName?: string | null;
  deadline?: number | null;
  type?: string | null;
  priority?: string | null;
  buildingId?: string | null;
  location?: { storeyName?: string | null; text?: string; [k: string]: unknown } | null;
  pending?: boolean;
}

export type BulkOp =
  | { kind: "status"; verb: TaskVerb }
  | { kind: "assignee"; uid: string | null; name: string | null }
  | { kind: "deadline"; deadline: number | null }
  | { kind: "type"; type: string }
  | { kind: "priority"; priority: TaskPriority };

export interface PlannedAction {
  taskId: string;
  title: string;
  verb: TaskVerb;
  statusFrom: number;
  patch?: Record<string, unknown>;
  text: string;
  /** the action that reverses this one; null = irreversible */
  undo: PlannedAction | null;
}

export type SkipReason = "illegal" | "unchanged" | "closed" | "pending";

export interface BulkPlan {
  actions: PlannedAction[];
  skipped: { taskId: string; reason: SkipReason }[];
  /** every planned action has an undo */
  reversible: boolean;
}

function editableOf(r: BulkRowInput): Partial<EditableTaskFields> {
  return {
    title: r.title,
    type: r.type ?? "task",
    deadline: r.deadline ?? null,
    assigneeUid: r.assigneeUid ?? null,
    assigneeName: r.assigneeName ?? null,
    buildingId: r.buildingId ?? null,
    priority: (r.priority as TaskPriority) ?? undefined,
    storeyName: r.location?.storeyName ?? null,
  };
}

function patchAction(r: BulkRowInput, next: Partial<EditableTaskFields>, statusNow: number): PlannedAction | "closed" | "unchanged" {
  if (!isEditableStatus(r.status)) return "closed";
  const before = editableOf(r);
  const changes = diffTaskFields(before, next);
  if (changes.length === 0) return "unchanged";
  const verb = verbForEdit(r.status, changes);
  if (!verb) return "closed";
  const patch = buildEditPatch(next, changes, r.location ?? null);
  const statusAfter = transition(verb, r.status as TaskStatus) ?? statusNow;
  // reverse: restore the previous values (as a fresh diff from the new state)
  const back: Partial<EditableTaskFields> = {};
  for (const c of changes) {
    if (c.key === "assigneeUid") {
      back.assigneeUid = r.assigneeUid ?? null;
      back.assigneeName = r.assigneeName ?? null;
    } else if (c.key === "deadline") back.deadline = r.deadline ?? null;
    else if (c.key === "type") back.type = r.type ?? "task";
    else if (c.key === "priority") back.priority = (r.priority as TaskPriority) ?? "normal";
  }
  const afterRow: Partial<EditableTaskFields> = { ...before, ...next };
  const backChanges = diffTaskFields(afterRow, back);
  const undoVerb = verbForEdit(statusAfter, backChanges);
  const undo: PlannedAction | null =
    undoVerb && backChanges.length > 0
      ? {
          taskId: r.id,
          title: r.title,
          verb: undoVerb,
          statusFrom: statusAfter,
          patch: buildEditPatch(back, backChanges, r.location ?? null),
          text: `reverted: ${backChanges.map((c) => c.text).join("; ")}`,
          undo: null,
        }
      : null;
  return {
    taskId: r.id,
    title: (next.title ?? r.title).trim() || r.title,
    verb,
    statusFrom: r.status,
    patch,
    text: changes.map((c) => c.text).join("; "),
    undo,
  };
}

/**
 * Plan one bulk operation over the selected rows. Rows that cannot take
 * it (terminal, illegal transition, no-op, still syncing) are skipped
 * with a reason instead of failing the whole batch.
 */
export function planBulk(rows: readonly BulkRowInput[], op: BulkOp): BulkPlan {
  const actions: PlannedAction[] = [];
  const skipped: BulkPlan["skipped"] = [];
  for (const r of rows) {
    if (r.pending) {
      skipped.push({ taskId: r.id, reason: "pending" });
      continue;
    }
    if (op.kind === "status") {
      const to = transition(op.verb, r.status as TaskStatus);
      if (to === null) {
        skipped.push({ taskId: r.id, reason: isEditableStatus(r.status) ? "illegal" : "closed" });
        continue;
      }
      const inv = inverseVerb(op.verb, r.status);
      actions.push({
        taskId: r.id,
        title: r.title,
        verb: op.verb,
        statusFrom: r.status,
        text: "",
        undo: inv
          ? { taskId: r.id, title: r.title, verb: inv, statusFrom: to, text: "", undo: null }
          : null,
      });
      continue;
    }
    const next: Partial<EditableTaskFields> =
      op.kind === "assignee"
        ? { assigneeUid: op.uid, assigneeName: op.name }
        : op.kind === "deadline"
          ? { deadline: op.deadline }
          : op.kind === "type"
            ? { type: op.type }
            : { priority: op.priority };
    const res = patchAction(r, next, r.status);
    if (res === "closed" || res === "unchanged") skipped.push({ taskId: r.id, reason: res });
    else actions.push(res);
  }
  return { actions, skipped, reversible: actions.length > 0 && actions.every((a) => a.undo !== null) };
}

/** Human summary for the toast, e.g. "Updated 5 tasks · 2 skipped". */
export function bulkSummary(label: string, plan: BulkPlan): string {
  const n = plan.actions.length;
  const s = plan.skipped.length;
  const head = n === 0 ? `Nothing to ${label}` : `${label} ${n} task${n === 1 ? "" : "s"}`;
  return s > 0 ? `${head} · ${s} skipped` : head;
}

/** The legal bulk status verbs for a selection (at least one row can take it). */
export function bulkStatusVerbs(rows: readonly BulkRowInput[], verbs: readonly TaskVerb[]): TaskVerb[] {
  return verbs.filter((v) => rows.some((r) => !r.pending && transition(v, r.status as TaskStatus) !== null));
}
