// Main-thread side of the diff job: runs it in a Web Worker when available
// (buffers transferred), otherwise in-thread (jsdom / old browsers / a worker
// that fails to boot).

import { runDiffJob, type DiffJobInput, type DiffJobOutput, type DiffJobStage } from "./diffJob";
import type { CompareWorkerResponse } from "./compare.worker";

export interface DiffWorkerLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror?: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface RunDiffOptions {
  signal?: AbortSignal;
  onStage?: (s: DiffJobStage) => void;
  /** Override worker creation; return null to force the in-thread path. */
  createWorker?: () => DiffWorkerLike | null;
  /** Wait this long for the worker's "started" message (default 4000 ms). */
  bootTimeoutMs?: number;
}

export const DEFAULT_BOOT_TIMEOUT_MS = 4000;

export function createDiffWorker(): DiffWorkerLike | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./compare.worker.ts", import.meta.url), {
    type: "module",
    name: "ff-compare-diff",
  }) as unknown as DiffWorkerLike;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function detach(w: DiffWorkerLike): void {
  w.onmessage = null;
  w.onerror = null;
  w.onmessageerror = null;
  try {
    w.terminate();
  } catch {
    /* already gone */
  }
}

export async function runDiff(input: DiffJobInput, opts: RunDiffOptions = {}): Promise<DiffJobOutput> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  let worker: DiffWorkerLike | null = null;
  try {
    worker = (opts.createWorker ?? createDiffWorker)();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[compare] worker unavailable, diffing in-thread:", e);
  }
  if (worker) {
    const booted = await boot(worker, opts);
    if (booted) {
      const res = await runInWorker(worker, input, opts);
      if (res) return res;
    }
  }
  return runInThread(input, opts);
}

/** Resolves true on "started"; false on error/timeout (worker terminated); rejects on abort. */
function boot(worker: DiffWorkerLike, opts: RunDiffOptions): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const { signal } = opts;
    let done = false;
    const timer = setTimeout(() => fail(false), opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (abort: boolean) => {
      if (done) return;
      cleanup();
      detach(worker);
      if (abort) reject(abortError());
      else {
        // eslint-disable-next-line no-console
        console.warn("[compare] worker failed to boot, diffing in-thread");
        resolve(false);
      }
    };
    const onAbort = () => fail(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as CompareWorkerResponse | undefined;
      if (done || !msg || msg.type !== "started") return;
      cleanup();
      resolve(true);
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      fail(false);
    };
    worker.onmessageerror = () => fail(false);
  });
}

async function runInThread(input: DiffJobInput, opts: RunDiffOptions): Promise<DiffJobOutput> {
  // Yield once so progress UI can paint before the blocking work.
  await new Promise<void>((r) => setTimeout(r, 0));
  if (opts.signal?.aborted) throw abortError();
  const out = runDiffJob(input, opts.onStage);
  if (opts.signal?.aborted) throw abortError();
  return out;
}

/**
 * Runs the job on a booted worker. Resolves null when the request could not
 * be posted and nothing was transferred (caller falls back in-thread).
 */
function runInWorker(
  worker: DiffWorkerLike,
  input: DiffJobInput,
  opts: RunDiffOptions,
): Promise<DiffJobOutput | null> {
  return new Promise<DiffJobOutput | null>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      detach(worker);
    };
    const fail = (err: Error) => {
      if (settled) return;
      finish();
      reject(err);
    };
    const onAbort = () => fail(abortError());
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent) => {
      if (settled) return;
      const msg = e.data as CompareWorkerResponse;
      if (msg.type === "stage") opts.onStage?.(msg.stage);
      else if (msg.type === "done") {
        finish();
        resolve(msg.output);
      } else if (msg.type === "error") fail(new Error(msg.message));
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      fail(new Error(`Compare worker failed: ${e.message || "worker error"}`));
    };
    worker.onmessageerror = () => fail(new Error("Compare worker: a message could not be deserialised"));
    const transfer = [...new Set<Transferable>([input.base.data.buffer, input.revision.data.buffer])];
    try {
      worker.postMessage({ type: "run", input }, transfer);
    } catch (err) {
      const detached = input.base.data.buffer.byteLength === 0 || input.revision.data.buffer.byteLength === 0;
      if (settled) return;
      finish();
      if (detached) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(null);
    }
  });
}
