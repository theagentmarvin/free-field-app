/**
 * Up-sync: the generalized outbox. `doc-upsert`, `doc-delete` and
 * `blob-upload` rows share the Dexie `outbox` table and the OutboxEngine of
 * @ff/tasks (same states, retry ladder, network revival). The executor maps a
 * row to one remote operation; every operation is idempotent.
 */

import type { ProjectDatabase } from "@ff/data/db/database";
import { uuid } from "@ff/data/db/uuid";
import type { OutboxExecutor, OutboxStore } from "@ff/tasks";
import type {
  BlobUploadPayload,
  DocDeletePayload,
  DocUpsertPayload,
  OutboxRecord,
  OutboxState,
} from "@ff/types";

import { runAsRemote, toDocData } from "./adapter";
import type { BlobManager } from "./blobs";
import { SyncFatalError } from "./blobs";
import { TABLE_BY_COLLECTION, TABLES, type Row, type TableConfig } from "./tables";
import type { RemoteDocs } from "./types";

export const SYNC_KINDS = ["doc-upsert", "doc-delete", "blob-upload"] as const;
const isSyncRow = (r: OutboxRecord): boolean => (SYNC_KINDS as readonly string[]).includes(r.kind);

/** Outbox store restricted to this project's sync rows (task rows are left alone). */
export function makeSyncOutboxStore(db: ProjectDatabase, projectId: string): OutboxStore {
  const mine = (rows: OutboxRecord[]): OutboxRecord[] =>
    rows.filter((r) => isSyncRow(r) && r.projectId === projectId);
  const sorted = (states: readonly OutboxState[]) =>
    db.outbox.where("state").anyOf([...states]).sortBy("createdAt");
  return {
    async add(row) {
      await db.outbox.put(row);
    },
    async put(row) {
      await db.outbox.put(row);
    },
    async get(id) {
      return db.outbox.get(id);
    },
    async next(states) {
      return mine(await sorted(states))[0];
    },
    async list(states) {
      return mine(await sorted(states));
    },
    async delete(id) {
      await db.outbox.delete(id);
    },
    // Index-only; counts all projects/kinds, so it can only over-count.
    async count(states) {
      return db.outbox.where("state").anyOf([...states]).count();
    },
  };
}

/** Rows sharing a key run in creation order (a doc never overtakes its blob). */
export function syncOrderKey(row: OutboxRecord): string | null {
  const p = row.payload as { docId?: string; versionId?: string };
  const id = row.kind === "blob-upload" ? p.versionId : p.docId;
  return id ? `${row.projectId}:${id}` : null;
}

export interface ExecutorDeps {
  db: ProjectDatabase;
  remote: RemoteDocs;
  blobs: BlobManager;
  uid: string;
}

export function createSyncExecutor(deps: ExecutorDeps): OutboxExecutor {
  return {
    async uploadPhotos() {
      /* no photos on sync rows */
    },
    async commit(row) {
      switch (row.kind) {
        case "doc-upsert":
          return void (await commitUpsert(deps, row.projectId, row.payload as unknown as DocUpsertPayload));
        case "doc-delete": {
          const p = row.payload as unknown as DocDeletePayload;
          return void (await deps.remote.tombstone(row.projectId, p.collection, p.docId, deps.uid));
        }
        case "blob-upload":
          return void (await commitBlob(deps, row.projectId, row.payload as unknown as BlobUploadPayload));
        default:
          throw new SyncFatalError(`unsupported outbox kind ${row.kind}`);
      }
    },
  };
}

async function commitBlob(deps: ExecutorDeps, projectId: string, p: BlobUploadPayload): Promise<void> {
  const cfg = TABLES.find((t) => t.blob?.kind === p.kind);
  if (!cfg) throw new SyncFatalError(`no blob table for kind ${p.kind}`);
  const local = (await deps.db.table(cfg.table).get(p.versionId)) as Row | undefined;
  if (!local) return; // the version was deleted meanwhile
  await deps.blobs.ensureUploaded(projectId, cfg, local);
}

