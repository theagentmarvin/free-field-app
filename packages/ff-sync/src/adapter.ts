/**
 * Generic Dexie row <-> Firestore doc adapter plus the down-sync apply step.
 * Pure of Firebase: it only sees `RemoteChange`s.
 */

import Dexie from "dexie";
import type { ProjectDatabase } from "@ff/data/db/database";

import { BASE_KEYS, TABLES, type Row, type TableConfig } from "./tables";
import type { RemoteChange, SyncCollectionName } from "./types";

// ── Local writes that must NOT be re-enqueued ───────────────────────

const REMOTE_FLAG = "__ffSyncRemote";

/**
 * Run `fn` in a read-write transaction whose writes are marked as coming
 * from the sync engine (down-sync apply, blob metadata), so the enqueue hooks
 * ignore them.
 */
export function runAsRemote<T>(
  db: ProjectDatabase,
  tableNames: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const tables = tableNames.map((n) => db.table(n));
  return db.transaction("rw", tables, async () => {
    const tx = Dexie.currentTransaction as unknown as Record<string, unknown> | null;
    if (tx) tx[REMOTE_FLAG] = true;
    return fn();
  });
}

export function isRemoteTransaction(tx: unknown): boolean {
  return !!tx && (tx as Record<string, unknown>)[REMOTE_FLAG] === true;
}

// ── Row -> doc ──────────────────────────────────────────────────────

/** Build the doc payload (no base keys) for a local row; throws (zod) if invalid. */
export function toDocData(cfg: TableConfig, row: Row): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...(cfg.defaults ?? {}) };
  for (const [k, v] of Object.entries(row)) {
    if (v !== undefined) doc[k] = v;
  }
  doc.id = cfg.docId(row);
  cfg.shapeDoc?.(row, doc);
  // Parse strips local-only fields (remoteUpdatedAt, updatedAt, ...).
  return cfg.schema.parse(doc);
}

// ── Doc -> row ──────────────────────────────────────────────────────

export function fromDocData(
  cfg: TableConfig,
  docId: string,
  data: Record<string, unknown>,
  updatedAtMs: number,
  localId: string | undefined,
): Row {
  const body: Record<string, unknown> = { ...data };
  for (const k of BASE_KEYS) delete body[k];
  const row: Row = { ...body };
  row.id = localId ?? cfg.newLocalId?.(docId, data) ?? docId;
  row.remoteUpdatedAt = updatedAtMs;
  if (cfg.hasUpdatedAt) row.updatedAt = updatedAtMs;
  return row;
}

// ── Pending outbox ──────────────────────────────────────────────────

const ACTIVE = ["added", "sending", "failed"] as const;

/** `collection/docId` keys with an unsent doc-upsert / doc-delete for this project. */
export async function pendingDocKeys(db: ProjectDatabase, projectId: string): Promise<Set<string>> {
  const rows = await db.outbox.where("state").anyOf([...ACTIVE]).toArray();
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.projectId !== projectId) continue;
    if (r.kind !== "doc-upsert" && r.kind !== "doc-delete") continue;
    const p = r.payload as { collection?: string; docId?: string };
    if (p.collection && p.docId) keys.add(`${p.collection}/${p.docId}`);
  }
  return keys;
}

// ── Apply a snapshot ────────────────────────────────────────────────

export interface ApplyResult {
  upserted: number;
  deleted: number;
  skippedPending: number;
  skippedInvalid: number;
  conflicts: number;
  /** Newest `updatedAt` seen (every delivered change, applied or not). */
  maxUpdatedAtMs: number;
  /**
   * Changes skipped because a local write was queued. The caller re-applies
   * them once the outbox row is sent (so a newer remote write is never lost
   * and our own write's echo still sets `remoteUpdatedAt`).
   */
  deferred: RemoteChange[];
}

/** Tables an apply may touch (transaction scope). */
const APPLY_EXTRA_TABLES = ["outbox", "syncState", "fragBlobs", "pdfBlobs"] as const;

