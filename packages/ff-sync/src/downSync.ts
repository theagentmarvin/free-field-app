/**
 * Down-sync: one listener per synced collection of the current project,
 * filtered by `updatedAt > cursor`. Each snapshot is applied in ONE Dexie
 * transaction (adapter.applyChanges), which also advances the persisted
 * cursor.
 */

import type { ProjectDatabase } from "@ff/data/db/database";

import { applyChanges } from "./adapter";
import { cursorKey, getCursor } from "./syncState";
import { TABLES } from "./tables";
import type { RemoteChange, RemoteDocs, SyncCollectionName, SyncEvent } from "./types";

export interface DownSyncHandle {
  stop(): void;
  /** Resolves when every change delivered so far has been applied. */
  idle(): Promise<void>;
  /** Re-apply changes that were skipped behind a pending local write (call when an outbox row settles). */
  retryDeferred(): Promise<void>;
}

export async function startDownSync(
  db: ProjectDatabase,
  remote: RemoteDocs,
  projectId: string,
  emit: (e: SyncEvent) => void,
): Promise<DownSyncHandle> {
  let stopped = false;
  const unsubs: Array<() => void> = [];
  const chains = new Map<string, Promise<void>>();
  // collection -> docId -> newest skipped change
  const deferred = new Map<string, Map<string, RemoteChange>>();

  const run = (collection: SyncCollectionName, changes: RemoteChange[]): void => {
    const prev = chains.get(collection)!;
    chains.set(
      collection,
      prev.then(async () => {
        if (stopped) return;
        try {
          const r = await applyChanges(db, projectId, collection, changes, cursorKey(projectId, collection));
          const bucket = deferred.get(collection) ?? new Map<string, RemoteChange>();
          for (const ch of changes) bucket.delete(ch.id);
          for (const ch of r.deferred) {
            const old = bucket.get(ch.id);
            if (!old || old.updatedAtMs < ch.updatedAtMs) bucket.set(ch.id, ch);
          }
          deferred.set(collection, bucket);
          emit({
            type: "down-applied",
            collection,
            upserted: r.upserted,
            deleted: r.deleted,
            skippedPending: r.skippedPending,
            skippedInvalid: r.skippedInvalid,
            conflicts: r.conflicts,
          });
        } catch (err) {
          emit({ type: "down-error", collection, error: String(err) });
        }
      }),
    );
  };

  for (const cfg of TABLES) {
    const collection = cfg.collection;
    const cursor = await getCursor(db, projectId, collection);
    chains.set(collection, Promise.resolve());
    const unsub = remote.subscribe(projectId, collection, cursor, {
      onChanges(changes) {
        if (stopped || changes.length === 0) return;
        // Serialized per collection: snapshots must apply in delivery order.
        // A newer delivery of a doc supersedes its deferred older one.
        const bucket = deferred.get(collection);
        for (const ch of changes) bucket?.delete(ch.id);
        run(collection, changes);
      },
      onError(err) {
        if (!stopped) emit({ type: "down-error", collection, error: String(err) });
      },
    });
    unsubs.push(unsub);
  }

  return {
    stop() {
      stopped = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* listener already gone */
        }
      }
    },
    async idle() {
      await Promise.all([...chains.values()]);
    },
    async retryDeferred() {
      for (const [collection, bucket] of deferred) {
        if (bucket.size === 0) continue;
        run(collection as SyncCollectionName, [...bucket.values()]);
      }
      await Promise.all([...chains.values()]);
    },
  };
}
