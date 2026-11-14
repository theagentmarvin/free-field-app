import type { Task, TaskEntry, TaskPhoto } from '@ff/firestore';
import type { OutboxRecord } from '@ff/types';

import type { TaskActionPayload } from './action';
import type { OutboxExecutor } from './outbox';
import type { BlobSource } from './repository';
import { locationThumbPath } from './photos';
import {
  allocateNum,
  buildCreateTaskDto,
  entryData,
  photoPath,
  validateTaskUpdate,
} from './repository';

/**
 * Demo (login-free) task data plane — the local, zero-cloud twin of the
 * Firestore repository. The public Firebase link runs with no auth and no
 * backend, so `useTaskEngine` swaps the executor + live-query source onto
 * this Dexie-backed implementation instead of Firestore. Every surface
 * the UI consumes has a local twin here:
 *
 *   watchTasks / watchTask / watchTaskEntries  → subscribe + emit Task/
 *        TaskEntry-shaped docs out of Dexie on every write
 *   executor().uploadPhotos / commit           → the SAME state-machine
 *        transitions `repository.ts` applies, reusing `entryData`,
 *        `allocateNum`, `photoPath`, `validateTaskUpdate` and
 *        `buildCreateTaskDto` so the two paths cannot drift
 *   resolvePhotoUrl                            → photo BYTES held as data
 *        URLs in the local store (upload → display → print, fully offline)
 *
 * Everything here is dependency-injected (store + clock + blob source), so
 * the state-machine and seed-idempotency tests run without Dexie or timers.
 */

export type Unsubscribe = () => void;

/** Simulated network latency (300–800 ms) so the outbox's striped
 *  `sending` state is actually observable before a row lands `sent`. */
export function demoLatencyMs(random: () => number = Math.random): number {
  return 300 + Math.floor(random() * 500); // 300 .. 799
}

export interface DemoLatency {
  /** awaited at commit time — the "send" round-trip. */
  wait(): Promise<void>;
}

export function realDemoLatency(): DemoLatency {
  return {
    wait: () =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, demoLatencyMs(Math.random)),
      ),
  };
}

/** Storage port the demo source writes through (Dexie in production,
 *  an in-memory table in tests). */
export interface DemoTaskStore {
  putTask(projectId: string, task: Task): Promise<void>;
  getTask(taskId: string): Promise<Task | undefined>;
  listTasks(projectId: string): Promise<Task[]>;
  countTasks(projectId: string): Promise<number>;

  putEntry(projectId: string, taskId: string, entry: TaskEntry): Promise<void>;
  listEntries(projectId: string, taskId: string): Promise<TaskEntry[]>;

  getCounter(projectId: string): Promise<{ next: number } | undefined>;
  putCounter(projectId: string, counter: { next: number }): Promise<void>;

  putPhoto(storagePath: string, dataUrl: string): Promise<void>;
  getPhoto(storagePath: string): Promise<string | undefined>;

  /** Hard delete of a task + its timeline (admin action). Optional so
   *  in-memory test stores that predate it stay valid. */
  deleteTask?(projectId: string, taskId: string): Promise<void>;
}

/** One seeded task + its timeline + its photo bytes. */
export interface DemoTaskSeed {
  task: Task;
  entries: TaskEntry[];
  /** photo data URLs keyed by their storagePath (task/entry carry the
   *  same storagePath in their `photos[].storagePath` metadata). */
  photos: { storagePath: string; dataUrl: string }[];
}

export interface DemoTaskSourceOptions {
  store: DemoTaskStore;
  latency?: DemoLatency;
}

/**
 * `commit` for a queued payload against the local store. Reuses the
 * repository's shared pieces; the ONLY divergence from the cloud commit
 * is `entryCount`: the cloud transaction uses Firestore's atomic
 * `increment(1)` while the single-writer local store computes
 * `current.entryCount + 1` directly (identical for a single writer).
 */
async function commitLocal(
  store: DemoTaskStore,
  projectId: string,
  payload: TaskActionPayload
): Promise<{ taskId: string }> {
  // Replay idempotency mirroring the cloud transaction's "entry exists →
  // no-op" early return: a row re-claimed after a crash (recoverStale) or
  // backoff re-attempt whose commit already landed must NOT re-allocate a
  // T-number or append the timeline twice (entry id == clientGuid).
  const existingEntries = await store.listEntries(projectId, payload.taskId);
  if (existingEntries.some((e) => e.id === payload.clientGuid)) {
    return { taskId: payload.taskId };
  }

  const photos: TaskPhoto[] = payload.photoRefs.map((r, i) => ({
    storagePath: photoPath(payload, i),
    sha256: r.sha256,
    size: r.size,
    mime: r.mime,
  }));

  if (payload.verb === 'create') {
    const counter = await store.getCounter(projectId);
    const { num } = allocateNum(counter ?? null);
    await store.putCounter(projectId, { next: num });
    await store.putTask(
      projectId,
      buildCreateTaskDto(payload, photos, num),
    );
    await store.putEntry(projectId, payload.taskId, entryData(payload, photos));
    return { taskId: payload.taskId };
  }

  const current = await store.getTask(payload.taskId);
  validateTaskUpdate(current ?? null, payload);
  const task: Task = {
    ...(current as Task),
    status: payload.statusTo,
    lastAction: payload.verb,
    updatedBy: payload.actor.name,
    updatedAt: payload.at,
    entryCount: (current as Task).entryCount + 1,
    ...(payload.patch ?? {}),
  };
  await store.putTask(projectId, task);
  await store.putEntry(projectId, payload.taskId, entryData(payload, photos));
  return { taskId: payload.taskId };
}

