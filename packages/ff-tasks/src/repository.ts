import {
  increment,
  runTransaction,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  collection,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

import { taskDoc, taskEntryDoc, taskCounterDoc, tasksCollection } from '@ff/firestore';
import type { Task, TaskEntry, TaskPhoto } from '@ff/firestore';
import type { OutboxRecord } from '@ff/types';

import type { OutboxExecutor } from './outbox';
import type { TaskActionPayload } from './action';
import { locationThumbPath } from './photos';

/**
 * Cloud-first commit path (plan §3, §4; task-39 deliverables 4).
 *
 * One Firestore transaction per action: photos are uploaded BEFORE
 * the transaction (binary-first ordering); the transaction itself
 * writes the timeline entry (docId == clientGuid → the entry-exists
 * check makes a replayed transaction a no-op, §4 idempotency) and
 * updates the task doc. `entryCount` rides the same update via
 * `increment(1)` — the rules require exactly +1 per update.
 *
 * `create` allocates the per-project display number from
 * `taskCounters/tasks` inside the same transaction (rules pin the
 * increment shape: create at next==1, then +1).
 */

export function photoPath(payload: TaskActionPayload, index: number): string {
  const ref = payload.photoRefs[index];
  const ext = ref.mime === 'image/png' ? 'png' : ref.mime === 'image/webp' ? 'webp' : 'jpg';
  return `projects/${payload.projectId}/tasks/${payload.taskId}/${ref.sha256.slice(0, 12)}-${index}.${ext}`;
}

export function entryData(payload: TaskActionPayload, photos: TaskPhoto[]): TaskEntry {
  return {
    id: payload.clientGuid,
    action: payload.verb,
    text: payload.text,
    by: payload.actor.name,
    byUid: payload.actor.uid,
    at: payload.at,
    statusFrom: payload.statusFrom,
    statusTo: payload.statusTo,
    photos,
    clientGuid: payload.clientGuid,
  };
}

/**
 * Per-project display-number allocation (plan §2.2 `num`). Pure so
 * the counter semantics are unit-testable; the rules pin the same
 * shape server-side (create at next==1, then strictly +1).
 */
export function allocateNum(counter: { next: number } | null): { num: number; next: number } {
  const next = (counter?.next ?? 0) + 1;
  return { num: next, next };
}

/**
 * Shared update-branch validation. Extracted from the commit path so the
 * demo apply path guards the SAME edge (task-not-found → status-conflict)
 * with the SAME error strings — the rules-parity tests keep both honest.
 * The status-conflict check mirrors the client `transition()` map: a verb
 * may only traverse edges that `PAIRS` permits, and the stored doc's
 * `status` must equal the payload's expected `statusFrom`.
 */
export function validateTaskUpdate(
  current: Task | null,
  payload: TaskActionPayload
): void {
  if (!current) throw new Error('task-not-found');
  if (current.status !== payload.statusFrom) throw new Error('status-conflict');
}

/**
 * The FULL create-branch doc shape. Shared verbatim between the cloud
 * transaction and the demo source, so a queued create produces the exact
 * same Task doc in both paths. `num` is allocated by the caller (the
 * per-project counter — `allocateNum` — either server or demo-local).
 */
export function buildCreateTaskDto(
  payload: TaskActionPayload,
  photos: TaskPhoto[],
  num: number
): Task {
  const createDoc = (payload.createDoc ?? {}) as Record<string, unknown>;
  return {
    ...createDoc,
    id: payload.taskId,
    num,
    title: payload.title,
    status: payload.statusTo,
    createdBy: payload.actor.name,
    createdByUid: payload.actor.uid,
    createdAt: payload.at,
    updatedBy: payload.actor.name,
    updatedAt: payload.at,
    lastAction: 'create',
    entryCount: 1,
    photos,
  } as Task;
}

export async function commitTaskAction(
  db: Firestore,
  payload: TaskActionPayload
): Promise<{ taskId: string }> {
  const photos: TaskPhoto[] = payload.photoRefs.map((r, i) => ({
    storagePath: photoPath(payload, i),
    sha256: r.sha256,
    size: r.size,
    mime: r.mime,
  }));

  await runTransaction(db, async (tx) => {
    const entryRef = taskEntryDoc(db, payload.projectId, payload.taskId, payload.clientGuid);
    const existing = await tx.get(entryRef);
    if (existing.exists()) return; // replay after success — already applied

    if (payload.verb === 'create') {
      const counterRef = taskCounterDoc(db, payload.projectId);
      const counter = await tx.get(counterRef);
      const { num } = allocateNum(
        counter.exists() ? (counter.data() as { next: number }) : null
      );
      tx.set(counterRef, { next: num });
      tx.set(taskDoc(db, payload.projectId, payload.taskId), buildCreateTaskDto(payload, photos, num));
      tx.set(entryRef, entryData(payload, photos) as TaskEntry);
      return;
    }

    const ref = taskDoc(db, payload.projectId, payload.taskId);
    const snap = await tx.get(ref);
    const task = snap.exists() ? (snap.data() as Task) : null;
    validateTaskUpdate(task, payload);

    tx.set(entryRef, entryData(payload, photos) as TaskEntry);
    tx.update(ref, {
      status: payload.statusTo,
      lastAction: payload.verb,
      updatedBy: payload.actor.name,
      updatedAt: payload.at,
      entryCount: increment(1),
      ...(payload.patch ?? {}),
    });
  });

  return { taskId: payload.taskId };
}

/**
 * Admin hard delete of a task doc. Needs the rules change documented in
 * docs/integration/w69-tasks-rules.md (`allow delete` is false today), so
 * the UI only offers it where `hardDeleteEnabled` is on. The entries
 * subcollection is append-only and is NOT cascaded by the client.
 */
export async function deleteTaskDoc(db: Firestore, projectId: string, taskId: string): Promise<void> {
  await deleteDoc(taskDoc(db, projectId, taskId));
}

/** Storage port: idempotent upload (skip when the SHA-name already exists). */
export interface OutboxStorage {
  exists(path: string): Promise<boolean>;
  upload(path: string, blob: Blob): Promise<void>;
}

export interface BlobSource {
  get(blobKey: string): Promise<Blob | undefined>;
}

export function createTaskExecutor(
  db: Firestore,
  storage: OutboxStorage,
  blobs: BlobSource
): OutboxExecutor {
  return {
    async uploadPhotos(row: OutboxRecord) {
      const payload = row.payload as unknown as TaskActionPayload;
      for (let i = 0; i < payload.photoRefs.length; i++) {
        const ref = payload.photoRefs[i];
        const path = photoPath(payload, i);
        if (await storage.exists(path)) continue; // sha-named → dedupe
        const blob = await blobs.get(ref.blobKey);
        if (!blob) throw new Error(`blob-lost:${ref.blobKey}`);
        await storage.upload(path, blob);
      }
      // Location snapshot thumb (Day-3): fixed-name path → idempotent
      // by path. Rides the same binary-first step; the doc's
      // location.thumb.storagePath is written by the commit below.
      const thumb = payload.locationThumb;
      if (thumb) {
        const path = locationThumbPath(payload.projectId, payload.taskId);
        if (await storage.exists(path)) return;
        const blob = await blobs.get(thumb.blobKey);
        if (!blob) throw new Error(`blob-lost:${thumb.blobKey}`);
        await storage.upload(path, blob);
      }
    },
    async commit(row: OutboxRecord) {
      const payload = row.payload as unknown as TaskActionPayload;
      return commitTaskAction(db, payload);
    },
  };
}

// ── Live queries (§8: status-bounded + limit(50), latest-only by design) ──

export function watchTasks(
  db: Firestore,
  projectId: string,
  statuses: number[] | null,
  cb: (tasks: Task[]) => void,
  max = 50
): Unsubscribe {
  const base = tasksCollection(db, projectId);
  const q = statuses && statuses.length > 0
    ? query(base, where('status', 'in', statuses), orderBy('updatedAt', 'desc'), limit(max))
    : query(base, orderBy('updatedAt', 'desc'), limit(max));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data() as Task)));
}

