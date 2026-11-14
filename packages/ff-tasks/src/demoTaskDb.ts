import Dexie, { type Table } from 'dexie';
import type { Task, TaskEntry } from '@ff/firestore';

import {
  DemoTaskSource,
  type DemoTaskStore,
} from './demoTaskSource';

/**
 * Dexie database for the demo (login-free) task store. Deliberately a
 * SEPARATE database from `@ff/data`'s `free-field` DB: the demo data
 * plane must never leak into (or depend on) the cloud-first task tables,
 * and this keeps `@ff/tasks` from importing `@ff/data`. The outbox stays
 * in the app-wide `free-field` DB (the same `makeDexieOutboxStore` the
 * cloud path uses) — only the committed task/entry/counter/photos live here.
 */

export interface DemoTaskRow {
  projectId: string;
  taskId: string;
  updatedAt: number;
  task: Task;
}

export interface DemoTaskEntryRow {
  projectId: string;
  taskId: string;
  entryId: string;
  at: number;
  entry: TaskEntry;
}

export interface DemoTaskCounterRow {
  projectId: string;
  next: number;
}

export interface DemoTaskPhotoRow {
  storagePath: string;
  dataUrl: string;
}

const DEMO_TASK_DB_NAME = 'free-field-demo-tasks';

export class DemoTaskDatabase extends Dexie {
  tasks!: Table<DemoTaskRow, string>;
  entries!: Table<DemoTaskEntryRow, string>;
  counter!: Table<DemoTaskCounterRow, string>;
  photos!: Table<DemoTaskPhotoRow, string>;

  constructor(name: string = DEMO_TASK_DB_NAME) {
    super(name);
    this.version(1).stores({
      tasks: '&taskId, projectId, updatedAt',
      entries: '&entryId, taskId, projectId, at',
      counter: '&projectId',
      photos: '&storagePath',
    });
  }
}

export function makeDemoTaskDexieStore(db: DemoTaskDatabase): DemoTaskStore {
  return {
    async putTask(projectId, task) {
      await db.tasks.put({
        projectId,
        taskId: task.id,
        updatedAt: task.updatedAt,
        task,
      });
    },
    async getTask(taskId) {
      const row = await db.tasks.get(taskId);
      return row?.task;
    },
    async listTasks(projectId) {
      const rows = await db.tasks.where('projectId').equals(projectId).toArray();
      return rows.map((r) => r.task);
    },
    async countTasks(projectId) {
      return db.tasks.where('projectId').equals(projectId).count();
    },
    async putEntry(projectId, taskId, entry) {
      await db.entries.put({
        projectId,
        taskId,
        entryId: entry.id,
        at: entry.at,
        entry,
      });
    },
    async listEntries(_projectId, taskId) {
      const rows = await db.entries.where('taskId').equals(taskId).toArray();
      return rows.map((r) => r.entry);
    },
    async getCounter(projectId) {
      const row = await db.counter.get(projectId);
      return row ? { next: row.next } : undefined;
    },
    async putCounter(projectId, counter) {
      await db.counter.put({ projectId, next: counter.next });
    },
    async putPhoto(storagePath, dataUrl) {
      await db.photos.put({ storagePath, dataUrl });
    },
    async getPhoto(storagePath) {
      const row = await db.photos.get(storagePath);
      return row?.dataUrl;
    },
    async deleteTask(_projectId, taskId) {
      await db.transaction('rw', db.tasks, db.entries, async () => {
        await db.entries.where('taskId').equals(taskId).delete();
        await db.tasks.delete(taskId);
      });
    },
  };
}

let dbInstance: DemoTaskDatabase | null = null;
let sourceInstance: DemoTaskSource | null = null;

/** Lazily-created demo task database (tests can inject their own DB / store). */
export function getDemoTaskDatabase(): DemoTaskDatabase {
  if (!dbInstance) {
    dbInstance = new DemoTaskDatabase();
  }
  return dbInstance;
}

/** Test-only: reset the module singletons. */
export function resetDemoTaskSource(): void {
  sourceInstance = null;
  dbInstance = null;
}

/** Lazily-created singleton demo task source (used by @ff/tasks-react). */
export function getDemoTaskSource(): DemoTaskSource {
  if (!sourceInstance) {
    sourceInstance = new DemoTaskSource({
      store: makeDemoTaskDexieStore(getDemoTaskDatabase()),
    });
  }
  return sourceInstance;
}