import {
  buildActionPayload,
  composePhotoPath,
  type TaskActionPayload,
} from "@ff/tasks";
import type { OutboxPhotoRef } from "@ff/types";
import type { TaskLocation } from "@ff/firestore";

/**
 * Compose-sheet model (plan §7 screen 2): form state → the exact
 * action payloads the outbox carries. Auto-assign is the plan's
 * "create→assign flip in one compose": two enqueues, one per verb,
 * the state machine deriving each landing status.
 */

export interface ComposePhoto extends OutboxPhotoRef {
  /** object URL for the in-sheet thumbnail; not persisted */
  previewUrl?: string;
}

/** Day-3 location snapshot thumb in the compose sheet: the blob ref
 *  (rides the outbox) plus an object URL for the immediate preview.
 *  The deterministic Storage path lives on the location itself. */
export interface ComposeLocationThumb {
  blobKey: string;
  size: number;
  mime: string;
  previewUrl?: string;
}

export interface ComposeFields {
  title: string;
  description: string;
  type: string;
  assigneeUid: string | null;
  assigneeName: string | null;
  deadline: number | null;
  /** UI-refresh v1 §2: chosen building; null/absent = cross-building.
   *  Inherited from the rail via <TasksApp>, one-tap overridable. */
  buildingId?: string | null;
  photos: ComposePhoto[];
  location: TaskLocation | null;
  locationThumb: ComposeLocationThumb | null;
}

export interface ComposeMeta {
  projectId: string;
  /** client uuid allocated at compose start (draft id == taskId) */
  taskId: string;
  actor: { uid: string; name: string };
  at: number;
}

export function emptyCompose(): ComposeFields {
  return {
    title: "",
    description: "",
    type: "task",
    assigneeUid: null,
    assigneeName: null,
    deadline: null,
    buildingId: null,
    photos: [],
    location: null,
    locationThumb: null,
  };
}

export class ComposeValidationError extends Error {}

export type QuickDeadlineKind = "today" | "tomorrow" | "week";

/**
 * Deadline quick-chips (`Today · Tomorrow · +1 week`) — one-tap entry
 * above the native date picker. Returns the LOCAL-midnight epoch ms for
 * that day so the picker and the stored deadline agree regardless of
 * the user's timezone.
 */
export function quickDeadline(now: number, kind: QuickDeadlineKind): number {
  const d = new Date(now);
  if (kind === "tomorrow") d.setDate(d.getDate() + 1);
  else if (kind === "week") d.setDate(d.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Storage metadata for the task doc — same deterministic path the
 *  executor recomputes at commit (photos.ts parity test pins it). */
export function composePhotoMeta(
  projectId: string,
  taskId: string,
  photos: ComposePhoto[]
): { storagePath: string; sha256: string; size: number; mime: string }[] {
  return photos.map((p, i) => ({
    storagePath: composePhotoPath(projectId, taskId, i, p.sha256, p.mime),
    sha256: p.sha256,
    size: p.size,
    mime: p.mime,
  }));
}

export function buildComposeEnqueues(
  fields: ComposeFields,
  meta: ComposeMeta
): TaskActionPayload[] {
  if (!fields.title.trim()) throw new ComposeValidationError("title-required");
  const photoRefs: OutboxPhotoRef[] = fields.photos.map((p) => ({
    blobKey: p.blobKey,
    sha256: p.sha256,
    size: p.size,
    mime: p.mime,
  }));
  const create = buildActionPayload({
    verb: "create",
    projectId: meta.projectId,
    taskId: meta.taskId,
    statusFrom: null,
    actor: meta.actor,
    title: fields.title.trim(),
    at: meta.at,
    photoRefs,
    locationThumb: fields.locationThumb
      ? {
          blobKey: fields.locationThumb.blobKey,
          size: fields.locationThumb.size,
          mime: fields.locationThumb.mime,
        }
      : null,
    createDoc: {
      description: fields.description,
      type: fields.type || "task",
      deadline: fields.deadline,
      buildingId: fields.buildingId ?? null,
      assigneeUid: null,
      assigneeName: null,
      location: fields.location,
      photos: composePhotoMeta(meta.projectId, meta.taskId, fields.photos),
    },
  });
  if (!fields.assigneeUid) return [create];
  const assign = buildActionPayload({
    verb: "assign",
    projectId: meta.projectId,
    taskId: meta.taskId,
    statusFrom: create.statusTo,
    actor: meta.actor,
    title: create.title,
    at: meta.at + 1,
    patch: { assigneeUid: fields.assigneeUid, assigneeName: fields.assigneeName },
  });
  return [create, assign];
}

/**
 * ComposeFields → TaskDraftFields for the 15 s autosnapshot. Photo
 * entries keep their sha-named storagePath so a restored draft knows
 * what may already live in Storage (blobs themselves are in-memory).
 */
export function toDraftFields(f: ComposeFields, projectId: string, taskId: string) {
  return {
    title: f.title,
    description: f.description,
    type: f.type,
    assigneeUid: f.assigneeUid,
    assigneeName: f.assigneeName,
    deadline: f.deadline,
    buildingId: f.buildingId ?? null,
    location: f.location,
    locationThumb: f.locationThumb
      ? {
          blobKey: f.locationThumb.blobKey,
          size: f.locationThumb.size,
          mime: f.locationThumb.mime,
        }
      : null,
    photoPaths: f.photos.map((p, i) => ({
      blobKey: p.blobKey,
      storagePath: composePhotoPath(projectId, taskId, i, p.sha256, p.mime),
      sha256: p.sha256,
      size: p.size,
      mime: p.mime,
    })),
  };
}

/** TaskDraftFields (ff-tasks) ↔ ComposeFields for restore flows. */
export function draftToCompose(d: {
  title: string;
  description: string;
  type: string;
  assigneeUid: string | null;
  assigneeName: string | null;
  deadline: number | null;
  buildingId?: string | null;
  location: TaskLocation | null;
  locationThumb: { blobKey: string; size: number; mime: string } | null;
  photoPaths: { blobKey: string; sha256: string; size: number; mime: string }[];
}): ComposeFields {
  return {
    title: d.title,
    description: d.description,
    type: d.type,
    assigneeUid: d.assigneeUid,
    assigneeName: d.assigneeName,
    deadline: d.deadline,
    buildingId: d.buildingId ?? null,
    // blobs are in-memory only — restored drafts show counts, not previews
    photos: d.photoPaths.map((p) => ({ ...p })),
    location: d.location,
    locationThumb: d.locationThumb ? { ...d.locationThumb } : null,
  };
}