export async function applyChanges(
  db: ProjectDatabase,
  projectId: string,
  collection: SyncCollectionName,
  changes: RemoteChange[],
  cursorKey: string,
): Promise<ApplyResult> {
  const cfg = TABLES.find((t) => t.collection === collection)!;
  const result: ApplyResult = {
    upserted: 0,
    deleted: 0,
    skippedPending: 0,
    skippedInvalid: 0,
    conflicts: 0,
    maxUpdatedAtMs: 0,
    deferred: [],
  };
  if (changes.length === 0) return result;

  await runAsRemote(db, [cfg.table, ...APPLY_EXTRA_TABLES], async () => {
    const table = db.table(cfg.table);
    const pending = await pendingDocKeys(db, projectId);
    for (const ch of changes) {
      result.maxUpdatedAtMs = Math.max(result.maxUpdatedAtMs, ch.updatedAtMs);
      if (pending.has(`${collection}/${ch.id}`)) {
        // A local write is queued: it keeps its local value; the server
        // timestamp decides when it lands (spec §5).
        result.skippedPending += 1;
        result.deferred.push(ch);
        continue;
      }
      const parsed = cfg.schema.safeParse({ ...ch.data, id: ch.data.id ?? ch.id });
      if (!ch.deleted && !parsed.success) {
        result.skippedInvalid += 1;
        continue;
      }
      const local = await findLocalRow(db, cfg, ch.id, ch.data);
      if (ch.deleted) {
        if (local) {
          await deleteLocal(db, cfg, local);
          result.deleted += 1;
        }
        continue;
      }
      if (local && local.remoteUpdatedAt === ch.updatedAtMs) continue; // already applied
      const row = fromDocData(cfg, ch.id, parsed.data!, ch.updatedAtMs, local?.id);
      if (!(await resolveUnique(db, cfg, row))) {
        result.conflicts += 1;
        continue;
      }
      if (cfg.blob) await resolveBlobKeyClash(db, cfg, row);
      await table.put(row);
      result.upserted += 1;
    }
    // Cursor moves in the same transaction as the rows it covers.
    // Deferred changes are not applied yet, so the cursor stops just before
    // the oldest of them: a restart re-delivers them (apply is idempotent).
    const minDeferred = result.deferred.reduce((m, c) => Math.min(m, c.updatedAtMs), Infinity);
    const target = Math.min(result.maxUpdatedAtMs, minDeferred - 1);
    const prev = (await db.syncState.get(cursorKey))?.cursorMs ?? 0;
    if (target > prev) {
      await db.syncState.put({ key: cursorKey, projectId, cursorMs: target });
    }
  });
  return result;
}

async function findLocalRow(
  db: ProjectDatabase,
  cfg: TableConfig,
  docId: string,
  data: Record<string, unknown>,
): Promise<Row | undefined> {
  if (cfg.findLocal) return cfg.findLocal(db, docId, data);
  return (await db.table(cfg.table).get(docId)) as Row | undefined;
}

async function deleteLocal(db: ProjectDatabase, cfg: TableConfig, local: Row): Promise<void> {
  await db.table(cfg.table).delete(local.id as string);
  if (cfg.blob) {
    const key = local[cfg.blob.keyField];
    if (typeof key === "string" && key) {
      await db.table(cfg.blob.kind === "frag" ? "fragBlobs" : "pdfBlobs").delete(key);
    }
  }
}

/**
 * Incoming rows can collide with local unique indexes (two offline devices
 * creating the same name / version number; spec §5 allows duplicate names).
 * `rename` keeps both rows by suffixing the incoming name; `skip` drops the
 * incoming row. Returns false when the row must be skipped.
 */
async function resolveUnique(db: ProjectDatabase, cfg: TableConfig, row: Row): Promise<boolean> {
  const g = cfg.unique;
  if (!g) return true;
  const table = db.table(cfg.table);
  const clash = async (r: Row): Promise<boolean> => {
    const hit = (await table.where(g.index).equals(g.values(r) as never).first()) as Row | undefined;
    return !!hit && hit.id !== r.id;
  };
  if (!(await clash(row))) return true;
  if (g.onConflict === "skip" || !g.nameField) return false;
  const base = String(row[g.nameField]);
  for (let n = 2; n < 1000; n++) {
    row[g.nameField] = `${base} (${n})`;
    if (!(await clash(row))) return true;
  }
  return false;
}

/**
 * Two devices can mint the same local blob key (`{fileId}__v{n}`) for
 * different versions. If the incoming key is already used by another local
 * version, key the incoming blob by its own version id instead.
 */
async function resolveBlobKeyClash(db: ProjectDatabase, cfg: TableConfig, row: Row): Promise<void> {
  const field = cfg.blob!.keyField;
  const key = row[field];
  if (typeof key !== "string" || !key) return;
  const others = (await db.table(cfg.table).toArray()) as Row[];
  if (others.some((o) => o.id !== row.id && o[field] === key)) row[field] = String(row.id);
}

/** Descendant-free helper: rows of a table that are not yet on the server. */
export function isLocalOnly(row: Row): boolean {
  return row.remoteUpdatedAt == null;
}
