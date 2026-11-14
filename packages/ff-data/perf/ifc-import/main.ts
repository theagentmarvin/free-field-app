// packages/ff-data/perf/ifc-import/main.ts
//
// Browser page for the IFC import timing harness (./run.mjs). Imports
// one IFC (served from disk at /__ifc/<name>) either the pre-wave-61
// way — on the main thread, parseIfc() + IfcImporter (3 web-ifc
// parses) — or the wave-61 way — runIfcImport() in the import Web
// Worker (1 parse) — and records main-thread responsiveness while it
// runs: Long Tasks (>50 ms) and the largest requestAnimationFrame gap.
//
// ?mode=legacy|worker&file=<name>   result -> window.__ffImportResult

import * as FRAGS from "@thatopen/fragments";

import { parseIfc } from "../../src/ifc/ifcMetadata";
import { runIfcImport } from "../../src/ifc/ifcImportClient";
import { setFragmentsWasmPath } from "../../src/ifc/webIfcWasm";

const q = new URLSearchParams(location.search);
const mode = q.get("mode") === "legacy" ? "legacy" : "worker";
const file = q.get("file") ?? "sample.ifc";
const logEl = document.getElementById("log")!;
const log = (s: string) => (logEl.textContent += `\n${s}`);

const longTasks: number[] = [];
new PerformanceObserver((l) => {
  for (const e of l.getEntries()) longTasks.push(e.duration);
}).observe({ type: "longtask", buffered: false });

let measuring = false;
let lastFrame = 0;
let maxGap = 0;
let frames = 0;
let slowFrames = 0;
const tick = (t: number) => {
  if (measuring) {
    if (lastFrame) {
      const gap = t - lastFrame;
      maxGap = Math.max(maxGap, gap);
      if (gap > 50) slowFrames++;
    }
    frames++;
    lastFrame = t;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

async function main() {
  const blob = await (await fetch(`/__ifc/${encodeURIComponent(file)}`)).blob();
  log(`fetched ${file} ${(blob.size / 2 ** 20).toFixed(1)} MB, mode=${mode}`);
  await new Promise((r) => setTimeout(r, 300));
  longTasks.length = 0;
  measuring = true;
  const t0 = performance.now();
  let fragBytes = 0;
  let storeys = 0;
  let catalog = 0;
  let extra: Record<string, unknown> = {};
  if (mode === "legacy") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parsed = await parseIfc(bytes);
    const importer = new FRAGS.IfcImporter();
    setFragmentsWasmPath(importer);
    importer.addAllAttributes();
    importer.addAllRelations();
    const out = await importer.process({ bytes, raw: true });
    fragBytes = out.byteLength;
    storeys = parsed.storeys.length;
    catalog = parsed.propertyCatalog.length;
  } else {
    let progressEvents = 0;
    const out = await runIfcImport(
      blob,
      { includeAllAttributesAndRelations: true },
      { onProgress: () => progressEvents++ },
    );
    fragBytes = out.fragBytes.byteLength;
    storeys = out.parsed.storeys.length;
    catalog = out.parsed.propertyCatalog.length;
    extra = { ranIn: out.ranIn, stats: out.stats, progressEvents };
  }
  const ms = performance.now() - t0;
  measuring = false;
  // Let the last long-task entries flush.
  await new Promise((r) => setTimeout(r, 200));
  const result = {
    mode,
    file,
    ms: Math.round(ms),
    fragMB: +(fragBytes / 2 ** 20).toFixed(1),
    storeys,
    catalog,
    longTasks: {
      count: longTasks.length,
      totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
      maxMs: Math.round(Math.max(0, ...longTasks)),
    },
    frames,
    slowFrames,
    maxFrameGapMs: Math.round(maxGap),
    ...extra,
  };
  log(JSON.stringify(result, null, 1));
  (window as unknown as { __ffImportResult: unknown }).__ffImportResult = result;
}

main().catch((e) => {
  log(`ERROR ${e?.stack ?? e}`);
  (window as unknown as { __ffImportResult: unknown }).__ffImportResult = {
    error: String(e?.message ?? e),
  };
});
