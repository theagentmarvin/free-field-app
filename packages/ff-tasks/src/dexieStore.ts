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
    };
    equals(value: unknown): { toArray(): Promise<T[]> };
  };
}

export function makeDexieOutboxStore(outbox: DexieishTable<OutboxRecord>): OutboxStore {
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
      return rows[0];
    },
    async list(states: readonly OutboxState[]) {
      return outbox.where("state").anyOf(states).sortBy("createdAt");
    },
    async delete(id) {
      await outbox.delete(id);
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
