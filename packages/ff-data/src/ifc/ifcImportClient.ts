// src/ifc/ifcImportClient.ts
//
// Main-thread side of the IFC import: `runIfcImport(file, options)`
// spawns the import worker, hands it the File (a cheap Blob handle —
// the bytes are read inside the worker), relays progress, and
// resolves with the .frag bytes + metadata + the full-file content
// hash. One worker per import, terminated at the end (frees web-ifc's
// wasm heap).
//
// Fallback to the calling thread (same runIfcImportJob code path)
// when there is no Worker (vitest / Node) or the worker fails to boot
// (error before its "started" ack, e.g. the worker chunk 404s). A
// failure AFTER boot — a bad IFC, wasm OOM — rejects instead: re-running
// a crashed 480 MB conversion on the UI thread would only freeze the
// page and most likely crash again.
//
// The in-thread converter is loaded with a dynamic import(): this
// module is on the app's main-thread import graph (useIfcPipeline), and
// a static import of ./convertIfc would put the IFC parser into the
// main chunk although it only ever runs in the worker.
//
// Cancellation: `hooks.signal` (AbortSignal) and `hooks.timeoutMs`
// terminate the worker and reject with IfcImportAbortedError. The
// in-thread path can't interrupt a running wasm call; it rejects at
// once and drops the late result.

import type { ConvertIfcOptions, IfcImportProgress } from "./ifcImportOptions";
import type { ParsedIfc } from "./ifcMetadata";
import {
  runIfcImportJob,
  type ConvertFn,
  type IfcImportRequest,
  type IfcImportResponse,
  type IfcImportStats,
} from "./ifcImportProtocol";
import { isBrowser } from "./webIfcWasm";

export interface IfcImportOutput {
  fragBytes: Uint8Array;
  parsed: ParsedIfc;
  stats: IfcImportStats;
  /** Full-file SHA-256 (lowercase hex) of the input IFC. */
  contentHash: string;
  /** Where the conversion ran. */
  ranIn: "worker" | "main-thread";
}

/** The subset of `Worker` the client uses (mockable in tests). */
export interface IfcImportWorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror?: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/** Default upper bound for one import (a 480 MB model takes minutes). */
export const DEFAULT_IFC_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunIfcImportHooks {
  onProgress?: (p: IfcImportProgress) => void;
  /**
   * Called with the full-file hash as soon as the bytes are hashed,
   * BEFORE the conversion. Return false to stop: the import rejects
   * with IfcImportAbortedError(reason "duplicate", contentHash).
   */
  onContentHash?: (contentHash: string) => boolean | Promise<boolean>;
  /** Abort the import (worker terminated, IfcImportAbortedError "aborted"). */
  signal?: AbortSignal;
  /**
   * Reject with IfcImportAbortedError("timeout") after this many ms.
   * Default DEFAULT_IFC_IMPORT_TIMEOUT_MS; 0 / Infinity disables.
   */
  timeoutMs?: number;
  /** Override worker creation; return null to force the in-thread path. */
  createWorker?: () => IfcImportWorkerLike | null;
  /** Override the in-thread converter (tests). */
  convert?: ConvertFn;
}

export type IfcImportAbortReason = "aborted" | "timeout" | "duplicate";

/** The import stopped before producing a result (not a parse failure). */
export class IfcImportAbortedError extends Error {
  readonly reason: IfcImportAbortReason;
  /** Set for reason "duplicate". */
  readonly contentHash?: string;
  constructor(reason: IfcImportAbortReason, contentHash?: string) {
    super(
      reason === "timeout"
        ? "IFC import timed out"
        : reason === "duplicate"
          ? "IFC import skipped: identical to the latest version"
          : "IFC import aborted",
    );
    this.name = "IfcImportAbortedError";
    this.reason = reason;
    this.contentHash = contentHash;
  }
}

/** Default factory: a Vite module worker in browsers, null elsewhere. */
export function createIfcImportWorker(): IfcImportWorkerLike | null {
  if (typeof Worker === "undefined" || !isBrowser()) return null;
  return new Worker(new URL("./ifcImport.worker.ts", import.meta.url), {
    type: "module",
    name: "ff-ifc-import",
  }) as unknown as IfcImportWorkerLike;
}

let nextJobId = 1;

class WorkerBootError extends Error {}

