/**
 * Dexie write hooks: the ONE place local writes to synced tables are noticed
 * (every write site in the apps goes through Dexie tables, so no call site
 * changes). A hook only records what changed; after the writing transaction
 * COMMITS the recorded entries are handed to `onEntries`, which enqueues
 * outbox rows in a fresh transaction (hooks cannot touch tables outside the
 * caller's transaction scope). Writes made by the sync engine itself
 * (`runAsRemote`) are ignored.
 */

import type { ProjectDatabase } from "@ff/data/db/database";

import { isRemoteTransaction } from "./adapter";
import { TABLES, type Row } from "./tables";

export interface HookEntry {
  table: string;
  op: "upsert" | "delete";
  /** Local primary key. */
  localId: string;
  /** The row as the hook saw it (pre-update for updates, the deleted row for deletes). */
  row: Row;
}

export type EntriesHandler = (entries: HookEntry[]) => Promise<void>;

interface TxLike {
  on(name: "complete" | "abort", cb: () => void): void;
}

export function installSyncHooks(
  db: ProjectDatabase,
  onEntries: EntriesHandler,
  onError: (err: unknown) => void,
): () => void {
  const pending = new WeakMap<object, HookEntry[]>();

  const record = (tx: unknown, entry: HookEntry): void => {
    if (!tx || isRemoteTransaction(tx)) return;
    const key = tx as object;
    let list = pending.get(key);
    if (!list) {
      list = [];
      pending.set(key, list);
      const t = tx as TxLike;
      t.on("complete", () => {
        const done = pending.get(key) ?? [];
        pending.delete(key);
        if (done.length > 0) void onEntries(done).catch(onError);
      });
      t.on("abort", () => pending.delete(key));
    }
    list.push(entry);
  };

  const undo: Array<() => void> = [];
  for (const cfg of TABLES) {
    const table = db.table(cfg.table);
    const creating = function (primKey: unknown, obj: Row, tx: unknown): void {
      record(tx, { table: cfg.table, op: "upsert", localId: String(obj.id ?? primKey), row: obj });
    };
    const updating = function (_mods: unknown, primKey: unknown, obj: Row, tx: unknown): void {
      record(tx, { table: cfg.table, op: "upsert", localId: String(primKey), row: obj });
    };
    const deleting = function (primKey: unknown, obj: Row, tx: unknown): void {
      record(tx, { table: cfg.table, op: "delete", localId: String(primKey), row: obj });
    };
    table.hook("creating", creating as never);
    table.hook("updating", updating as never);
    table.hook("deleting", deleting as never);
    undo.push(() => {
      table.hook("creating").unsubscribe(creating as never);
      table.hook("updating").unsubscribe(updating as never);
      table.hook("deleting").unsubscribe(deleting as never);
    });
  }
  return () => undo.forEach((u) => u());
}
