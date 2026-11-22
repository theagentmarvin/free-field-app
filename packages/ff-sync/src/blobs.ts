/**
 * Phase 1d blob sync: upload local `.frag` / PDF (optionally IFC) bytes to
 * Storage with a recorded sha256, and lazily download them with
 * verification. All I/O goes through injected ports.
 */

import type { ProjectDatabase } from "@ff/data/db/database";
import {
  BLOB_CONTENT_TYPES,
  BLOB_MAX_BYTES,
  blobStoragePath,
} from "@ff/firestore";

import { runAsRemote } from "./adapter";
import type { Row, TableConfig } from "./tables";
import type {
  BlobHasher,
  BlobReader,
  BlobSink,
  BlobTransport,
  SyncBlobKind,
  SyncEvent,
} from "./types";

/** An error the outbox classifier treats as fatal (retrying cannot help). */
export class SyncFatalError extends Error {
  readonly code = "invalid-argument";
  constructor(message: string) {
    super(message);
    this.name = "SyncFatalError";
  }
}

/** A downloaded blob did not match the sha256 / size on its version doc. */
export class BlobIntegrityError extends Error {
  constructor(
    readonly kind: SyncBlobKind,
    readonly versionId: string,
    detail: string,
  ) {
    super(`blob integrity check failed (${kind} ${versionId}): ${detail}`);
    this.name = "BlobIntegrityError";
  }
}

export const defaultHasher: BlobHasher = async (blob) => {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
};

/** Dexie-backed reader + sink for the web app (fragBlobs / pdfBlobs). */
export function dexieBlobStore(db: ProjectDatabase): { reader: BlobReader; sink: BlobSink } {
  return {
    reader: {
      async get(kind, key) {
        if (kind === "frag") return (await db.fragBlobs.get(key))?.blob ?? null;
        if (kind === "pdf") return (await db.pdfBlobs.get(key))?.bytes ?? null;
        return null; // IFC bytes are not kept locally
      },
    },
    sink: {
      async has(kind, key) {
        if (kind === "frag") return !!(await db.fragBlobs.get(key));
        if (kind === "pdf") return !!(await db.pdfBlobs.get(key));
        return false;
      },
      async put(kind, key, blob) {
        if (kind === "frag") await db.fragBlobs.put({ key, blob });
        else if (kind === "pdf") await db.pdfBlobs.put({ key, bytes: blob });
      },
    },
  };
}

export interface BlobManagerDeps {
  db: ProjectDatabase;
  transport: BlobTransport;
  reader: BlobReader;
  sink: BlobSink;
  hash: BlobHasher;
  emit: (e: SyncEvent) => void;
  /** Also upload original IFC bytes when the reader has them (admin web only). */
  uploadIfc: boolean;
}

/** Field names of the blob groups on a version row, per blob kind. */
const FIELDS = {
  frag: { path: "fragStoragePath", sha: "fragSha256", size: "fragSizeBytes", type: null },
  pdf: { path: "storagePath", sha: "sha256", size: "sizeBytes", type: "contentType" },
  ifc: { path: "storagePath", sha: "sha256", size: "sizeBytes", type: "contentType" },
} as const;

export class BlobManager {
  private inflight = new Map<string, Promise<DownloadOutcome>>();

  constructor(private deps: BlobManagerDeps) {}

  // ── upload ────────────────────────────────────────────────────

  /**
   * Make sure the blob(s) of a version row are in Storage and recorded on the
   * local row (idempotent: a row that already carries its storage path/sha is
   * left alone). Throws on failure (the outbox retries / fails the row).
   */
  async ensureUploaded(projectId: string, cfg: TableConfig, row: Row): Promise<void> {
    if (!cfg.blob) return;
    const kind = cfg.blob.kind;
    const f = FIELDS[kind];
    if (!(row[f.sha] && row[f.path])) {
      const key = String(row[cfg.blob.keyField]);
      const blob = await this.deps.reader.get(kind, key);
      if (!blob) throw new Error(`blob-lost: ${kind} blob ${key} is missing locally`);
      await this.uploadOne(projectId, cfg, row, kind, blob);
    }
    if (kind === "frag" && this.deps.uploadIfc && !row.sha256) {
      const ifc = await this.deps.reader.get("ifc", String(row.id));
      if (ifc) await this.uploadOne(projectId, cfg, row, "ifc", ifc);
    }
  }

