// src/pipeline/ingestIfc.ts
//
// Framework-agnostic core of the IFC upload pipeline (wave 63). The
// React hook (../hooks/useIfcPipeline.ts) is a thin state wrapper over
// `ingestIfc`; tests drive this directly.
//
//   1. Serialise per file: imports of the same (building, file name)
//      run one after another — across tabs too where the Web Locks API
//      exists — so the second one sees the first one's version (and
//      dedupes against it) instead of racing it.
//   2. ONE web-ifc parse in the import worker (runIfcImport). The
//      worker reads the file, hashes ALL of it (SHA-256) and posts the
//      hash before converting; on loadIfc, a hash equal to the latest
//      version's stops the worker and returns that version.
//   3. Every record is built, then written by appendIfcVersion in ONE
//      transaction, "latest" flipped last.
//   4. First successful import -> navigator.storage.persist().

import { getIfcFile, findIfcFileByName } from "../db/tables/ifcFiles";
import { getLatestVersion } from "../db/tables/ifcVersions";
import {
  appendIfcVersion,
  IfcFileNotFoundError,
} from "../db/appendIfcVersion";
import { requestPersistentStorage } from "../db/database";
import {
  IfcImportAbortedError,
  runIfcImport,
  type RunIfcImportHooks,
} from "../ifc/ifcImportClient";
import {
  PIPELINE_IFC_IMPORT_OPTIONS,
  type IfcImportProgress,
} from "../ifc/ifcImportOptions";

/**
 * Largest local IFC upload accepted before any bytes are read (1 GiB,
 * matching the sync Storage rule). Real project IFCs run to hundreds of
 * MB; this only stops accidents and hostile files from exhausting memory.
 */
export const MAX_IFC_FILE_BYTES = 1024 * 1024 * 1024;

/** Thrown before parsing when a local IFC exceeds MAX_IFC_FILE_BYTES. */
export class IfcTooLargeError extends Error {
  constructor(public readonly fileName: string, public readonly size: number) {
    super(
      `"${fileName}" is too large to import (${Math.round(size / 1048576)} MB; the limit is ${MAX_IFC_FILE_BYTES / 1048576} MB). Split the model or export a lighter IFC.`,
    );
    this.name = "IfcTooLargeError";
  }
}

/** Result of a successful loadIfc / replaceIfcVersion call. */
export interface LoadIfcResult {
  ifcFileId: string;
  versionId: string;
  versionNumber: number;
  storeyCount: number;
  isNewFile: boolean;
}

export type IngestTarget =
  /** loadIfc: the chain keyed by (buildingId, file.name); created if missing. */
  | { kind: "byName"; buildingId: string }
  /** replaceIfcVersion: append to this existing file. */
  | { kind: "byId"; ifcFileId: string };

export interface IngestIfcOptions {
  file: File;
  target: IngestTarget;
  /** Skip the import when the bytes equal the latest version's. */
  dedupe: boolean;
  onProgress?: (p: IfcImportProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam: worker factory / in-thread converter overrides. */
  importHooks?: Pick<RunIfcImportHooks, "createWorker" | "convert">;
}

// ---------- Per-file serialisation ----------

const localLocks = new Map<string, Promise<unknown>>();

interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } })
    .navigator?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Run `fn` exclusively for `key`: queued behind any import of the same
 * key in this tab (and, with Web Locks, in other tabs).
 */
export async function withImportLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = localLocks.get(key) ?? Promise.resolve();
  const locks = webLocks();
  const run = prev
    .catch(() => undefined)
    .then(() =>
      locks ? locks.request(`ff-ifc-import:${key}`, fn) : fn(),
    );
  const tail = run.catch(() => undefined);
  localLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (localLocks.get(key) === tail) localLocks.delete(key);
  }
}

function lockKey(buildingId: string, name: string): string {
  return `${buildingId}\u0000${name}`;
}

// ---------- Ingest ----------

export async function ingestIfc(opts: IngestIfcOptions): Promise<LoadIfcResult> {
  const { file, target } = opts;
  if (file.size > MAX_IFC_FILE_BYTES) throw new IfcTooLargeError(file.name, file.size);

  let buildingId: string;
  let fileName: string;
  if (target.kind === "byId") {
    const rec = await getIfcFile(target.ifcFileId);
    if (!rec) throw new IfcFileNotFoundError(target.ifcFileId);
    buildingId = rec.buildingId;
    // Replace keeps the chain's name, whatever the new file is called.
    fileName = rec.name;
  } else {
    buildingId = target.buildingId;
    fileName = file.name;
  }

  return withImportLock(lockKey(buildingId, fileName), async () => {
    const existing =
      target.kind === "byId"
        ? await getIfcFile(target.ifcFileId)
        : await findIfcFileByName(buildingId, fileName);
    if (target.kind === "byId" && !existing) {
      throw new IfcFileNotFoundError(target.ifcFileId);
    }
    const latest = existing ? await getLatestVersion(existing.id) : undefined;
    const dedupeAgainst = opts.dedupe ? latest : undefined;

    let out;
    try {
      out = await runIfcImport(file, PIPELINE_IFC_IMPORT_OPTIONS, {
        ...opts.importHooks,
        onProgress: opts.onProgress,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onContentHash: dedupeAgainst
          ? (hash) => hash !== dedupeAgainst.contentHash
          : undefined,
      });
    } catch (e) {
      if (
        e instanceof IfcImportAbortedError &&
        e.reason === "duplicate" &&
        existing &&
        dedupeAgainst
      ) {
        return {
          ifcFileId: existing.id,
          versionId: dedupeAgainst.id,
          versionNumber: dedupeAgainst.versionNumber,
          storeyCount: dedupeAgainst.storeyCount,
          isNewFile: false,
        };
      }
      throw e;
    }

    // Uint8Array straight into the Blob (no extra copy of the bytes).
    const fragBlob = new Blob([out.fragBytes as BlobPart], {
      type: "application/octet-stream",
    });

    const res = await appendIfcVersion({
      buildingId,
      fileName,
      ifcFileId: target.kind === "byId" ? target.ifcFileId : undefined,
      ifcFileSize: file.size,
      contentHash: out.contentHash,
      fragBlob,
      storeys: out.parsed.storeys.map((s) => ({
        name: s.name,
        elevation: s.elevation,
        expressId: s.expressId,
        height: s.height,
        containedElementIds: s.containedElementIds,
      })),
      propertyCatalog: out.parsed.propertyCatalog,
    });

    void requestPersistentStorage();

    return {
      ifcFileId: res.file.id,
      versionId: res.version.id,
      versionNumber: res.version.versionNumber,
      storeyCount: res.storeyCount,
      isNewFile: res.isNewFile,
    };
  });
}
