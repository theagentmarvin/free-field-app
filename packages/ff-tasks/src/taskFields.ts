import { transition, type TaskStatus, type TaskVerb } from './status';

/**
 * Task field model shared by the detail editor, bulk actions and the
 * optimistic merge. Pure: no React, no Firebase.
 *
 * Priority / checklist / watchers are ADDITIVE task-doc fields. The
 * Firestore rules allowlist (`hasOnlyTaskKeys`) must name them before a
 * cloud write succeeds — see docs/integration/w69-tasks-rules.md. Until
 * then the UI gates them behind `extendedFieldsEnabled` (demo: on).
 */

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
};

/** Sort rank: higher = more urgent. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

export function isTaskPriority(v: unknown): v is TaskPriority {
  return typeof v === 'string' && (TASK_PRIORITIES as readonly string[]).includes(v);
}

/** Missing/unknown priority reads as `normal`. */
export function priorityOf(v: unknown): TaskPriority {
  return isTaskPriority(v) ? v : 'normal';
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export const MAX_CHECKLIST_ITEMS = 50;
export const MAX_CHECKLIST_TEXT = 200;

/** Defensive read of a doc's `checklist` (drops malformed entries). */
export function normalizeChecklist(v: unknown): ChecklistItem[] {
  if (!Array.isArray(v)) return [];
  const out: ChecklistItem[] = [];
  for (const raw of v) {
    const it = raw as Partial<ChecklistItem> | null;
    if (!it || typeof it.id !== 'string' || typeof it.text !== 'string') continue;
    out.push({ id: it.id, text: it.text.slice(0, MAX_CHECKLIST_TEXT), done: it.done === true });
    if (out.length >= MAX_CHECKLIST_ITEMS) break;
  }
  return out;
}

export function checklistProgress(items: readonly ChecklistItem[] | undefined | null): {
  done: number;
  total: number;
} {
  const list = items ?? [];
  return { done: list.filter((i) => i.done).length, total: list.length };
}

export function normalizeWatchers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

// ── validation ───────────────────────────────────────────────────────────

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 20000;

/** Returns an error message, or null when valid. */
export function validateTitle(title: string): string | null {
  const t = title.trim();
  if (t.length === 0) return 'Title is required.';
  if (t.length > MAX_TITLE) return `Title is limited to ${MAX_TITLE} characters.`;
  return null;
}

export function validateDescription(text: string): string | null {
  return text.length > MAX_DESCRIPTION ? 'Description is too long.' : null;
}

/** `yyyy-mm-dd` (the <input type=date> value) → local-noon epoch ms. */
export function parseDateInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function toDateInput(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── edit diffing ─────────────────────────────────────────────────────────

/** The doc fields an editor/bulk action may change. */
export interface EditableTaskFields {
  title: string;
  description: string;
  type: string;
  deadline: number | null;
  assigneeUid: string | null;
  assigneeName: string | null;
  buildingId: string | null;
  storeyName: string | null;
  locationText: string | null;
  priority: TaskPriority;
  checklist: ChecklistItem[];
  watchers: string[];
}

export type EditableFieldKey = keyof EditableTaskFields;

const FIELD_LABEL: Record<EditableFieldKey, string> = {
  title: 'title',
  description: 'description',
  type: 'type',
  deadline: 'deadline',
  assigneeUid: 'assignee',
  assigneeName: 'assignee',
  buildingId: 'building',
  storeyName: 'level',
  locationText: 'location note',
  priority: 'priority',
  checklist: 'checklist',
  watchers: 'watchers',
};

export function formatDateForLog(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || ts <= 0) return 'none';
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function clip(s: string, n = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export interface FieldChange {
  key: EditableFieldKey;
  label: string;
  from: string;
  to: string;
  /** "changed deadline from A to B" */
  text: string;
}

function describe(label: string, from: string, to: string): string {
  return `changed ${label} from ${from} to ${to}`;
}

/** Resolve display names (building ids → names) for the log text. */
export interface DescribeCtx {
  buildingName?: (id: string | null) => string | null;
}

/**
 * Compare `before` with the requested `next` (a partial); returns the
 * list of real changes. Equal values are dropped so a no-op edit never
 * enqueues an action.
 */
export function diffTaskFields(
  before: Partial<EditableTaskFields>,
  next: Partial<EditableTaskFields>,
  ctx: DescribeCtx = {},
): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (key: EditableFieldKey, from: string, to: string) =>
    changes.push({ key, label: FIELD_LABEL[key], from, to, text: describe(FIELD_LABEL[key], from, to) });
  const bn = (id: string | null | undefined) =>
    id ? (ctx.buildingName?.(id) ?? id) : 'none';

  if (next.title !== undefined && next.title.trim() !== (before.title ?? '').trim())
    push('title', `“${clip(before.title ?? '')}”`, `“${clip(next.title)}”`);
  if (next.description !== undefined && next.description !== (before.description ?? ''))
    changes.push({
      key: 'description',
      label: 'description',
      from: before.description ?? '',
      to: next.description,
      text: 'updated the description',
    });
  if (next.type !== undefined && next.type !== (before.type ?? 'task'))
    push('type', before.type || 'none', next.type || 'none');
  if (next.deadline !== undefined && (next.deadline ?? null) !== (before.deadline ?? null))
    push('deadline', formatDateForLog(before.deadline), formatDateForLog(next.deadline));
  if (next.assigneeUid !== undefined && (next.assigneeUid ?? null) !== (before.assigneeUid ?? null))
    push('assigneeUid', before.assigneeName || 'unassigned', next.assigneeName || 'unassigned');
  if (next.buildingId !== undefined && (next.buildingId ?? null) !== (before.buildingId ?? null))
    push('buildingId', bn(before.buildingId), bn(next.buildingId));
  if (next.storeyName !== undefined && (next.storeyName ?? null) !== (before.storeyName ?? null))
    push('storeyName', before.storeyName || 'none', next.storeyName || 'none');
  if (next.locationText !== undefined && (next.locationText ?? null) !== (before.locationText ?? null))
    push('locationText', clip(before.locationText ?? '') || 'none', clip(next.locationText ?? '') || 'none');
  if (next.priority !== undefined && next.priority !== priorityOf(before.priority))
    push('priority', priorityOf(before.priority), next.priority);
  if (next.checklist !== undefined && JSON.stringify(next.checklist) !== JSON.stringify(before.checklist ?? [])) {
    const b = checklistProgress(before.checklist);
    const a = checklistProgress(next.checklist);
    changes.push({
      key: 'checklist',
      label: 'checklist',
      from: `${b.done}/${b.total}`,
      to: `${a.done}/${a.total}`,
      text: `updated the checklist (${a.done}/${a.total} done)`,
    });
  }
  if (next.watchers !== undefined && JSON.stringify(next.watchers) !== JSON.stringify(before.watchers ?? [])) {
    changes.push({
      key: 'watchers',
      label: 'watchers',
      from: String((before.watchers ?? []).length),
      to: String(next.watchers.length),
      text: 'updated the watchers',
    });
  }
  return changes;
}

/** Fold a doc-shaped location edit: storey/note replace into the existing object. */
export interface LocationLike {
  storeyName?: string | null;
  text?: string;
  [k: string]: unknown;
}

/**
 * Build the sparse Firestore `patch` for a set of changes against the
 * current doc. `location` is rebuilt from the existing object so pins
 * (bim/pdf/thumb) survive a storey/note edit.
 */
export function buildEditPatch(
  next: Partial<EditableTaskFields>,
  changes: readonly FieldChange[],
  currentLocation: LocationLike | null | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const keys = new Set(changes.map((c) => c.key));
  if (keys.has('title')) patch.title = (next.title ?? '').trim();
  if (keys.has('description')) patch.description = next.description ?? '';
  if (keys.has('type')) patch.type = next.type ?? 'task';
  if (keys.has('deadline')) patch.deadline = next.deadline ?? null;
  if (keys.has('assigneeUid')) {
    patch.assigneeUid = next.assigneeUid ?? null;
    patch.assigneeName = next.assigneeUid ? (next.assigneeName ?? null) : null;
  }
  if (keys.has('buildingId')) patch.buildingId = next.buildingId ?? null;
  if (keys.has('priority')) patch.priority = next.priority;
  if (keys.has('checklist')) patch.checklist = next.checklist;
  if (keys.has('watchers')) patch.watchers = next.watchers;
  if (keys.has('storeyName') || keys.has('locationText')) {
    const loc: LocationLike = {
      storeyName: null,
      bim: null,
      pdf: null,
      ...(currentLocation ?? {}),
    };
    if (keys.has('storeyName')) loc.storeyName = next.storeyName ? next.storeyName : null;
    if (keys.has('locationText')) {
      if (next.locationText) loc.text = next.locationText;
      else delete loc.text;
    }
    patch.location = loc;
  }
  return patch;
}

/** Everything that rides the `extended` (rules-gated) fields. */
export const EXTENDED_PATCH_KEYS = ['priority', 'checklist', 'watchers'] as const;

// ── verb selection ───────────────────────────────────────────────────────

/** Terminal tasks (approved/discontinued) accept no writes at all. */
export function isEditableStatus(status: number): boolean {
  return transition('edit', status as TaskStatus) !== null;
}

/**
 * Which verb carries an edit: an assignee change keeps the existing
 * `assign` semantics (Inbox → Ongoing) where legal; everything else is
 * an `edit` self-pair. Null = the task is terminal (read-only).
 */
export function verbForEdit(status: number, changes: readonly FieldChange[]): TaskVerb | null {
  if (!isEditableStatus(status)) return null;
  const assigning = changes.some((c) => c.key === 'assigneeUid') &&
    changes.every((c) => c.key === 'assigneeUid' || c.key === 'watchers') &&
    transition('assign', status as TaskStatus) !== null;
  return assigning ? 'assign' : 'edit';
}

/** Status verbs offered by bulk actions, and their reversal (for undo). */
export const BULK_STATUS_VERBS = ['complete', 'reject', 'approve', 'followup', 'discontinue'] as const;
export type BulkStatusVerb = (typeof BULK_STATUS_VERBS)[number];

const INVERSE_VERB: Partial<Record<TaskVerb, TaskVerb>> = {
  complete: 'reject', // 20→40 ⇄ 40→20
  reject: 'complete',
  followup: 'complete', // 40→60 ⇄ 60→40
};

/** The verb that undoes `verb` from `from`, or null when irreversible. */
export function inverseVerb(verb: TaskVerb, from: number): TaskVerb | null {
  const inv = INVERSE_VERB[verb];
  if (!inv) return null;
  const to = transition(verb, from as TaskStatus);
  if (to === null) return null;
  const back = transition(inv, to);
  return back === from ? inv : null;
}