/** "Tasks on this element" join (§5). Firestore cannot index into the
 *  `elements` OBJECT array — the old `location.bim.elements.expressId`
 *  array-contains was silently invalid (VDC acceptance 2026-11-02
 *  Bug 2). v1 filters the recent-tasks window client-side, the same
 *  join the 3D callout layer already performs; a server-side version
 *  would need a denormalized flat `expressIds` array on write. */
export function watchTasksOnElement(
  db: Firestore,
  projectId: string,
  expressId: number,
  cb: (tasks: Task[]) => void,
  max = 50
): Unsubscribe {
  const q = query(tasksCollection(db, projectId), orderBy('updatedAt', 'desc'), limit(max));
  return onSnapshot(q, (snap) =>
    cb(
      snap.docs
        .map((d) => d.data() as Task)
        .filter((t) =>
          (t.location?.bim?.elements ?? []).some((el) => el.expressId === expressId)
        )
    )
  );
}

/** Single-doc live view for the detail sheet (§7 screen 3). Null when
 *  the doc doesn't exist yet — a queued create still renders its
 *  timeline from the outbox overlay. */
export function watchTask(
  db: Firestore,
  projectId: string,
  taskId: string,
  cb: (task: Task | null) => void
): Unsubscribe {
  return onSnapshot(taskDoc(db, projectId, taskId), (s) =>
    cb(s.exists() ? (s.data() as Task) : null)
  );
}

export function watchTaskEntries(
  db: Firestore,
  projectId: string,
  taskId: string,
  cb: (entries: TaskEntry[]) => void
): Unsubscribe {
  const q = query(
    collection(db, 'projects', projectId, 'tasks', taskId, 'entries'),
    orderBy('at', 'asc')
  );
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data() as TaskEntry)));
}

// Keep setDoc/updateDoc referenced for the tree-shaking story (direct callers
// in Day-2 may use them; re-exported for convenience).
export { setDoc, updateDoc };
