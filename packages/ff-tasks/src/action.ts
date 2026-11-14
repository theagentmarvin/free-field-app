import type { OutboxPhotoRef } from "@ff/types";

import { transition, type TaskStatus, type TaskVerb } from "./status";

/**
 * One client-authored task action (plan §0: actions, not status
 * edits). Built synchronously on the UI thread, handed to the
 * outbox, replayed by the executor. `clientGuid` is generated once
 * here and NEVER regenerated — it becomes the timeline-entry doc id,
 * so a retried transaction cannot double-append (§4 idempotency).
 */
export interface TaskActionPayload {
  verb: TaskVerb;
  projectId: string;
  /** uuid allocated at compose start (draft id == taskId == this). */
  taskId: string;
  clientGuid: string;
  actor: { uid: string; name: string };
  at: number; // epoch millis, fixed at enqueue time
  /** entry display/merge fields */
  title: string;
  statusFrom: TaskStatus | null;
  statusTo: TaskStatus;
  text: string;
  photoRefs: OutboxPhotoRef[];
  /** full doc shape on `create`; sparse patch on other verbs */
  createDoc?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  /** Location-snapshot thumb binary (Day-3): fixed-name Storage path,
   *  uploaded bytes-first like a photo. null/undefined = no snapshot. */
  locationThumb?: { blobKey: string; size: number; mime: string } | null;
}

export interface ActionRequest {
  verb: TaskVerb;
  projectId: string;
  taskId: string;
  statusFrom: TaskStatus | null;
  actor: { uid: string; name: string };
  title: string;
  text?: string;
  photoRefs?: OutboxPhotoRef[];
  createDoc?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  /** injectable for deterministic tests */
  guid?: string;
  at?: number;
  locationThumb?: { blobKey: string; size: number; mime: string } | null;
}

export class IllegalTransitionError extends Error {
  constructor(verb: TaskVerb, from: TaskStatus | null) {
    super(`task action '${verb}' is illegal from status ${from ?? "(new)"}`);
    this.name = "IllegalTransitionError";
  }
}

/** Derive the target status via the state machine or throw. */
export function buildActionPayload(req: ActionRequest): TaskActionPayload {
  const statusTo = transition(req.verb, req.statusFrom);
  if (statusTo === null) throw new IllegalTransitionError(req.verb, req.statusFrom);
  return {
    verb: req.verb,
    projectId: req.projectId,
    taskId: req.taskId,
    clientGuid: req.guid ?? crypto.randomUUID(),
    actor: req.actor,
    at: req.at ?? Date.now(),
    title: req.title,
    statusFrom: req.statusFrom,
    statusTo,
    text: req.text ?? "",
    photoRefs: req.photoRefs ?? [],
    createDoc: req.createDoc,
    patch: req.patch,
    locationThumb: req.locationThumb ?? null,
  };
}
