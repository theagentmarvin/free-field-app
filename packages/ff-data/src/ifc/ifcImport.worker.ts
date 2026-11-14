// src/ifc/ifcImport.worker.ts
//
// IFC import Web Worker: IFC -> .frag + FreeField metadata, off the
// main thread. Spawned per import by ./ifcImportClient.ts (Vite
// `new Worker(new URL(...), { type: "module" })`) and terminated when
// the job ends, so web-ifc's wasm heap for a 480 MB model is released
// with the worker instead of lingering in the page.
//
// web-ifc's wasm: setFragmentsWasmPath() (./webIfcWasm.ts) sees no
// `process` global here, i.e. the browser branch — the app's own
// bundled copy at <origin><BASE_URL>web-ifc.wasm (no CDN, works
// offline).
//
// The worker reads the whole file, hashes it (full-file SHA-256,
// posted as "hashed" before converting) and converts it; the client
// terminates it on a duplicate, abort or timeout.

import { convertIfc } from "./convertIfc";
import {
  isIfcImportRequest,
  runIfcImportJob,
  type IfcImportResponse,
} from "./ifcImportProtocol";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent) => {
  const req = e.data;
  if (!isIfcImportRequest(req)) return;
  void runIfcImportJob(
    req,
    (msg: IfcImportResponse, transfer?: Transferable[]) =>
      scope.postMessage(msg, transfer ?? []),
    convertIfc,
  );
};
