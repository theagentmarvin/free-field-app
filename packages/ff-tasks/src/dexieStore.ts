import type { OutboxRecord, TaskDraftRecord, OutboxState } from "@ff/types";

import type { OutboxStore } from "./outbox";
import type { DraftTable } from "./drafts";

/**
 * Structural adapters from ff-tasks's ports (outbox.ts, drafts.ts) to
 * Dexie tables, without importing Dexie — the app wires
 * `db.outbox` / `db.drafts` from @ff/data and hands the table in.
 * Only the subset of the Dexie API we use is typed.
 */

export interface DexieishTable<T> {
  put(obj: T): Promise<unknown>;
  get(id: string): Promise<T | undefined>;
  delete(id: string): Promise<void>;
  where(field: string): {
    anyOf(values: readonly unknown[]): {
      sortBy(field: string): Promise<T[]>;
      toArray(): Promise<T[]>;
      count?(): Promise<number>;
    };
    equals(value: unknown): { toArray(): Promise<T[]> };
  };
}

/** A row belongs to the task engine unless it is one of the sync kinds. */
const isTaskRow = (r: OutboxRecord): boolean => r.kind === undefined || r.kind === "task-action";

export function makeDexieOutboxStore(outbox: DexieishTable<OutboxRecord>): OutboxStore {
  // The shared `outbox` table also carries the Phase 1c/1d sync kinds; the
  // task engine must never pick those up, so `next` / `list` filter by kind.
  return {
    async add(row) {
      await outbox.put(row);
    },
    async put(row) {
      await outbox.put(row);
    },
    async get(id) {
      return outbox.get(id);
    },
    async next(states: readonly OutboxState[]) {
      const rows = await outbox.where("state").anyOf(states).sortBy("createdAt");
      return rows.find(isTaskRow);
    },
    async list(states: readonly OutboxState[]) {
      return (await outbox.where("state").anyOf(states).sortBy("createdAt")).filter(isTaskRow);
    },
    async delete(id) {
      await outbox.delete(id);
    },
    // Index-only (state index); counts every kind, so it can only over-count.
    async count(states: readonly OutboxState[]) {
      const c = outbox.where("state").anyOf(states);
      return c.count ? c.count() : (await c.toArray()).length;
    },
  };
}

export function makeDexieDraftTable(drafts: DexieishTable<TaskDraftRecord>): DraftTable {
  return {
    async get(id) {
      const row = await drafts.get(id);
      return row ? { id: row.id, draft: row.draft } : undefined;
    },
    async put(row) {
      await drafts.put(row);
    },
    async delete(id) {
      await drafts.delete(id);
    },
    async whereProject(projectId) {
      const rows = await drafts.where("projectId").equals(projectId).toArray();
      return rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt, draft: r.draft }));
    },
  };
}
