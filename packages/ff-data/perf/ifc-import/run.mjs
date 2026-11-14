#!/usr/bin/env node
// packages/ff-data/perf/ifc-import/run.mjs
//
// IFC IMPORT TIMING HARNESS (wave 61). Imports one IFC in headless
// Chromium, legacy (main thread, 3 web-ifc parses) vs worker (import
// Web Worker, 1 parse), and reports wall time plus main-thread
// blocking during the import: Long Tasks (count / total / max) and the
// largest requestAnimationFrame gap.
//
//   node packages/ff-data/perf/ifc-import/run.mjs \
//     [--file=ARCHITECTURAL.ifc] [--dir=<folder with the IFC>] \
//     [--modes=legacy,worker] [--runs=1] [--prod] [--offline] [--port=5297] [--timeout=600000]
//
// --prod builds the page (vite build) and serves it with vite preview,
// i.e. the production worker bundle. web-ifc's wasm is served locally
// at /web-ifc.wasm (as the app serves its bundled copy). --offline
// aborts every request that is not to the local server, proving the
// import needs no network.
// Playwright: $FF_PLAYWRIGHT_CORE or a resolvable playwright-core.
// Wrap in the shared bench lock when other benchmarks may run.

import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const opt = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] ?? true;
}
const file = opt.file ?? "sample.ifc";
const dir = opt.dir ?? path.resolve(pkgRoot, "../../apps/settings/public/samples");
const modes = (opt.modes ?? "legacy,worker").split(",");
const runs = Number(opt.runs ?? 1);
const port = Number(opt.port ?? 5297);
const timeout = Number(opt.timeout ?? 600000);

function resolvePlaywright() {
  const req = createRequire(path.join(pkgRoot, "package.json"));
  for (const c of [
    process.env.FF_PLAYWRIGHT_CORE,
    "playwright-core",
  ].filter(Boolean)) {
    try {
      const mod = req(req.resolve(c));
      if (mod?.chromium) return mod;
    } catch { /* next */ }
  }
  throw new Error("playwright-core not found — set FF_PLAYWRIGHT_CORE");
}

process.env.FF_IFC_DIR = dir;
const viteReq = createRequire(path.join(pkgRoot, "../../apps/settings/package.json"));
const vite = await import(
  pathToFileURL(path.join(path.dirname(viteReq.resolve("vite/package.json")), "dist/node/index.js")).href
);
const configFile = path.join(here, "vite.config.ts");
let server;
if (opt.prod) {
  await vite.build({ configFile, logLevel: "warn" });
  server = await vite.preview({ configFile, preview: { port, strictPort: true } });
} else {
  server = await vite.createServer({ configFile, server: { port, strictPort: true } });
  await server.listen();
}
const base = `http://127.0.0.1:${port}/`;
const { chromium } = resolvePlaywright();
const results = [];
try {
  for (let r = 0; r < runs; r++) {
    for (const mode of modes) {
      const browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
      try {
        const page = await browser.newPage();
        const external = [];
        if (opt.offline) {
          await page.context().route("**/*", (route) => {
            const u = route.request().url();
            if (u.startsWith(base)) return route.continue();
            external.push(u);
            return route.abort("internetdisconnected");
          });
        }
        page.on("console", (m) => {
          if (m.type() === "error" || m.type() === "warning") console.error(`  [page ${m.type()}] ${m.text()}`);
        });
        page.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
        await page.goto(`${base}?mode=${mode}&file=${encodeURIComponent(file)}`);
        await page.waitForFunction(() => window.__ffImportResult, null, { timeout, polling: 500 });
        const res = await page.evaluate(() => window.__ffImportResult);
        if (opt.offline) res.blockedExternalRequests = external;
        results.push(res);
        console.log(JSON.stringify(res));
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await (server.close?.() ?? server.httpServer?.close?.());
}
process.exit(results.some((r) => r.error) ? 1 : 0);
