// packages/ff-viewer-react/perf-harness/convert.mjs
//
// IFC -> .frag conversion for the navigation perf harness, run under
// Node with the SAME importer settings the app pipeline uses
// (packages/ff-data/src/hooks/useIfcPipeline.ts: addAllAttributes +
// addAllRelations, raw: true). Output bytes are what the viewer's
// getFragBlob() path hands to `fragments.core.load(buffer, { raw: true })`.
//
// Usage (normally driven by run.mjs, which caches by size+mtime):
//   node packages/ff-viewer-react/perf-harness/convert.mjs <in.ifc> <out.frag>
//
// Prints one JSON line on success: { ok, ms, inBytes, outBytes }.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const require = createRequire(path.join(pkgRoot, "package.json"));

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: convert.mjs <in.ifc> <out.frag>");
  process.exit(2);
}

// Resolve from the viewer package so we get the exact installed copy.
const fragsEntry = require.resolve("@thatopen/fragments");
const FRAGS = await import(fragsEntry.replace(/index\.cjs$/, "index.mjs"));
const webIfcDir =
  path.dirname(require.resolve("web-ifc")) + path.sep;

const t0 = performance.now();
const bytes = new Uint8Array(fs.readFileSync(inPath));
const importer = new FRAGS.IfcImporter();
importer.wasm.path = webIfcDir;
importer.wasm.absolute = true;
importer.addAllAttributes();
importer.addAllRelations();
let lastPct = -1;
const out = await importer.process({
  bytes,
  raw: true,
  progressCallback: (p) => {
    const pct = Math.floor((typeof p === "number" ? p : 0) * 10);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stderr.write(`  convert ${path.basename(inPath)}: ${pct * 10}%\n`);
    }
  },
});
const ms = Math.round(performance.now() - t0);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const tmp = `${outPath}.tmp-${process.pid}`;
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, outPath);
console.log(
  JSON.stringify({ ok: true, ms, inBytes: bytes.byteLength, outBytes: out.byteLength }),
);
process.exit(0);
