// src/ifc/convertIfc.ts
//
// SINGLE-PASS IFC -> .frag conversion + FreeField metadata.
//
// Before (wave 61): one import parsed the IFC THREE times —
//   1. parseIfc()               own IfcAPI: storeys / buildings / catalog
//   2. IfcImporter geometry     its own IfcAPI
//   3. IfcImporter properties   yet another IfcAPI (parseOnce=false default)
// Each parse of the 480 MB ARCHITECTURAL file is many seconds of
// wasm STEP tokenising and a full in-memory copy of the model.
//
// Now: `importer.parseOnce = true` makes the importer keep the
// geometry step's web-ifc model open for the properties step (the
// library documents the output as identical either way), and we
// extract our metadata from THAT SAME open model the moment the
// importer opens it — one parse total.
//
// The importer does not expose its IfcAPI, so the hook is a scoped
// wrapper around `WEBIFC.IfcAPI.prototype.OpenModel`: while a
// conversion is pending, an OpenModel call whose `data` is the exact
// Uint8Array we handed to `importer.process` runs
// `extractIfcMetadata(api, modelID)` right after the open (read-only
// GetLine walk, before any geometry streaming). The wrapper is
// installed only while at least one conversion is in flight and is
// keyed by the bytes' identity, so concurrent conversions in one
// realm can't cross-talk. If the hook never fires (e.g. a future
// library build bundles its own web-ifc copy) we fall back to the
// standalone parseIfc() — correct, just one extra parse — and say so
// in `singlePass: false`.

import * as WEBIFC from "web-ifc";
import * as FRAGS from "@thatopen/fragments";

import { extractIfcMetadata, parseIfc, type ParsedIfc } from "./ifcMetadata";
import { setFragmentsWasmPath } from "./webIfcWasm";
import type { ConvertIfcOptions, IfcImportProgress } from "./ifcImportOptions";

export {
  PIPELINE_IFC_IMPORT_OPTIONS,
  type ConvertIfcOptions,
  type IfcImportProgress,
} from "./ifcImportOptions";

export interface ConvertIfcResult {
  /** Raw (uncompressed) fragments bytes — load with `raw: true`. */
  fragBytes: Uint8Array;
  parsed: ParsedIfc;
  /** True when the metadata came from the importer's own parse. */
  singlePass: boolean;
  /** ms spent in importer.process (includes the metadata walk). */
  convertMs: number;
  /** ms spent in the metadata walk alone. */
  metadataMs: number;
}

// ---------- OpenModel capture ----------

interface Capture {
  done: boolean;
  parsed: ParsedIfc | null;
  error: unknown;
  metadataMs: number;
}

type OpenModelFn = WEBIFC.IfcAPI["OpenModel"];

const pending = new Map<Uint8Array, Capture>();
let originalOpenModel: OpenModelFn | null = null;

function patchedOpenModel(
  this: WEBIFC.IfcAPI,
  data: Uint8Array,
  settings?: WEBIFC.LoaderSettings,
): number {
  const modelID = (originalOpenModel as OpenModelFn).call(this, data, settings);
  const cap = pending.get(data);
  if (cap && !cap.done && modelID >= 0) {
    cap.done = true;
    const t0 = now();
    try {
      cap.parsed = extractIfcMetadata(this, modelID);
    } catch (e) {
      cap.error = e;
    }
    cap.metadataMs = now() - t0;
  }
  return modelID;
}

function beginCapture(bytes: Uint8Array): Capture {
  const cap: Capture = { done: false, parsed: null, error: null, metadataMs: 0 };
  pending.set(bytes, cap);
  if (originalOpenModel === null) {
    const proto = WEBIFC.IfcAPI.prototype;
    originalOpenModel = proto.OpenModel;
    proto.OpenModel = patchedOpenModel;
  }
  return cap;
}

function endCapture(bytes: Uint8Array): void {
  pending.delete(bytes);
  if (pending.size === 0 && originalOpenModel !== null) {
    WEBIFC.IfcAPI.prototype.OpenModel = originalOpenModel;
    originalOpenModel = null;
  }
}

/** Test seam: is the OpenModel wrapper currently installed? */
export function __isOpenModelHookInstalled(): boolean {
  return originalOpenModel !== null;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---------- Conversion ----------

/**
 * Convert IFC bytes to raw .frag bytes AND extract FreeField's
 * metadata, from one web-ifc parse. Runs wherever it is called — the
 * pipeline calls it inside the IFC import Web Worker
 * (./ifcImport.worker.ts) and only falls back to the calling thread
 * when no Worker is available (vitest / Node).
 */
export async function convertIfc(
  bytes: Uint8Array,
  options: ConvertIfcOptions,
  onProgress?: (p: IfcImportProgress) => void,
): Promise<ConvertIfcResult> {
  const importer = new FRAGS.IfcImporter();
  // Same wasm resolution as the pre-worker main-thread path.
  setFragmentsWasmPath(importer);
  if (options.includeAllAttributesAndRelations) {
    // See useIfcPipeline: psets are only reachable through the
    // IsDefinedBy inverse relation, so both calls are needed.
    importer.addAllAttributes();
    importer.addAllRelations();
  }
  // One web-ifc parse inside the importer (geometry model reused for
  // properties) instead of two.
  importer.parseOnce = true;

  const cap = beginCapture(bytes);
  const t0 = now();
  let fragBytes: Uint8Array;
  try {
    fragBytes = await importer.process({
      bytes,
      ...(options.modelGuid ? { id: options.modelGuid } : {}),
      // raw: the viewer loads with raw: true; a compressed buffer
      // throws "Fragments: Malformed fragments data!" there.
      raw: true,
      progressCallback: (p: number, data?: { process?: string }) => {
        if (!onProgress) return;
        const f = typeof p === "number" && Number.isFinite(p) ? p : 0;
        onProgress({
          stage: "converting",
          fraction: Math.min(0.99, 0.05 + 0.94 * Math.max(0, Math.min(1, f))),
          detail: data?.process,
        });
      },
    });
  } finally {
    endCapture(bytes);
  }
  const convertMs = now() - t0;

  if (cap.parsed) {
    return {
      fragBytes,
      parsed: cap.parsed,
      singlePass: true,
      convertMs,
      metadataMs: cap.metadataMs,
    };
  }

  // Fallback: the hook didn't attach (or the walk threw on the
  // importer's model) — parse standalone. Same metadata, extra parse.
  // eslint-disable-next-line no-console
  console.warn(
    "[convertIfc] single-pass metadata capture unavailable; parsing again",
    cap.error ?? "(OpenModel hook not hit)",
  );
  const t1 = now();
  const parsed = await parseIfc(bytes);
  return {
    fragBytes,
    parsed,
    singlePass: false,
    convertMs,
    metadataMs: now() - t1,
  };
}