/** Blob → data URL (offline photo storage). Works in browser and Node. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = globalThis.btoa(bin);
  return `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
}

export class DemoTaskSource {
  private store: DemoTaskStore;
  private latency: DemoLatency;
  private listeners = new Set<() => void>();

  constructor(opts: DemoTaskSourceOptions) {
    this.store = opts.store;
    this.latency = opts.latency ?? realDemoLatency();
  }

  /** Awaitable door for tests wanting a fully-settled source. */
  get storeRef(): DemoTaskStore {
    return this.store;
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private async emitTasks(
    projectId: string,
    statuses: number[] | null,
    cb: (tasks: Task[]) => void,
    max: number,
  ): Promise<void> {
    let tasks = await this.store.listTasks(projectId);
    if (statuses && statuses.length > 0) {
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }
    tasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    cb(tasks.slice(0, max));
  }

  watchTasks(
    projectId: string,
    statuses: number[] | null,
    cb: (tasks: Task[]) => void,
    max = 50,
  ): Unsubscribe {
    const emit = () => {
      void this.emitTasks(projectId, statuses, cb, max);
    };
    this.listeners.add(emit);
    emit();
    return () => this.listeners.delete(emit);
  }

  watchTask(
    _projectId: string,
    taskId: string,
    cb: (task: Task | null) => void,
  ): Unsubscribe {
    const emit = () => {
      void this.store.getTask(taskId).then((t) => cb(t ?? null));
    };
    this.listeners.add(emit);
    emit();
    return () => this.listeners.delete(emit);
  }

  watchTaskEntries(
    projectId: string,
    taskId: string,
    cb: (entries: TaskEntry[]) => void,
  ): Unsubscribe {
    const emit = () => {
      void this.store.listEntries(projectId, taskId).then((entries) => {
        cb([...entries].sort((a, b) => a.at - b.at));
      });
    };
    this.listeners.add(emit);
    emit();
    return () => this.listeners.delete(emit);
  }

  /** Offline photo resolver: the data URL stored against a path, else null. */
  async resolvePhotoUrl(storagePath: string): Promise<string | null> {
    if (!storagePath) return null;
    const dataUrl = await this.store.getPhoto(storagePath);
    return typeof dataUrl === 'string' && dataUrl.length > 0 ? dataUrl : null;
  }

  /** The outbox executor: upload photos to the local store (as data
   *  URLs) then commit the action, both behind the simulated latency. */
  executor(blobs: BlobSource): OutboxExecutor {
    return {
      uploadPhotos: async (row: OutboxRecord) => {
        const payload = row.payload as unknown as TaskActionPayload;
        for (let i = 0; i < payload.photoRefs.length; i++) {
          const ref = payload.photoRefs[i];
          const path = photoPath(payload, i);
          if ((await this.store.getPhoto(path)) !== undefined) continue; // dedupe
          const blob = await blobs.get(ref.blobKey);
          if (!blob) throw new Error(`blob-lost:${ref.blobKey}`);
          await this.store.putPhoto(path, await blobToDataUrl(blob));
        }
        // Location snapshot thumb (Wave 6 seam): the SAME binary-first
        // step the cloud executor applies — fixed-name path, idempotent
        // on retry. Without this the demo link would capture the
        // snapshot, preview it in compose, then lose the bytes on send.
        const thumb = payload.locationThumb;
        if (thumb) {
          const path = locationThumbPath(payload.projectId, payload.taskId);
          if ((await this.store.getPhoto(path)) === undefined) {
            const blob = await blobs.get(thumb.blobKey);
            if (!blob) throw new Error(`blob-lost:${thumb.blobKey}`);
            await this.store.putPhoto(path, await blobToDataUrl(blob));
          }
        }
      },
      commit: async (row: OutboxRecord) => {
        await this.latency.wait();
        const payload = row.payload as unknown as TaskActionPayload;
        const result = await commitLocal(this.store, row.projectId, payload);
        this.notify();
        return result;
      },
    };
  }

  async countTasks(projectId: string): Promise<number> {
    return this.store.countTasks(projectId);
  }

  /** Admin hard delete: removes the task doc and its entries locally. */
  async deleteTask(projectId: string, taskId: string): Promise<void> {
    if (!this.store.deleteTask) throw new Error('delete-unsupported');
    await this.store.deleteTask(projectId, taskId);
    this.notify();
  }

  /**
   * Idempotent seed: a no-op when the demo store already has task rows.
   * Writes each task + its entries + photo bytes, then pins the
   * per-project counter to `seeds.length` so the next tap-to-create
   * continues the T-number sequence.
   */
  async seed(projectId: string, seeds: DemoTaskSeed[]): Promise<boolean> {
    if ((await this.store.countTasks(projectId)) > 0) return false;
    for (const s of seeds) {
      await this.store.putTask(projectId, s.task);
      for (const e of s.entries) {
        await this.store.putEntry(projectId, s.task.id, e);
      }
      for (const p of s.photos) {
        await this.store.putPhoto(p.storagePath, p.dataUrl);
      }
    }
    await this.store.putCounter(projectId, { next: seeds.length });
    this.notify();
    return true;
  }
}