// Web Worker entry for the raster diff. Posts "started" once loaded, then
// receives a DiffJobInput (buffers transferred), posts stage updates, then
// the result (buffers transferred back).

import { runDiffJob, type DiffJobInput, type DiffJobOutput, type DiffJobStage } from "./diffJob";

export type CompareWorkerRequest = { type: "run"; input: DiffJobInput };
export type CompareWorkerResponse =
  | { type: "started" }
  | { type: "stage"; stage: DiffJobStage }
  | { type: "done"; output: DiffJobOutput }
  | { type: "error"; message: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<CompareWorkerRequest>) => void) | null;
  postMessage(msg: CompareWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const req = e.data;
  if (!req || req.type !== "run") return;
  try {
    const out = runDiffJob(req.input, (stage) => scope.postMessage({ type: "stage", stage }));
    const transfer = new Set<Transferable>([
      out.base.data.buffer,
      out.revision.data.buffer,
      out.classes.buffer,
    ]);
    scope.postMessage({ type: "done", output: out }, [...transfer]);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

// Boot ack: the client transfers buffers only after seeing this.
scope.postMessage({ type: "started" });