  private async uploadOne(
    projectId: string,
    cfg: TableConfig,
    row: Row,
    kind: SyncBlobKind,
    blob: Blob,
  ): Promise<void> {
    const versionId = String(row.id);
    const f = FIELDS[kind];
    if (blob.size > BLOB_MAX_BYTES[kind]) {
      throw new SyncFatalError(`${kind} blob ${versionId} exceeds the ${BLOB_MAX_BYTES[kind]} byte cap`);
    }
    const path = blobStoragePath(projectId, kind, versionId);
    const contentType = BLOB_CONTENT_TYPES[kind][0];
    const sha256 = await this.deps.hash(blob);
    const existing = await this.deps.transport.head(path);
    if (existing) {
      // Objects are immutable: an existing object is fine only if it is ours.
      if (existing.sha256 !== undefined && existing.sha256 !== sha256) {
        throw new SyncFatalError(`${path} already exists with different content`);
      }
      if (existing.sizeBytes !== blob.size) {
        throw new SyncFatalError(`${path} already exists with a different size`);
      }
    } else {
      try {
        await this.deps.transport.upload(path, blob, {
          contentType,
          sha256,
          onProgress: (bytes, total) =>
            this.deps.emit({ type: "blob-progress", kind, versionId, direction: "up", bytes, total }),
        });
      } catch (err) {
        this.deps.emit({ type: "blob-error", kind, versionId, direction: "up", error: String(err) });
        throw err;
      }
    }
    // Record the reference on the local row (never re-enqueued).
    await runAsRemote(this.deps.db, [cfg.table], async () => {
      const table = this.deps.db.table(cfg.table);
      const fresh = (await table.get(versionId)) as Row | undefined;
      if (!fresh) return;
      const patch: Record<string, unknown> = {
        [f.path]: path,
        [f.sha]: sha256,
        [f.size]: blob.size,
      };
      if (f.type) patch[f.type] = contentType;
      await table.update(versionId, patch);
    });
    this.deps.emit({ type: "blob-done", kind, versionId, direction: "up" });
  }

  // ── download ──────────────────────────────────────────────────

  /**
   * Download one version's blob into the sink unless it is already there.
   * Verifies size and sha256 before the sink sees a byte.
   */
  downloadForVersion(cfg: TableConfig, row: Row): Promise<DownloadOutcome> {
    if (!cfg.blob) return Promise.resolve("unavailable");
    const kind = cfg.blob.kind;
    const f = FIELDS[kind];
    const path = row[f.path];
    const sha = row[f.sha];
    const key = row[cfg.blob.keyField];
    if (typeof path !== "string" || typeof sha !== "string" || typeof key !== "string" || !key) {
      return Promise.resolve("unavailable"); // not uploaded yet (or local-only)
    }
    const id = `${kind}:${key}`;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.doDownload(kind, String(row.id), key, path, sha, row[f.size]).finally(() =>
      this.inflight.delete(id),
    );
    this.inflight.set(id, p);
    return p;
  }

  private async doDownload(
    kind: SyncBlobKind,
    versionId: string,
    key: string,
    path: string,
    sha: string,
    size: unknown,
  ): Promise<DownloadOutcome> {
    const { sink, transport, hash, emit } = this.deps;
    if (await sink.has(kind, key)) return "present";
    try {
      if (sink.putFromUrl && transport.getDownloadUrl) {
        // Streaming path: the sink downloads + verifies natively.
        const url = await transport.getDownloadUrl(path);
        await sink.putFromUrl(
          kind,
          key,
          url,
          { sha256: sha, ...(typeof size === "number" ? { sizeBytes: size } : {}) },
          {
            onProgress: (bytes, total) =>
              emit({ type: "blob-progress", kind, versionId, direction: "down", bytes, total }),
          },
        );
        emit({ type: "blob-done", kind, versionId, direction: "down" });
        return "downloaded";
      }
      const blob = await transport.download(path, {
        onProgress: (bytes, total) =>
          emit({ type: "blob-progress", kind, versionId, direction: "down", bytes, total }),
      });
      if (typeof size === "number" && blob.size !== size) {
        throw new BlobIntegrityError(kind, versionId, `size ${blob.size} != ${size}`);
      }
      const actual = await hash(blob);
      if (actual !== sha) throw new BlobIntegrityError(kind, versionId, `sha256 ${actual} != ${sha}`);
      await sink.put(kind, key, blob);
      emit({ type: "blob-done", kind, versionId, direction: "down" });
      return "downloaded";
    } catch (err) {
      emit({ type: "blob-error", kind, versionId, direction: "down", error: String(err) });
      throw err;
    }
  }
}

export type DownloadOutcome = "present" | "downloaded" | "unavailable";
