import Dexie, { type Table } from 'dexie';
import type { OutboxRecord } from '@ff/types';

/**
 * Durable photo / snapshot bytes for queued task actions (wave 63).
 *
 * Compose registers each photo under a `blobKey`; the outbox row only
 * carries the key. Bytes used to live in a module `Map`, so a reload
 * between compose and send lost them (`blob-lost:`). They are now
 * persisted here, keyed by `blobKey`, and deleted once the row that
 * references them is `sent` or `killed`.
 *
 * Stored as ArrayBuffer + mime rather than a Blob: Blob-in-IndexedDB
 * has been unreliable on older iOS Safari.
 *
 * A separate small database (like the demo task DB) so `@ff/tasks`
 * keeps not depending on `@ff/data`.
 */

export interface TaskBlobRow {
  blobKey: string;
  type: string;
  data: ArrayBuffer;
  createdAt: number;
}

/** The Dexie table subset this module uses (fakeable in tests). */
export interface TaskBlobTable {
  put(row: TaskBlobRow): Promise<unknown>;
  get(blobKey: string): Promise<TaskBlobRow | undefined>;
  bulkDelete(keys: string[]): Promise<unknown>;
  where(index: 'createdAt'): { below(value: number): { primaryKeys(): Promise<string[]> } };
}

export interface TaskBlobStore {
  put(blobKey: string, blob: Blob): Promise<void>;
  get(blobKey: string): Promise<Blob | undefined>;
  delete(blobKeys: readonly string[]): Promise<void>;
  /** Delete blobs older than `olderThan` (epoch ms) that are not in
   *  `keep` — photos of a compose that was never submitted. */
  pruneOrphans(keep: ReadonlySet<string>, olderThan: number): Promise<number>;
}

const TASK_BLOB_DB_NAME = 'free-field-task-blobs';

export class TaskBlobDatabase extends Dexie {
  blobs!: Table<TaskBlobRow, string>;

  constructor(name: string = TASK_BLOB_DB_NAME) {
    super(name);
    this.version(1).stores({ blobs: '&blobKey, createdAt' });
  }
}

async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Response(blob).arrayBuffer();
}

export function makeTaskBlobStore(
  table: TaskBlobTable,
  now: () => number = () => Date.now(),
): TaskBlobStore {
  return {
    async put(blobKey, blob) {
      await table.put({
        blobKey,
        type: blob.type,
        data: await blobBytes(blob),
        createdAt: now(),
      });
    },
    async get(blobKey) {
      const row = await table.get(blobKey);
      return row ? new Blob([row.data], { type: row.type }) : undefined;
    },
    async delete(blobKeys) {
      if (blobKeys.length > 0) await table.bulkDelete([...blobKeys]);
    },
    async pruneOrphans(keep, olderThan) {
      const aged = await table.where('createdAt').below(olderThan).primaryKeys();
      const doomed = aged.filter((k) => !keep.has(k));
      if (doomed.length > 0) await table.bulkDelete(doomed);
      return doomed.length;
    },
  };
}

/** Every blob key an outbox row's upload step reads. */
export function outboxBlobKeys(row: OutboxRecord): string[] {
  const keys: string[] = [];
  for (const ref of row.photoRefs ?? []) if (ref?.blobKey) keys.push(ref.blobKey);
  const thumb = (row.payload as { locationThumb?: { blobKey?: unknown } | null } | undefined)
    ?.locationThumb;
  if (thumb && typeof thumb.blobKey === 'string') keys.push(thumb.blobKey);
  return keys;
}

let blobDb: TaskBlobDatabase | null = null;
let blobStore: TaskBlobStore | null = null;

/** Lazily-created app-wide blob store. */
export function getTaskBlobStore(): TaskBlobStore {
  if (!blobStore) {
    blobDb = new TaskBlobDatabase();
    blobStore = makeTaskBlobStore(blobDb.blobs as unknown as TaskBlobTable);
  }
  return blobStore;
}

/** Test-only: drop the singleton. */
export function resetTaskBlobStore(): void {
  blobStore = null;
  blobDb = null;
}