/** Shared abort/timeout wiring for both paths; returns the disposer. */
function guard(
  hooks: RunIfcImportHooks,
  onStop: (err: IfcImportAbortedError) => void,
): () => void {
  const { signal } = hooks;
  const timeoutMs = hooks.timeoutMs ?? DEFAULT_IFC_IMPORT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => onStop(new IfcImportAbortedError("timeout")), timeoutMs);
  }
  const onAbort = () => onStop(new IfcImportAbortedError("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  return () => {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
}

export async function runIfcImport(
  source: Blob,
  options: ConvertIfcOptions,
  hooks: RunIfcImportHooks = {},
): Promise<IfcImportOutput> {
  if (hooks.signal?.aborted) throw new IfcImportAbortedError("aborted");
  const jobId = nextJobId++;
  const factory = hooks.createWorker ?? createIfcImportWorker;
  let worker: IfcImportWorkerLike | null = null;
  try {
    worker = factory();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[ifcImport] worker unavailable, converting in-thread:", e);
  }
  if (worker) {
    try {
      return await runInWorker(worker, jobId, source, options, hooks);
    } catch (e) {
      if (!(e instanceof WorkerBootError)) throw e;
      // eslint-disable-next-line no-console
      console.warn("[ifcImport] worker failed to boot, converting in-thread:", e.message);
    }
  }
  return runInThread(jobId, source, options, hooks);
}

function runInWorker(
  worker: IfcImportWorkerLike,
  jobId: number,
  source: Blob,
  options: ConvertIfcOptions,
  hooks: RunIfcImportHooks,
): Promise<IfcImportOutput> {
  return new Promise<IfcImportOutput>((resolve, reject) => {
    let started = false;
    let settled = false;
    let hashCheck: Promise<boolean> | null = null;
    const finishWorker = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      release();
      finishWorker();
      reject(err);
    };
    const release = guard(hooks, fail);
    worker.onmessage = (e: MessageEvent) => {
      if (settled) return;
      const msg = e.data as IfcImportResponse;
      if (!msg || msg.jobId !== jobId) return;
      switch (msg.type) {
        case "started":
          started = true;
          return;
        case "progress":
          hooks.onProgress?.(msg.progress);
          return;
        case "hashed": {
          const check = hooks.onContentHash;
          if (!check) return;
          const hash = msg.contentHash;
          // The worker keeps converting meanwhile; stop it on "no". A
          // "done" that overtakes the check waits for it (below).
          hashCheck = Promise.resolve()
            .then(() => check(hash))
            .then(
              (go) => {
                if (!go) fail(new IfcImportAbortedError("duplicate", hash));
                return go;
              },
              (err) => {
                fail(err instanceof Error ? err : new Error(String(err)));
                return false;
              },
            );
          return;
        }
        case "skipped":
          fail(new IfcImportAbortedError("duplicate", msg.contentHash));
          return;
        case "done": {
          const out: IfcImportOutput = {
            fragBytes: msg.fragBytes,
            parsed: msg.parsed,
            stats: msg.stats,
            contentHash: msg.contentHash,
            ranIn: "worker",
          };
          finishWorker();
          void (hashCheck ?? Promise.resolve(true)).then((go) => {
            if (!go || settled) return;
            settled = true;
            release();
            resolve(out);
          });
          return;
        }
        case "error": {
          const err = new Error(msg.message);
          if (msg.stack) err.stack = msg.stack;
          fail(err);
          return;
        }
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      // Stop the browser from also reporting it as uncaught.
      e.preventDefault?.();
      const detail = e.message || "worker error";
      fail(
        started
          ? new Error(`IFC import worker crashed: ${detail}`)
          : new WorkerBootError(detail),
      );
    };
    worker.onmessageerror = () => {
      fail(new Error("IFC import worker: a message could not be deserialised"));
    };
    const req: IfcImportRequest = { type: "import", jobId, source, options };
    worker.postMessage(req);
  });
}

async function loadConverter(hooks: RunIfcImportHooks): Promise<ConvertFn> {
  if (hooks.convert) return hooks.convert;
  // Lazy: keeps web-ifc + the importer out of the main chunk.
  const mod = await import("./convertIfc");
  return mod.convertIfc;
}

function runInThread(
  jobId: number,
  source: Blob,
  options: ConvertIfcOptions,
  hooks: RunIfcImportHooks,
): Promise<IfcImportOutput> {
  return new Promise<IfcImportOutput>((resolve, reject) => {
    const ctl = new AbortController();
    let settled = false;
    const settle = () => {
      settled = true;
      release();
    };
    const release = guard(hooks, (err) => {
      if (settled) return;
      settle();
      ctl.abort();
      reject(err);
    });
    loadConverter(hooks).then(
      (convert) => {
        if (settled) return;
        void runIfcImportJob(
          { type: "import", jobId, source, options },
          (msg) => {
            if (settled) return;
            if (msg.type === "progress") hooks.onProgress?.(msg.progress);
            else if (msg.type === "done") {
              settle();
              resolve({
                fragBytes: msg.fragBytes,
                parsed: msg.parsed,
                stats: msg.stats,
                contentHash: msg.contentHash,
                ranIn: "main-thread",
              });
            } else if (msg.type === "skipped") {
              settle();
              reject(new IfcImportAbortedError("duplicate", msg.contentHash));
            } else if (msg.type === "error") {
              settle();
              const err = new Error(msg.message);
              if (msg.stack) err.stack = msg.stack;
              reject(err);
            }
          },
          convert,
          { signal: ctl.signal, onHashed: hooks.onContentHash },
        );
      },
      (err) => {
        if (settled) return;
        settle();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