async function commitUpsert(deps: ExecutorDeps, projectId: string, p: DocUpsertPayload): Promise<void> {
  const cfg = TABLE_BY_COLLECTION[p.collection];
  const localId = String((p.data as { id?: unknown }).id ?? p.docId);
  // The payload only names the row; the CURRENT row is what gets written
  // (so a burst of edits costs one write and nothing stale is sent).
  let local = (await deps.db.table(cfg.table).get(localId)) as Row | undefined;
  if (!local) return; // deleted since; its doc-delete row follows
  if (cfg.blob) {
    await deps.blobs.ensureUploaded(projectId, cfg, local);
    local = ((await deps.db.table(cfg.table).get(localId)) as Row | undefined) ?? local;
  }
  if (cfg.versioned) local = await allocateVersionNumber(deps, projectId, cfg, local);
  const data = toDocData(cfg, local);
  if (cfg.keepFromRemote) {
    const existing = await deps.remote.get(projectId, p.collection, p.docId);
    if (existing) for (const f of cfg.keepFromRemote) data[f] = existing.data[f] ?? data[f];
  }
  await deps.remote.upsert(projectId, p.collection, p.docId, data, deps.uid);
}

/**
 * `versionNumber` is final only at drain time. A version already on the
 * server keeps its number. A new one whose number is taken by a sibling the
 * other device wrote first moves to max(server, local) + 1 (local row
 * updated, never re-enqueued).
 *
 * Atomicity: the LOCAL read-modify-write (re-read this row, scan the local
 * siblings, renumber) runs in ONE Dexie rw transaction, so two tabs (or two
 * drains) can never read the same local max and both claim the same number;
 * the second one sees the first one's renumbering and keeps it. The REMOTE
 * half cannot be a Firestore transaction: the client SDK cannot run a query
 * (the sibling list) inside a transaction, and the parent file doc carries no
 * counter (the rules pin its key set). Two DEVICES racing for the same number
 * therefore still resolve at write time: the doc id is the version id, so
 * both docs exist and the loser renumbers on its next edit/drain.
 */
export async function allocateVersionNumber(
  deps: ExecutorDeps,
  projectId: string,
  cfg: TableConfig,
  row: Row,
): Promise<Row> {
  const existing = await deps.remote.get(projectId, cfg.collection, String(row.id));
  if (existing) return row;
  const parentField = cfg.versioned!.parentField;
  const siblings = await deps.remote.listWhere(projectId, cfg.collection, parentField, String(row[parentField]));
  const remoteMax = siblings.reduce((m, s) => Math.max(m, Number(s.versionNumber) || 0), 0);
  return runAsRemote(deps.db, [cfg.table], async () => {
    const table = deps.db.table(cfg.table);
    const current = ((await table.get(String(row.id))) as Row | undefined) ?? row;
    const taken = siblings.some((s) => s.versionNumber === current.versionNumber);
    if (!taken) return current;
    const localRows = (await table
      .where(parentField)
      .equals(String(current[parentField]))
      .toArray()) as Row[];
    const localMax = localRows.reduce((m, r) => Math.max(m, Number(r.versionNumber) || 0), 0);
    const next = Math.max(remoteMax, localMax) + 1;
    await table.update(String(row.id), { versionNumber: next });
    return { ...current, versionNumber: next };
  });
}

// ── Enqueue ─────────────────────────────────────────────────────────

export function newSyncRow(
  projectId: string,
  kind: "doc-upsert" | "doc-delete" | "blob-upload",
  payload: DocUpsertPayload | DocDeletePayload | BlobUploadPayload,
  now: number,
): OutboxRecord {
  const id = uuid();
  return {
    id,
    kind,
    state: "added",
    projectId,
    payload: payload as unknown as Record<string, unknown>,
    photoRefs: [],
    attempts: 0,
    clientGuid: id,
    createdAt: now,
  };
}
