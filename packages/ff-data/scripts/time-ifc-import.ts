// packages/ff-data/scripts/time-ifc-import.ts
//
// IFC import timing + equivalence check (wave 61), under Node.
//
//   legacy : parseIfc() + IfcImporter (parseOnce=false)  — the pre-wave-61
//            pipeline: THREE web-ifc parses (metadata, geometry, properties)
//   single : convertIfc()                                 — ONE parse
//
// Both use the app's importer settings (addAllAttributes +
// addAllRelations, raw: true). The model guid the importer stamps is
// pinned (`id` / `modelGuid`) so the two .frag outputs can be
// compared byte for byte; the extracted metadata is compared deeply.
//
// Usage (from the repo root):
//   pnpm --filter settings exec tsx ../../packages/ff-data/scripts/time-ifc-import.ts \
//     <file.ifc> [--mode=legacy|single|both] [--no-compare]
//
// Prints one JSON line per mode plus a comparison line. Run under the
// shared bench lock when other benchmarks may be running.

import fs from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import * as FRAGS from "@thatopen/fragments";

import { parseIfc, type ParsedIfc } from "../src/ifc/ifcMetadata";
import { convertIfc } from "../src/ifc/convertIfc";
import { setFragmentsWasmPath } from "../src/ifc/webIfcWasm";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const mode = (args.find((a) => a.startsWith("--mode="))?.slice(7) ?? "both") as
  | "legacy"
  | "single"
  | "both";
const compare = !args.includes("--no-compare") && mode === "both";
if (!file) {
  console.error("usage: time-ifc-import.ts <file.ifc> [--mode=legacy|single|both]");
  process.exit(2);
}

// webIfcWasm.ts's Node branch uses a bare `require` (vitest provides
// one); give it the same under tsx ESM.
(globalThis as { require?: NodeRequire }).require ??= createRequire(
  import.meta.url,
);

// Pin the importer's model guid so the outputs are comparable.
const GUID = "00000000-0000-4000-8000-000000000000";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function mb(n: number) {
  return +(n / 2 ** 20).toFixed(1);
}

async function legacy(bytes: Uint8Array) {
  const t0 = performance.now();
  const parsed = await parseIfc(bytes);
  const tParse = performance.now();
  const importer = new FRAGS.IfcImporter();
  setFragmentsWasmPath(importer);
  importer.addAllAttributes();
  importer.addAllRelations();
  const frag = await importer.process({ bytes, raw: true, id: GUID });
  const t1 = performance.now();
  return { parsed, frag, ms: t1 - t0, metadataMs: tParse - t0, parses: 3 };
}

async function single(bytes: Uint8Array) {
  const t0 = performance.now();
  const r = await convertIfc(bytes, { includeAllAttributesAndRelations: true, modelGuid: GUID });
  const t1 = performance.now();
  return {
    parsed: r.parsed,
    frag: r.fragBytes,
    ms: t1 - t0,
    metadataMs: r.metadataMs,
    parses: r.singlePass ? 1 : 2,
  };
}

const bytes = new Uint8Array(fs.readFileSync(file));
const results: Record<string, { parsed: ParsedIfc; frag: Uint8Array }> = {};
for (const m of mode === "both" ? (["legacy", "single"] as const) : [mode]) {
  const rssBefore = process.memoryUsage().rss;
  const r = m === "legacy" ? await legacy(bytes) : await single(bytes);
  results[m] = r;
  console.log(
    JSON.stringify({
      mode: m,
      file: file.split("/").pop(),
      ifcMB: mb(bytes.byteLength),
      ms: Math.round(r.ms),
      metadataMs: Math.round(r.metadataMs),
      webIfcParses: r.parses,
      fragMB: mb(r.frag.byteLength),
      fragSha: sha(r.frag),
      storeys: r.parsed.storeys.length,
      catalog: r.parsed.propertyCatalog.length,
      rssMB: mb(process.memoryUsage().rss),
      rssBeforeMB: mb(rssBefore),
    }),
  );
}
if (compare) {
  const a = results.legacy;
  const b = results.single;
  console.log(
    JSON.stringify({
      fragIdentical:
        a.frag.byteLength === b.frag.byteLength && sha(a.frag) === sha(b.frag),
      metadataIdentical: isDeepStrictEqual(a.parsed, b.parsed),
    }),
  );
}
process.exit(0);
