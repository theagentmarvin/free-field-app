/**
 * The sync engine: one object per app, `start(projectId)` / `stop()` follow
 * the current project. Headless (no React, no window): Firestore, Storage and
 * blob storage are injected; connectivity is a callback.
 */

import type { ProjectDatabase } from "@ff/data/db/database";
import { OutboxEngine, createOutboxLock, type OutboxClock, type OutboxReachability } from "@ff/tasks";
import type { BlobUploadPayload, DocDeletePayload, DocUpsertPayload } from "@ff/types";

import { BlobManager, dexieBlobStore, defaultHasher, type DownloadOutcome } from "./blobs";
import { startDownSync, type DownSyncHandle } from "./downSync";
import { installSyncHooks, type HookEntry } from "./hooks";
import { countLocalOnly, projectRows, rowBelongsToProject } from "./publish";
import { getPublishState, setPublishState, resetCursors, type PublishState } from "./syncState";
import { TABLE_BY_DEXIE_NAME, TABLES, type Row, type TableConfig } from "./tables";
import {
  createSyncExecutor,
  makeSyncOutboxStore,
  newSyncRow,
  syncOrderKey,
} from "./upSync";
import type {
  BlobHasher,
  BlobReader,
  BlobSink,
  BlobTransport,
  RemoteDocs,
  SyncBlobKind,
  SyncClock,
  SyncEvent,
  SyncListener,
} from "./types";

export interface SyncEngineDeps {
  db: ProjectDatabase;
  remote: RemoteDocs;
  transport: BlobTransport;
  /** uid of the signed-in user (stamped as `updatedBy`). */
  uid: string;
  /** Where local blobs are read from for upload. Default: Dexie fragBlobs/pdfBlobs. */
  reader?: BlobReader;
  /** Where downloaded blobs are written. Default: Dexie fragBlobs/pdfBlobs. Mobile passes its filesystem sink. */
  sink?: BlobSink;
  /** Connectivity probe; while false the up-drain pauses. Default: always online. */
  isOnline?: () => boolean;
  clock?: SyncClock;
  hash?: BlobHasher;
  /** Also upload original `.ifc` bytes when the reader has them (admin web only). Default false. */
  uploadIfc?: boolean;
}

export interface StartOptions {
  /** Admin of the project: may write (enqueue + drain). Members only read. */
  canWrite: boolean;
}

export interface PublishInfo {
  state: PublishState | null;
  /** Local-only buildings (what the prompt names). */
  buildings: number;
  /** Local-only rows in total. */
  rows: number;
}

export interface BuildingDownloadResult {
  downloaded: number;
  present: number;
  unavailable: number;
  failed: Array<{ kind: SyncBlobKind; versionId: string; error: string }>;
}

interface RunContext {
  projectId: string;
  canWrite: boolean;
  publish: PublishState | null;
  armedAt: number;
  outbox: OutboxEngine;
  down: DownSyncHandle | null;
  /**
   * Hint index of queued (state `added`) doc-upserts: coalesce key -> row id.
   * A hit is always re-verified against the row (another tab may have sent
   * it), so a stale entry can never suppress a needed write; a miss only
   * risks a harmless duplicate upsert (the drain writes the current row).
   */
  queuedUpserts: Map<string, string>;
}

const realClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export class SyncEngine {
  private readonly db: ProjectDatabase;
  private readonly clock: SyncClock;
  private readonly blobs: BlobManager;
  private readonly listeners = new Set<SyncListener>();
  private readonly unhook: () => void;
  private ctx: RunContext | null = null;
  private lastStamp = 0;
  private online: () => boolean;

  constructor(private deps: SyncEngineDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? realClock;
    this.online = deps.isOnline ?? (() => true);
    const store = dexieBlobStore(deps.db);
    this.blobs = new BlobManager({
      db: deps.db,
      transport: deps.transport,
      reader: deps.reader ?? store.reader,
      sink: deps.sink ?? store.sink,
      hash: deps.hash ?? defaultHasher,
      emit: (e) => this.emit(e),
      uploadIfc: deps.uploadIfc ?? false,
    });
    this.unhook = installSyncHooks(
      deps.db,
      (entries) => this.handleEntries(entries),
      (err) => this.emit({ type: "down-error", collection: "buildings", error: `enqueue failed: ${String(err)}` }),
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────

  /** Begin syncing `projectId` (stops any previous project first). */
  async start(projectId: string, opts: StartOptions): Promise<void> {
    this.stop();
    const outbox = new OutboxEngine({
      store: makeSyncOutboxStore(this.db, projectId),
      executor: createSyncExecutor({
        db: this.db,
        remote: this.deps.remote,
        blobs: this.blobs,
        uid: this.deps.uid,
      }),
      clock: this.clock as OutboxClock,
      isOnline: () => this.online(),
      // One tab drains this project's sync queue at a time (Web Locks).
      lock: createOutboxLock(`ff-outbox-${projectId}`),
      orderKey: syncOrderKey,
      onStateChange: (row) => {
        void this.emitOutbox();
        // A settled write may unblock remote changes that were held back.
        if (row.state === "sent" || row.state === "killed") void this.ctx?.down?.retryDeferred();
      },
    });
    const ctx: RunContext = { projectId, canWrite: opts.canWrite, publish: null, armedAt: this.clock.now(), outbox, down: null, queuedUpserts: new Map() };
    this.ctx = ctx;

    // Race guard: `stop()` / a newer `start()` replaces `this.ctx` while this
    // call is awaiting. A superseded run must dispose whatever it created,
    // otherwise its listeners leak (React StrictMode double-mount, project
    // switch and role toggle all interleave start/stop like this).
    const stale = (): boolean => this.ctx !== ctx;
    await this.seedQueuedUpserts(ctx);
    if (stale()) return;
    if (opts.canWrite) await this.armPublish(ctx);
    if (stale()) return;
    const down = await startDownSync(this.db, this.deps.remote, projectId, (e) => this.emit(e));
    if (stale()) {
      down.stop();
      return;
    }
    ctx.down = down;
    this.emit({ type: "started", projectId, canWrite: opts.canWrite });
    if (opts.canWrite) {
      await outbox.recoverStale();
      if (stale()) return;
      await outbox.pruneSent().catch(() => 0);
      if (stale()) return;
      void outbox.drain();
    }
    void this.emitOutbox();
  }

  /** Stop listeners and the drain (queued rows stay in the outbox). */
  stop(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    ctx.down?.stop();
    this.emit({ type: "stopped", projectId: ctx.projectId });
  }

  /** Stop and remove the Dexie hooks (tests, app teardown). */
  dispose(): void {
    this.stop();
    this.unhook();
    this.listeners.clear();
  }

  /** Call when connectivity returns: revives network-failed rows and drains. */
  async notifyOnline(): Promise<void> {
    await this.ctx?.outbox.reviveNetworkFailed();
  }

  /** Backend reachability from drain outcomes (see `OutboxReachability`); null before `start`. */
  getReachability(): OutboxReachability | null {
    return this.ctx?.outbox.getReachability() ?? null;
  }

  /** Clear any network backoff and drain now (manual retry). */
  async resumeNow(): Promise<void> {
    await this.ctx?.outbox.resumeNow();
  }

  /** Wake the drain (e.g. after toggling `isOnline` to true). */
  async drain(): Promise<void> {
    await this.ctx?.outbox.drain();
  }

  /** Resolves once the listeners have applied everything delivered so far. */
  async idle(): Promise<void> {
    await this.ctx?.down?.idle();
  }

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get projectId(): string | null {
    return this.ctx?.projectId ?? null;
  }

  // ── first upload ──────────────────────────────────────────────

  async getPublishInfo(): Promise<PublishInfo | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const ps = await getPublishState(this.db, ctx.projectId);
    const c = await countLocalOnly(this.db, ctx.projectId);
    return { state: ps?.state ?? null, buildings: c.buildings, rows: c.rows };
  }

  /** Admin accepted: enqueue every local-only row (and blob) of the project. */
  async publishLocal(): Promise<number> {
    const ctx = this.ctx;
    if (!ctx || !ctx.canWrite) return 0;
    ctx.publish = "published";
    await setPublishState(this.db, ctx.projectId, "published", ctx.armedAt);
    const n = await this.enqueueLocalOnly(ctx);
    void this.emitOutbox();
    return n;
  }

  /** Admin declined: local-only rows stay local; new work still syncs. */
  async declinePublish(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.publish = "declined";
    await setPublishState(this.db, ctx.projectId, "declined", ctx.armedAt);
  }

  /** Force a full re-read of every collection on the next start. */
  async resetCursors(projectId: string): Promise<void> {
    await resetCursors(this.db, projectId);
  }

  // ── blobs (1d) ────────────────────────────────────────────────

  /**
   * Download the blobs of a building's LATEST versions (.frag and PDF) into
   * the sink, verified. Already-present blobs are skipped. Rejections of
   * individual blobs are collected in `failed`, not thrown.
   */
  async downloadBuilding(buildingId: string): Promise<BuildingDownloadResult> {
    const result: BuildingDownloadResult = { downloaded: 0, present: 0, unavailable: 0, failed: [] };
    const jobs: Array<{ cfg: TableConfig; row: Row }> = [];
    const ifcCfg = TABLE_BY_DEXIE_NAME.ifcVersions;
    const pdfCfg = TABLE_BY_DEXIE_NAME.pdfVersions;
    for (const f of await this.db.ifcFiles.where("buildingId").equals(buildingId).toArray()) {
      const versions = (await this.db.ifcVersions.where("ifcFileId").equals(f.id).toArray()) as Row[];
      const latest = versions.find((v) => v.isLatest) ?? versions.sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber))[0];
      if (latest) jobs.push({ cfg: ifcCfg, row: latest });
    }
    for (const f of await this.db.pdfFiles.where("buildingId").equals(buildingId).toArray()) {
      const versions = (await this.db.pdfVersions.where("pdfFileId").equals(f.id).toArray()) as Row[];
      const latest = versions.find((v) => v.isLatest) ?? versions.sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber))[0];
      if (latest) jobs.push({ cfg: pdfCfg, row: latest });
    }
    for (const { cfg, row } of jobs) {
      try {
        tally(result, await this.blobs.downloadForVersion(cfg, row));
      } catch (err) {
        result.failed.push({ kind: cfg.blob!.kind, versionId: String(row.id), error: String(err) });
      }
    }
    return result;
  }

  /**
   * Fetch the blob stored under local key `key` (a version's fragBlobKey /
   * blobKey). True when it is now in the sink. This is the lazy-download
   * entry point (`registerBlobMissHandler`).
   */
  async fetchBlobByKey(kind: SyncBlobKind, key: string): Promise<boolean> {
    const cfg = kind === "frag" ? TABLE_BY_DEXIE_NAME.ifcVersions : kind === "pdf" ? TABLE_BY_DEXIE_NAME.pdfVersions : null;
    if (!cfg?.blob) return false;
    const rows = (await this.db.table(cfg.table).filter((r: Row) => r[cfg.blob!.keyField] === key).toArray()) as Row[];
    const row = rows[0];
    if (!row) return false;
    const outcome = await this.blobs.downloadForVersion(cfg, row);
    return outcome === "present" || outcome === "downloaded";
  }

  /** Counts of unsent sync rows for this project (UI chip). */
  async outboxCounts(): Promise<{ pending: number; failed: number }> {
    const ctx = this.ctx;
    if (!ctx) return { pending: 0, failed: 0 };
    const rows = await makeSyncOutboxStore(this.db, ctx.projectId).list!(["added", "sending", "failed"]);
    return { pending: rows.filter((r) => r.state !== "failed").length, failed: rows.filter((r) => r.state === "failed").length };
  }

  // ── internals ─────────────────────────────────────────────────

  private emit(e: SyncEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a listener must never break the engine */
      }
    }
  }

  private async emitOutbox(): Promise<void> {
    if (this.listeners.size === 0) return;
    const c = await this.outboxCounts().catch(() => null);
    if (c) this.emit({ type: "outbox", ...c });
  }

  private stamp(): number {
    this.lastStamp = Math.max(this.clock.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  /** Decide the first-upload state when a writer opens a project for the first time. */
  private async armPublish(ctx: RunContext): Promise<void> {
    const saved = await getPublishState(this.db, ctx.projectId);
    if (saved) {
      ctx.publish = saved.state;
      ctx.armedAt = saved.armedAt;
      return;
    }
    const c = await countLocalOnly(this.db, ctx.projectId);
    if (c.buildings === 0) {
      // Nothing to prompt about: every future write syncs (stray local-only
      // rows such as folders or viewpoints are published silently).
      ctx.publish = "published";
      await setPublishState(this.db, ctx.projectId, "published", ctx.armedAt);
      if (c.rows > 0) await this.enqueueLocalOnly(ctx);
    } else {
      ctx.publish = "pending";
      await setPublishState(this.db, ctx.projectId, "pending", ctx.armedAt);
      this.emit({ type: "publish-available", projectId: ctx.projectId, buildings: c.buildings, rows: c.rows });
    }
  }

  private async enqueueLocalOnly(ctx: RunContext): Promise<number> {
    let n = 0;
    const rows = await projectRows(this.db, ctx.projectId);
    const entries: HookEntry[] = [];
    for (const [cfg, list] of [...rows].sort((a, b) => a[0].order - b[0].order)) {
      for (const row of list) {
        if (row.remoteUpdatedAt != null) continue;
        entries.push({ table: cfg.table, op: "upsert", localId: String(row.id), row });
      }
    }
    for (const e of entries) n += await this.enqueueEntry(ctx, e, /*checkMembership*/ false);
    return n;
  }

  private isEligible(ctx: RunContext, row: Row): boolean {
    if (row.remoteUpdatedAt != null) return true;
    if (ctx.publish === "published") return true;
    if (ctx.publish === "declined") return typeof row.createdAt === "number" && row.createdAt >= ctx.armedAt;
    return false; // "pending" (undecided) or not yet armed
  }

  private async handleEntries(entries: HookEntry[]): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !ctx.canWrite) return;
    for (const e of entries) await this.enqueueEntry(ctx, e, true);
    void this.emitOutbox();
  }

  /** Enqueue the outbox rows for one change. Returns how many doc rows were queued. */
  private async enqueueEntry(ctx: RunContext, e: HookEntry, checkMembership: boolean): Promise<number> {
    const cfg = TABLE_BY_DEXIE_NAME[e.table];
    if (!cfg) return 0;
    if (!this.isEligible(ctx, e.row)) return 0;
    const docId = cfg.docId(e.row);
    const { projectId, outbox } = ctx;

    if (e.op === "delete") {
      await outbox.enqueueRow(
        newSyncRow(projectId, "doc-delete", { collection: cfg.collection, docId } satisfies DocDeletePayload, this.stamp()),
      );
      return 1;
    }

    if (checkMembership && !(await rowBelongsToProject(this.db, cfg, e.row, projectId))) return 0;
    // Coalesce: an unsent upsert of the same doc already reads the row fresh at drain time.
    const coalesceKey = `${cfg.collection}/${docId}`;
    if (await this.hasQueued(ctx, coalesceKey)) return 0;

    if (cfg.blob && !hasBlobMeta(cfg, e.row)) {
      const f = cfg.blob;
      const payload: BlobUploadPayload = {
        kind: f.kind,
        versionId: String(e.row.id),
        blobKey: String(e.row[f.keyField] ?? ""),
        storagePath: "",
        sha256: "",
        sizeBytes: 0,
        contentType: f.kind === "pdf" ? "application/pdf" : "application/octet-stream",
      };
      // Hash and size are computed at drain time (nothing async runs in a hook).
      await outbox.enqueueRow(newSyncRow(projectId, "blob-upload", payload, this.stamp()));
    }
    const upsert: DocUpsertPayload = { collection: cfg.collection, docId, data: { id: String(e.row.id) } };
    const upsertRow = newSyncRow(projectId, "doc-upsert", upsert, this.stamp());
    ctx.queuedUpserts.set(coalesceKey, upsertRow.id);
    await outbox.enqueueRow(upsertRow);
    return 1;
  }

  /** One scan per start: index the already-queued upserts of this project. */
  private async seedQueuedUpserts(ctx: RunContext): Promise<void> {
    const rows = await this.db.outbox.where("projectId").equals(ctx.projectId).toArray();
    for (const r of rows) {
      if (r.state !== "added" || r.kind !== "doc-upsert") continue;
      const p = r.payload as { collection?: string; docId?: string };
      if (p.collection && p.docId) ctx.queuedUpserts.set(`${p.collection}/${p.docId}`, r.id);
    }
  }

  /** O(1): the hint entry is verified against its (single) outbox row. */
  private async hasQueued(ctx: RunContext, key: string): Promise<boolean> {
    const id = ctx.queuedUpserts.get(key);
    if (!id) return false;
    const row = await this.db.outbox.get(id);
    if (row && row.state === "added") return true;
    ctx.queuedUpserts.delete(key);
    return false;
  }
}

function hasBlobMeta(cfg: TableConfig, row: Row): boolean {
  return cfg.blob!.kind === "frag" ? !!(row.fragSha256 && row.fragStoragePath) : !!(row.sha256 && row.storagePath);
}

function tally(r: BuildingDownloadResult, o: DownloadOutcome): void {
  if (o === "downloaded") r.downloaded += 1;
  else if (o === "present") r.present += 1;
  else r.unavailable += 1;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  return new SyncEngine(deps);
}

export { TABLES };
