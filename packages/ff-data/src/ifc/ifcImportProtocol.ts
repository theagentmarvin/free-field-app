// src/ifc/ifcImportProtocol.ts
//
// Message protocol between the main thread (./ifcImportClient.ts) and
// the IFC import Web Worker (./ifcImport.worker.ts), plus the job
// runner that executes ONE request and reports through `post`.
//
// The runner is environment-agnostic: the worker calls it with
// `self.postMessage`, and the in-thread fallback (no Worker in
// vitest / Node, or the worker failed to boot) calls it with a local
// callback — so both paths share one code path and one set of tests.
//
//   main -> worker   { type: "import", jobId, source, options }
//   worker -> main   { type: "started",  jobId }                 (first message; boot ack)
//                    { type: "progress", jobId, progress }        (throttled: <= ~100 per job)
//                    { type: "hashed",   jobId, contentHash }     (full-file SHA-256, before converting)
//                    { type: "done",     jobId, fragBytes, parsed, stats, contentHash }   (fragBytes' buffer transferred)
//                    { type: "skipped",  jobId, contentHash }     (in-thread only: control.onHashed said stop)
//                    { type: "error",    jobId, message, stack? }
//
// Dedupe: the worker posts "hashed" and carries on converting; the
// client terminates it if the hash matches the latest version (a few
// ms of wasted work, no round trip). The in-thread runner instead
// asks `control.onHashed` and stops before converting.
//
// `source` is the user's File/Blob (structured-clone of a Blob is a
// cheap handle — the 480 MB IFC is materialised INSIDE the worker,
// never on the main thread) or an ArrayBuffer (transferred).

import type { ParsedIfc } from "./ifcMetadata";
import type { ConvertIfcResult } from "./convertIfc";
import type { ConvertIfcOptions, IfcImportProgress } from "./ifcImportOptions";
import { computeFullContentHash } from "../db/files/hash";

export interface IfcImportRequest {
  type: "import";
  jobId: number;
  source: Blob | ArrayBuffer;
  options: ConvertIfcOptions;
}

export interface IfcImportStats {
  /** Bytes of the input IFC. */
  ifcBytes: number;
  /** ms to materialise the input bytes (Blob.arrayBuffer). */
  readMs: number;
  /** ms for the full-file SHA-256. */
  hashMs: number;
  /** ms in the importer (geometry + properties + metadata walk). */
  convertMs: number;
  /** ms in the metadata walk alone. */
  metadataMs: number;
  /** One web-ifc parse for frag + metadata (false = fallback 2nd parse). */
  singlePass: boolean;
}

export type IfcImportResponse =
  | { type: "started"; jobId: number }
  | { type: "progress"; jobId: number; progress: IfcImportProgress }
  | { type: "hashed"; jobId: number; contentHash: string }
  | { type: "skipped"; jobId: number; contentHash: string }
  | {
      type: "done";
      jobId: number;
      fragBytes: Uint8Array;
      parsed: ParsedIfc;
      stats: IfcImportStats;
      contentHash: string;
    }
  | { type: "error"; jobId: number; message: string; stack?: string };

export type PostFn = (msg: IfcImportResponse, transfer?: Transferable[]) => void;

export type ConvertFn = (
  bytes: Uint8Array,
  options: ConvertIfcOptions,
  onProgress?: (p: IfcImportProgress) => void,
) => Promise<ConvertIfcResult>;

export function isIfcImportRequest(v: unknown): v is IfcImportRequest {
  if (!v || typeof v !== "object") return false;
  const m = v as Partial<IfcImportRequest>;
  return (
    m.type === "import" &&
    typeof m.jobId === "number" &&
    m.source !== undefined &&
    m.source !== null &&
    typeof m.options === "object" &&
    m.options !== null
  );
}

/**
 * Wrap a progress sink so it only forwards when the stage changes or
 * the whole-percent value moves — the importer calls back per IFC
 * class, which would otherwise flood postMessage + React renders.
 */
export function throttleProgress(
  sink: (p: IfcImportProgress) => void,
): (p: IfcImportProgress) => void {
  let lastStage = "";
  let lastPct = -1;
  return (p) => {
    const pct = Math.floor(p.fraction * 100);
    if (p.stage === lastStage && pct === lastPct) return;
    lastStage = p.stage;
    lastPct = pct;
    sink(p);
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** In-thread only: cancellation + the dedupe decision. */
export interface IfcImportJobControl {
  /** Stop between steps once aborted (posts nothing further). */
  signal?: AbortSignal;
  /**
   * Called with the full-file hash before converting. Return false to
   * stop: the runner posts "skipped" instead of converting.
   */
  onHashed?: (contentHash: string) => boolean | Promise<boolean>;
}

/** Execute one import request; never throws (errors are posted). */
export async function runIfcImportJob(
  req: IfcImportRequest,
  post: PostFn,
  convert: ConvertFn,
  control: IfcImportJobControl = {},
): Promise<void> {
  const { jobId } = req;
  const { signal } = control;
  try {
    post({ type: "started", jobId });
    const progress = throttleProgress((p) =>
      post({ type: "progress", jobId, progress: p }),
    );
    progress({ stage: "reading", fraction: 0 });

    const t0 = nowMs();
    const buffer =
      req.source instanceof ArrayBuffer
        ? req.source
        : await req.source.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const readMs = nowMs() - t0;
    if (signal?.aborted) return;

    // Full-file hash: the bytes are in memory anyway (web-ifc needs
    // them all), so this costs one native SHA-256 pass.
    const t1 = nowMs();
    const contentHash = await computeFullContentHash(bytes);
    const hashMs = nowMs() - t1;
    post({ type: "hashed", jobId, contentHash });
    if (control.onHashed && !(await control.onHashed(contentHash))) {
      post({ type: "skipped", jobId, contentHash });
      return;
    }
    if (signal?.aborted) return;
    progress({ stage: "converting", fraction: 0.05 });

    const res = await convert(bytes, req.options, progress);
    if (signal?.aborted) return;
    progress({ stage: "done", fraction: 1 });

    const stats: IfcImportStats = {
      ifcBytes: bytes.byteLength,
      readMs,
      hashMs,
      convertMs: res.convertMs,
      metadataMs: res.metadataMs,
      singlePass: res.singlePass,
    };
    post(
      {
        type: "done",
        jobId,
        fragBytes: res.fragBytes,
        parsed: res.parsed,
        stats,
        contentHash,
      },
      [res.fragBytes.buffer as ArrayBuffer],
    );
  } catch (e) {
    if (signal?.aborted) return;
    const err = e instanceof Error ? e : new Error(String(e));
    post({ type: "error", jobId, message: err.message, stack: err.stack });
  }
}
