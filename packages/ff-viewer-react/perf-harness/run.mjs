#!/usr/bin/env node
// packages/ff-viewer-react/perf-harness/run.mjs
//
// FreeField viewer NAVIGATION PERF BENCHMARK.
//
// Mounts the real <IfcViewer> (perf-harness/main.tsx) in headed
// Chromium on the real GPU, loads a scenario's models, waits for the
// load + wave-38/44 warm pump to settle, frames all models, then runs
// scripted navigation phases and measures them:
//
//   idle  (static camera)        --idle-ms   (default 2000)
//   orbit (left-drag strokes)    --orbit-ms  (default 10000)
//   pan   (right-drag Lissajous) --pan-ms    (default 5000)
//   zoom  (wheel in/out)         --zoom-ms   (default 5000; --zoom-notch-ms=150 between
//                                 wheel notches; equal notch counts in and out)
//
// Per phase: rAF frame-time distribution (mean FPS, p50/p95/p99/max,
// frames >50 ms), long tasks, per-frame render()s / draw calls /
// triangles (all renders of the frame, summed), JS heap, scene stats.
// Then an EXTRA (unmeasured) orbit pass under the CDP sampling
// profiler -> <out>/<stamp>-orbit.cpuprofile + top-25 self time.
//
// USAGE
//   node packages/ff-viewer-react/perf-harness/run.mjs [options]
//
//   --scenario=primary   MECHANICAL + SZA_BDE3_ARQ_C1 + STRUCTURAL_VDC_SM_GUID (default)
//              heavy     primary + ARCHITECTURAL (480 MB IFC)
//              alt       MODELO_INTEGRADO_CHIMENEA + STRUCTURAL_VDC
//              small     STRUCTURAL_VDC only (smoke test)
//              pick-after-load  primary models, ONLY the pick-after-load gate
//   PICK-AFTER-LOAD GATE (runs after the nav runs whenever MECHANICAL is in the
//   model list; --no-pick-gate to skip, --gate=pick to run it alone):
//     fresh load; clock starts at the `gate-lift` breadcrumb (loading overlay
//     lifts; the warm pump is NOT awaited). Real left clicks at t = 0,1,2,5,10 s
//     (--pick-slots=0,1,2,5,10) on calibrated targets (MEP duct, pipe, fitting,
//     equipment + one structural member; screen points = projected bbox centres
//     verified by the worker raycast on a warmed viewer at the framed pose,
//     cached in <cache-dir>/pickplan-*.json; --recalibrate to redo). Per click:
//     selection resolved? (onSelectionChange, latency), highlight tint visible?
//     (pixel readback at the click point vs. the pre-click colour). Targets
//     still lacking a pick/tint are re-clicked every --pick-tail-every (5000) ms
//     up to --pick-tail-ms (60000). --pick-timeout (2000), --pick-hl-watch (800).
//   --load-only          LOAD TIMELINE only (no nav phases, no pick gate): per run, a
//                        fresh page loads the scenario and the report prints, per
//                        model, when each load step ended (ms since navigation):
//                        blob (getFragBlob resolved) / buffer (arrayBuffer) / parsed
//                        (fragments.core.load) / pushed (initial core.update(true))
//                        / first tiles in the scene; then all-first-tiles, gate-lift
//                        (overlay lifts), lod-armed, lod-settle, idle. With
//                        --load-profile a CDP sampling profile of the main thread
//                        covers navigation -> ready (<out>/<stamp>-load.cpuprofile).
//   --trace              (with --load-only) print the page's stream trace (~1/s: tile
//                        requests queued on main / tiles in scene / busy models).
//                        Every load run also reports VIEW-COMPLETE: the first moment
//                        every model is idle (no view pass sweeping, no queued
//                        tile request) for >= 500 ms = the current view is fully drawn.
//   --thread-busy        (with --load-only) Chrome trace of the load: % busy per 1 s for the
//                        renderer main thread, each worker and the GPU main thread
//   --exp=idb            (with --load-only or any mode) read the frags from IndexedDB like
//                        the app's Dexie `fragBlobs` path (seeded per browser first)
//                        instead of over HTTP from the harness server
//   --warm               WARM reload: a persistent browser profile loads the scenario once
//                        (fills the viewer's IndexedDB tile cache), then the measured load
//                        runs in the same profile. --warm-settle=MS waits after the
//                        priming load (default 4000) so background cache writes land.
//   --models=a.ifc,b.ifc override the scenario's model list
//   --runs=N             fresh browser per run; summary reports run-to-run spread (default 1)
//   --drive=pointer|controls|both
//                        pointer = real input events via CDP (default; exercises
//                        app-side listeners); controls = camera-controls API calls
//   --exp=a,b,k:v        experiment flags -> page URL ?exp=..., readable in viewer
//                        code as globalThis.__ffPerfExp (Map). Built-in page
//                        experiments: pr:<pixelRatio>, maxrate:<ms>. See exp.ts.
//   --mode=dev|prod      vite dev server (default, = how the app is run day to day)
//                        or a production build served by vite preview
//   --uncapped           --disable-gpu-vsync --disable-frame-rate-limit (FPS above 60).
//                        Use this (and the rCPU ms column = CPU time inside
//                        WebGLRenderer.render() per frame) to measure speedups;
//                        capped numbers saturate at the display refresh.
//   --no-profile         skip the CPU-profiled orbit pass
//   --rod-check          render-on-demand check after the nav phases: per step (rest, click,
//                        hide/show model, section plane, resize) wait --rod-wait (3000) ms, then
//                        idle renders/s + CPU and a presented-vs-fresh frame diff (stale picture?)
//                        exp renderalways = A/B against per-frame rendering; rodhb:<ms>, rodka:<ms>
//   --shots              screenshots per moving phase: at rest + mid-motion (<out>/<stamp>-<label>-<phase>-*.png)
//   --shot-settle=MS     wait before the at-rest shot (default 1500)
//   --strict             mount under React.StrictMode (like the app's dev entry)
//   --settle-cap=MS      cap for the warm-pump wait (default 150000)
//   --label=TEXT         free-form tag stored in the JSON
//   --cache-dir=DIR      .frag cache (default $FF_PERF_DIR/perf-cache or
//                        ~/.cache/ff-perf-harness/perf-cache)
//   --out-dir=DIR        results (default $FF_PERF_DIR/perf-results or
//                        ~/.cache/ff-perf-harness/perf-results)
//   --chrome-arg=--flag  extra Chromium flag (repeatable), e.g. --chrome-arg=--use-angle=gl
//   --executable=PATH    Chromium binary (default: Playwright's bundled chromium)
//   --allow-software     do not abort on SwiftShader / llvmpipe
//   --headless           (discouraged — usually lands on SwiftShader)
//   --keep-open          leave the browser open at the end (debugging)
//
// Playwright: resolved from $FF_PLAYWRIGHT_CORE, the repo's node_modules,
// or a known global install (see resolvePlaywright()). Needs a display
// ($DISPLAY or $WAYLAND_DISPLAY).
//
// Conversion: IFC -> .frag runs in Node (convert.mjs, same importer
// options as the app pipeline) and is cached by file name+size+mtime+
// fragments version. Conversion time is reported separately.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const pkgRequire = createRequire(path.join(pkgRoot, "package.json"));

// ── Args ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { chromeArgs: [] };
let SHOT_PREFIX = "shot";
for (const a of argv) {
  if (a === "--help" || a === "-h") {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(src.split("\n").filter((l) => l.startsWith("//")).slice(0, 90).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
  }
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`unknown arg ${a}`); process.exit(2); }
  const [, k, v] = m;
  if (k === "chrome-arg") opt.chromeArgs.push(v);
  else opt[k] = v === undefined ? true : v;
}
// Directory holding the IFC files used by the scenarios (override with FF_PERF_IFC_DIR).
const TEST_FILES_DIR = process.env.FF_PERF_IFC_DIR ?? "./test-files";
const SCENARIOS = {
  primary: [
    path.join(TEST_FILES_DIR, "MECHANICAL.ifc"),
    path.join(TEST_FILES_DIR, "SZA_BDE3_ARQ_C1.ifc"),
    path.join(TEST_FILES_DIR, "STRUCTURAL_VDC_SM_GUID.ifc"),
  ],
  heavy: [
    path.join(TEST_FILES_DIR, "MECHANICAL.ifc"),
    path.join(TEST_FILES_DIR, "SZA_BDE3_ARQ_C1.ifc"),
    path.join(TEST_FILES_DIR, "STRUCTURAL_VDC_SM_GUID.ifc"),
    path.join(TEST_FILES_DIR, "ARCHITECTURAL.ifc"),
  ],
  alt: [
    path.join(TEST_FILES_DIR, "MODELO_INTEGRADO_CHIMENEA-22.07.2026 (1).ifc"),
    path.join(TEST_FILES_DIR, "STRUCTURAL_VDC.ifc"),
  ],
  small: [path.join(TEST_FILES_DIR, "STRUCTURAL_VDC.ifc")],
};
SCENARIOS["pick-after-load"] = SCENARIOS.primary;
const scenario = opt.scenario ?? "primary";
const modelPaths = opt.models ? String(opt.models).split(",") : SCENARIOS[scenario];
// What to run: nav phases and/or the pick-after-load gate.
const gateOnly = scenario === "pick-after-load" || opt.gate === "pick";
const loadOnly = !!opt["load-only"];
const doNav = !gateOnly && !loadOnly;
const doPickGate = !loadOnly && (gateOnly || (opt["pick-gate"] !== "0" && opt["no-pick-gate"] !== true && modelPaths.some((p) => /MECHANICAL/i.test(p))));
if (!modelPaths) { console.error(`unknown scenario ${scenario}`); process.exit(2); }
const runs = Number(opt.runs ?? 1);
const drive = opt.drive ?? "pointer";
const mode = opt.mode ?? "dev";
const PH = {
  idle: Number(opt["idle-ms"] ?? 2000),
  orbit: Number(opt["orbit-ms"] ?? 10000),
  pan: Number(opt["pan-ms"] ?? 5000),
  zoom: Number(opt["zoom-ms"] ?? 5000),
};
const VIEWPORT = { width: 1600, height: 900 };
const baseDir = process.env.FF_PERF_DIR ?? path.join(os.homedir(), ".cache/ff-perf-harness");
const cacheDir = path.resolve(opt["cache-dir"] ?? path.join(baseDir, "perf-cache"));
const outDir = path.resolve(opt["out-dir"] ?? path.join(baseDir, "perf-results"));
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const log = (...a) => console.error("[perf]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. IFC -> .frag (cached) ───────────────────────────────────
function fragsVersion() {
  const p = path.join(path.dirname(pkgRequire.resolve("@thatopen/fragments")), "..", "package.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).version;
}
function slug(s) {
  return s.replace(/\.ifc$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}
async function ensureFrag(ifcPath) {
  const st = fs.statSync(ifcPath);
  const key = `${slug(path.basename(ifcPath))}-${st.size}-${Math.round(st.mtimeMs)}-f${fragsVersion()}.frag`;
  const fragPath = path.join(cacheDir, key);
  const metaPath = `${fragPath}.json`;
  if (fs.existsSync(fragPath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { key, ifcPath, cached: true, ...meta };
  }
  log(`converting ${path.basename(ifcPath)} (${(st.size / 2 ** 20).toFixed(1)} MB) ...`);
  const res = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--max-old-space-size=6144", path.join(here, "convert.mjs"), ifcPath, fragPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop())) : reject(new Error(`convert failed (${code}) for ${ifcPath}`))));
  });
  const meta = { convertMs: res.ms, ifcBytes: res.inBytes, fragBytes: res.outBytes };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return { key, ifcPath, cached: false, ...meta };
}

// ── 2. Playwright ──────────────────────────────────────────────
function resolvePlaywright() {
  const candidates = [
    process.env.FF_PLAYWRIGHT_CORE,
    "playwright-core",
    "playwright",
  ].filter(Boolean);
  for (const c of candidates) {
    for (const base of [path.join(repoRoot, "package.json"), path.join(pkgRoot, "package.json")]) {
      try {
        const req = createRequire(base);
        const mod = req(req.resolve(c));
        if (mod?.chromium) return { mod, from: req.resolve(c) };
      } catch { /* next */ }
    }
  }
  throw new Error("playwright-core not found — set FF_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core");
}

// ── 3. Vite ────────────────────────────────────────────────────
async function startServer() {
  process.env.FF_PERF_FRAG_DIR = cacheDir;
  process.env.FF_PERF_BUILD_DIR = path.join(cacheDir, "..", "perf-build");
  const vitePkg = pkgRequire.resolve("vite/package.json");
  const vite = await import(pathToFileURL(path.join(path.dirname(vitePkg), "dist/node/index.js")).href);
  const configFile = path.join(here, "vite.config.ts");
  if (mode === "prod") {
    const t = Date.now();
    // Build in a child process with a bigger heap (the bundle graph
    // OOMs Node's default ~2 GB heap).
    await new Promise((resolve, reject) => {
      const bin = path.join(path.dirname(vitePkg), "bin/vite.js");
      const p = spawn(process.execPath, ["--max-old-space-size=6144", bin, "build", "--config", configFile, "--mode", "production", "--logLevel", "error"], {
        stdio: ["ignore", "inherit", "inherit"], env: process.env,
      });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`vite build failed (${code})`))));
    });
    log(`prod build ${Date.now() - t} ms`);
    const server = await vite.preview({ configFile, preview: { port: 5299, strictPort: false } });
    return { url: server.resolvedUrls.local[0], close: () => new Promise((r) => server.httpServer.close(r)) };
  }
  const server = await vite.createServer({ configFile, server: { port: 5199, strictPort: false } });
  await server.listen();
  return { url: server.resolvedUrls.local[0], close: () => server.close() };
}

// ── 4. Navigation drivers ──────────────────────────────────────
async function pointerDrive(page, kind, ms) {
  const r = await page.evaluate(() => window.__perf.canvasRect());
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const t0 = Date.now();
  const el = () => (Date.now() - t0) / 1000;
  const tick = async (t) => {
    const spent = Date.now() - t;
    if (spent < 16) await sleep(16 - spent);
  };
  if (kind === "orbit") {
    // Repeated left-drag strokes in one direction: 400 px over 1.6 s
    // (~100 deg/s azimuth) with a small vertical wobble; release, re-press.
    const strokeS = 1.6, span = 400;
    while (el() * 1000 < ms) {
      const sx = cx - span / 2;
      await page.mouse.move(sx, cy);
      await page.mouse.down({ button: "left" });
      const ts = Date.now();
      for (;;) {
        const t = Date.now();
        const f = Math.min(1, (t - ts) / 1000 / strokeS);
        const y = cy + 40 * Math.sin(2 * Math.PI * f);
        await page.mouse.move(sx + span * f, y);
        if (f >= 1 || el() * 1000 >= ms) break;
        await tick(t);
      }
      await page.mouse.up({ button: "left" });
    }
  } else if (kind === "pan") {
    // One right-drag Lissajous around the centre (model stays in view).
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    while (el() * 1000 < ms) {
      const t = Date.now();
      const s = el();
      await page.mouse.move(cx + 220 * Math.sin((2 * Math.PI * s) / 2.5), cy + 120 * Math.sin((2 * Math.PI * s) / 1.7));
      await tick(t);
    }
    await page.mouse.up({ button: "right" });
  } else if (kind === "zoom") {
    // Mouse-wheel notches (deltaY 100) every --zoom-notch-ms (150) at the
    // centre: N notches in, then the same N out (count-based, so the net
    // dolly is ~zero whatever the frame rate), N = 1.25 s worth.
    const notchMs = Number(opt["zoom-notch-ms"] ?? 150);
    const perHalf = Math.max(1, Math.round(1250 / notchMs));
    await page.mouse.move(cx, cy);
    let n = 0;
    while (el() * 1000 < ms || n % (2 * perHalf) !== 0) {
      const t = Date.now();
      const dir = Math.floor(n / perHalf) % 2 === 0 ? -1 : 1;
      await page.mouse.wheel(0, 100 * dir);
      n++;
      const spent = Date.now() - t;
      if (spent < notchMs) await sleep(notchMs - spent);
    }
  } else if (kind === "idle") {
    await sleep(ms);
  }
}

// Main-thread CPU per phase from CDP Performance.getMetrics
// (TaskDuration = all renderer-main-thread task time, ScriptDuration = JS).
const cdpByPage = new WeakMap();
async function cpuMetrics(page) {
  let cdp = cdpByPage.get(page);
  if (!cdp) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    cdpByPage.set(page, cdp);
  }
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { t: Date.now(), task: m.TaskDuration ?? 0, script: m.ScriptDuration ?? 0 };
}
function cpuDelta(a, b) {
  const wall = (b.t - a.t) / 1000;
  return {
    taskPct: +((100 * (b.task - a.task)) / wall).toFixed(1),
    scriptPct: +((100 * (b.script - a.script)) / wall).toFixed(1),
  };
}

async function runPhase(page, kind, ms, how) {
  await page.evaluate(() => window.__perf.frameAll());
  await sleep(300);
  // --shots: screenshot at rest (before) and mid-motion (ms/2 in) per moving phase.
  const shot = opt.shots && kind !== "idle"
    ? (when) => page.screenshot({ path: path.join(outDir, `${SHOT_PREFIX}-${kind}-${when}.png`) }).catch(() => {})
    : null;
  if (shot) {
    // Let the at-rest view refresh (tile fetch after the framing move) land
    // before the "rest" shot, so it shows settled rest quality.
    await sleep(Number(opt["shot-settle"] ?? 1500));
    await shot("rest");
  }
  const cpu0 = await cpuMetrics(page);
  await page.evaluate((n) => window.__perf.startPhase(n), `${kind}`);
  const mid = shot ? sleep(ms / 2).then(() => shot("moving")) : null;
  if (kind === "idle") await sleep(ms);
  else if (how === "controls") await page.evaluate(([k, d]) => window.__perf.driveControls(k, d), [kind, ms]);
  else await pointerDrive(page, kind, ms);
  if (mid) await mid;
  const res = await page.evaluate(() => window.__perf.endPhase());
  res.cpu = cpuDelta(cpu0, await cpuMetrics(page));
  res.drive = kind === "idle" ? "-" : how;
  return res;
}

// ── Render-on-demand check (--rod-check) ───────────────────────
// Each step: arm the presented-frame capture, run an action that changes
// the picture, wait --rod-wait ms (default 3000) WITHOUT touching the
// page, then measure the idle render rate over the last second and diff
// the presented frame against a forced fresh render. diffPx > 0 means a
// stale picture was left on screen (a missed invalidation).
async function rodCheckRun(page, tag) {
  const wait = Number(opt["rod-wait"] ?? 3000);
  const r = await page.evaluate(() => window.__perf.canvasRect());
  const cx = Math.round(r.x + r.w / 2);
  const cy = Math.round(r.y + r.h / 2);
  const steps = [
    ["rest", null],
    ["click", async () => { await page.mouse.click(cx, cy); return `click ${cx},${cy}`; }],
    ["click-empty", async () => { await page.mouse.click(r.x + 8, r.y + 8); return "click corner"; }],
    ["hide-model", () => page.evaluate(() => window.__perf.rodCheck.hideModel("MECHANICAL", false))],
    ["section-plane", () => page.evaluate(() => window.__perf.rodCheck.addSection())],
    ["clear-section", () => page.evaluate(() => { window.__perf.rodCheck.clearSections(); return "cleared"; })],
    ["show-model", () => page.evaluate(() => window.__perf.rodCheck.hideModel("MECHANICAL", true))],
    ["resize", async () => { await page.setViewportSize({ width: VIEWPORT.width - 200, height: VIEWPORT.height }); return "viewport -200px"; }],
    ["resize-back", async () => { await page.setViewportSize(VIEWPORT); return "viewport restored"; }],
  ];
  const out = [];
  await page.evaluate(() => window.__perf.frameAll());
  await sleep(1500);
  for (const [label, action] of steps) {
    await page.evaluate(() => window.__perf.rodCheck.begin());
    const cpu0 = await cpuMetrics(page);
    const note = action ? await action() : "-";
    await sleep(wait);
    const cpuAll = cpuDelta(cpu0, await cpuMetrics(page));
    // Idle CPU over the last second (no action in flight).
    const c1 = await cpuMetrics(page);
    await sleep(1000);
    const cpuIdle = cpuDelta(c1, await cpuMetrics(page));
    if (opt.shots) await page.screenshot({ path: path.join(outDir, `${SHOT_PREFIX}-rod-${label}.png`) }).catch(() => {});
    const res = await page.evaluate((l) => window.__perf.rodCheck.end(l), label);
    res.note = note;
    res.cpuWindow = cpuAll;
    res.cpuIdle1s = cpuIdle;
    log(`${tag}: rod-check ${label}: renders ${res.rendersSinceBegin} (last 1s ${res.rendersLast1s}), stale-guard ${res.staleGuardFrames}, diff ${res.diffPx} px (max delta ${res.maxDelta}), idle CPU ${cpuIdle.taskPct}% — ${note}`);
    out.push(res);
  }
  return out;
}

// ── 5. CPU profile digest ──────────────────────────────────────
// Vite pre-bundles three / OBC / react into anonymous `chunk-XXXX.js`
// files; resolve call frames through the chunks' source maps so the
// top-N list names the real package file (three.module.js, OBC
// index.mjs, ...) without changing what the page runs.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeMappings(mappings) {
  const lines = [];
  let src = 0, oLine = 0, oCol = 0;
  for (const lineStr of mappings.split(";")) {
    const segs = [];
    let gCol = 0;
    for (const seg of lineStr.split(",")) {
      if (!seg) continue;
      const vals = [];
      let v = 0, shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        v += (d & 31) << shift;
        if (d & 32) shift += 5;
        else { vals.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0; }
      }
      gCol += vals[0];
      if (vals.length >= 4) { src += vals[1]; oLine += vals[2]; oCol += vals[3]; segs.push([gCol, src, oLine, oCol]); }
    }
    lines.push(segs);
  }
  return lines;
}
const mapCache = new Map();
async function loadMap(url) {
  const key = url.split("?")[0];
  if (mapCache.has(key)) return mapCache.get(key);
  let m = null;
  if (/\/deps\/[^/]+\.js$/.test(key)) {
    let j = null;
    // Prefer the optimizer's on-disk map (independent of server state).
    const local = /\/node_modules\/(\.vite[^/]*\/deps\/[^/]+\.js)$/.exec(key);
    if (local) {
      try { j = JSON.parse(fs.readFileSync(path.join(here, "node_modules", `${local[1]}.map`), "utf8")); } catch { /* fall back */ }
    }
    if (!j) {
      try {
        const res = await fetch(`${key}.map`);
        if (res.ok) j = await res.json();
      } catch { /* unmapped */ }
    }
    if (j?.mappings) m = { sources: j.sources, lines: decodeMappings(j.mappings) };
  }
  mapCache.set(key, m);
  return m;
}
async function resolveFrame(cf) {
  const m = cf.url ? await loadMap(cf.url) : null;
  if (!m) return null;
  const segs = m.lines[cf.lineNumber];
  if (!segs?.length) return null;
  let best = null;
  for (const s of segs) { if (s[0] <= cf.columnNumber) best = s; else break; }
  if (!best) best = segs[0];
  const srcPath = m.sources[best[1]] ?? "";
  const short = srcPath.replace(/^.*node_modules\//, "").replace(/^\.pnpm\/[^/]+\/node_modules\//, "");
  return `${short}:${best[2] + 1}`;
}

async function digestProfile(profile, topN = 25) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const { samples, timeDeltas } = profile;
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = (timeDeltas[i + 1] ?? 0) / 1000; // µs -> ms
    total += dt;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + dt);
  }
  const agg = new Map();
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame;
    const mapped = await resolveFrame(cf);
    const file = cf.url ? cf.url.split("?")[0].replace(/^https?:\/\/[^/]+\//, "").replace(/^@fs\/.*?\/(packages|node_modules)\//, "$1/") : "";
    const where = mapped ?? (file ? `${file.split("/").slice(-3).join("/")}:${cf.lineNumber + 1}` : "");
    const name = `${cf.functionName || "(anonymous)"}${where ? ` ${where}` : ""}`;
    agg.set(name, (agg.get(name) ?? 0) + ms);
  }
  const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]);
  const idle = agg.get("(idle)") ?? 0;
  const busy = total - idle;
  return {
    totalMs: Math.round(total),
    idleMs: Math.round(idle),
    busyMs: Math.round(busy),
    gcMs: Math.round(agg.get("(garbage collector)") ?? 0),
    programMs: Math.round(agg.get("(program)") ?? 0),
    top: rows
      .filter(([n]) => n !== "(idle)")
      .slice(0, topN)
      .map(([n, ms]) => ({ fn: n, selfMs: Math.round(ms), pctBusy: Math.round((1000 * ms) / busy) / 10 })),
  };
}

// ── 6. Browser + runs ──────────────────────────────────────────
let depsWarmed = false;
async function openPage(pw, baseUrl, frags, extra = {}) {
  const args = [
    "--ignore-gpu-blocklist",
    "--enable-gpu",
    "--enable-gpu-rasterization",
    "--enable-precise-memory-info",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-position=0,0",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height + 140}`,
    ...(opt.uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
    ...opt.chromeArgs,
  ];
  let browser;
  let context;
  if (opt.warm) {
    // --warm: a persistent profile, so IndexedDB is on disk as in the app.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-perf-warm-"));
    context = await pw.chromium.launchPersistentContext(userDir, {
      headless: !!opt.headless,
      executablePath: opt.executable || undefined,
      args,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });
    browser = {
      close: async () => {
        await context.close();
        fs.rmSync(userDir, { recursive: true, force: true });
      },
    };
  } else {
    browser = await pw.chromium.launch({
      headless: !!opt.headless,
      executablePath: opt.executable || undefined,
      args,
    });
    context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  }
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.location()?.url ?? "")) consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

  const q = new URLSearchParams();
  for (const f of frags) q.append("m", f.key);
  if (opt.exp) q.set("exp", String(opt.exp));
  if (opt.strict) q.set("strict", "1");
  if (opt["settle-cap"]) q.set("settleCap", String(opt["settle-cap"]));
  for (const [k, v] of Object.entries(extra)) if (!k.startsWith("__")) q.set(k, v);
  const url = `${baseUrl}?${q}`;

  if (mode === "dev" && !depsWarmed) {
    // Warm Vite's dep optimizer so a mid-load "optimized deps changed"
    // reload cannot land inside the measured load.
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.__perf, null, { timeout: 120_000 });
    await sleep(1500);
    depsWarmed = true;
  }
  if (String(opt.exp ?? "").split(",").includes("idb")) {
    // --exp=idb: seed the frags into this context's IndexedDB first (a
    // separate page load), so the measured load reads them back from
    // disk the way the app reads Dexie `fragBlobs`.
    const sq = new URLSearchParams();
    for (const f of frags) sq.append("m", f.key);
    sq.set("seedIdb", "1");
    await page.goto(`${baseUrl}?${sq}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__perf && ["seeded", "error"].includes(window.__perf.status), null, { timeout: 300_000 });
    const st = await page.evaluate(() => window.__perf);
    if (st.status !== "seeded") throw new Error(`IDB seed failed: ${st.error}`);
    await page.goto("about:blank");
  }
  if (opt.warm) {
    // Priming load in the same profile (fills the tile cache), not measured.
    const t = Date.now();
    await page.goto(url, { waitUntil: "load" });
    await waitStatus(page, ["ready"], consoleErrors);
    await sleep(Number(opt["warm-settle"] ?? 4000));
    await page.goto("about:blank");
    await sleep(500);
    console.log(`[perf] warm: priming load done in ${Date.now() - t} ms`);
  }
  const hookState = extra.__beforeNav ? await extra.__beforeNav(context, page) : null;
  const tNav = Date.now();
  await page.goto(url, { waitUntil: "load" });
  return { browser, context, page, consoleErrors, tNav, hookState };
}

async function waitStatus(page, wanted, consoleErrors, polling = 250) {
  await page.waitForFunction(
    (w) => window.__perf && (w.includes(window.__perf.status) || window.__perf.status === "error"),
    wanted, { timeout: 900_000, polling },
  );
  const st = await page.evaluate(() => ({ status: window.__perf.status, error: window.__perf.error }));
  if (!wanted.includes(st.status)) throw new Error(`page failed to settle: ${st.error}\nconsole: ${consoleErrors.join("\n")}`);
}

async function checkGpu(page, browser, tag) {
  const gpu = await page.evaluate(() => window.__perf.gpuInfo());
  const soft = /swiftshader|llvmpipe|softpipe|software/i.test(String(gpu.unmaskedRenderer ?? ""));
  log(`${tag}: GPU = ${gpu.unmaskedRenderer} | DPR ${gpu.devicePixelRatio} | buffer ${gpu.drawingBuffer?.w}x${gpu.drawingBuffer?.h}`);
  if (soft && !opt["allow-software"]) {
    await browser.close();
    throw new Error(`SOFTWARE RENDERER DETECTED (${gpu.unmaskedRenderer}) — results would be meaningless. Use a real display (headed) or pass --allow-software.`);
  }
  return gpu;
}

// Pick-gate targets: thin MEP (pipe / fitting), a duct, a big MEP
// device and one structural member. Categories are regexes over the
// fragments category names (IFC class, upper case).
const PICK_SPECS = [
  { label: "mep-duct", model: "MECHANICAL", categories: "^IFC(DUCTSEGMENT|FLOWSEGMENT)$", name: "duct|ducto|conducto", max: 250 },
  { label: "mep-pipe (thin)", model: "MECHANICAL", categories: "^IFC(PIPESEGMENT|FLOWSEGMENT)$", name: "pipe|tuber|ca.er" },
  { label: "mep-fitting (thin)", model: "MECHANICAL", categories: "^IFC(DUCTFITTING|PIPEFITTING|FLOWFITTING)$" },
  { label: "mep-terminal", model: "MECHANICAL", categories: "^IFC(FLOWTERMINAL|AIRTERMINAL)$", max: 250 },
  { label: "mep-equipment", model: "MECHANICAL", categories: "^IFC(UNITARYEQUIPMENT|CHILLER|FAN|PUMP|BOILER|FLOWMOVINGDEVICE|ENERGYCONVERSIONDEVICE|FLOWCONTROLLER|BUILDINGELEMENTPROXY)$" },
  { label: "structural", model: "STRUCTURAL", categories: "^IFC(BEAM|COLUMN|MEMBER|SLAB|FOOTING)$" },
];
function pickPlanPath(frags) {
  const sig = frags.map((f) => f.key).join("+") + `@${VIEWPORT.width}x${VIEWPORT.height}`;
  let h = 0;
  for (const ch of sig) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return path.join(cacheDir, `pickplan-${(h >>> 0).toString(16)}.json`);
}
async function calibrate(page, frags) {
  await page.evaluate(() => window.__perf.frameAll());
  const plan = await page.evaluate((specs) => window.__perf.calibratePickTargets(specs), PICK_SPECS);
  plan.frags = frags.map((f) => f.key);
  plan.viewport = VIEWPORT;
  fs.writeFileSync(pickPlanPath(frags), JSON.stringify(plan, null, 1));
  log(`pick plan: ${plan.targets.length} targets (${plan.targets.map((t) => `${t.label}=${t.category}#${t.expressId}@${t.clientX},${t.clientY}`).join("; ")})`);
  for (const n of plan.notes) log(`pick plan note: ${n}`);
  return plan;
}

async function navRun(pw, baseUrl, frags, runIdx, stamp, { wantPlan, calibrateOnly } = {}) {
  const tag = calibrateOnly ? "calibration" : `run ${runIdx + 1}`;
  const { browser, context, page, consoleErrors, tNav } = await openPage(pw, baseUrl, frags);
  await waitStatus(page, ["ready"], consoleErrors);
  const loadWallMs = Date.now() - tNav;
  const gpu = await checkGpu(page, browser, tag);
  const load = await page.evaluate(() => ({
    timings: window.__perf.timings,
    fetch: window.__perf.fetchTimings,
    crumbs: window.__perf.crumbs.filter((c) => c.c === "model"),
    pageExperiments: window.__perf.pageExperiments,
    sceneAtReady: window.__perf.sceneStats(),
  }));
  load.loadWallMs = loadWallMs;
  log(`${tag}: ready in ${loadWallMs} ms (allLoaded ${load.timings.allLoadedMs}, gate-lift ${Math.round(load.timings.gateLiftMs ?? -1)}, pump-settle ${load.timings.pumpSettleMs}${load.timings.pumpCapped ? " CAPPED" : ""})`);
  if (calibrateOnly) {
    const plan = await calibrate(page, frags);
    await browser.close();
    return { plan };
  }

  const phases = [];
  const drives = drive === "both" ? ["pointer", "controls"] : [drive];
  phases.push(await runPhase(page, "idle", PH.idle, "-"));
  for (const how of drives) {
    for (const kind of ["orbit", "pan", "zoom"]) {
      const r = await runPhase(page, kind, PH[kind], how);
      log(`${tag}: ${kind}/${how} fps ${r.fpsMean} p95 ${r.frameMs.p95} ms draws/f ${r.perFrame.drawCalls.mean}`);
      phases.push(r);
    }
  }

  let rodChecks = null;
  if (opt["rod-check"]) rodChecks = await rodCheckRun(page, tag);

  let profile = null;
  if (!opt["no-profile"]) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await page.evaluate(() => window.__perf.frameAll());
    await cdp.send("Profiler.start");
    await (drives[0] === "controls"
      ? page.evaluate(([k, d]) => window.__perf.driveControls(k, d), ["orbit", PH.orbit])
      : pointerDrive(page, "orbit", PH.orbit));
    const { profile: prof } = await cdp.send("Profiler.stop");
    const file = path.join(outDir, `${stamp}-${scenario}-run${runIdx + 1}-orbit.cpuprofile`);
    fs.writeFileSync(file, JSON.stringify(prof));
    profile = { file, ...(await digestProfile(prof)) };
  }

  let plan = null;
  if (wantPlan) plan = await calibrate(page, frags);

  if (opt["keep-open"]) {
    log("--keep-open: browser left open; Ctrl-C to exit");
    await new Promise(() => {});
  }
  await browser.close();
  return { gpu, load, phases, rodChecks, profile, plan, consoleErrors: consoleErrors.slice(0, 20) };
}

// ── Pick-after-load gate ───────────────────────────────────────
// Fresh load; the page applies the calibrated pose once every model is
// loaded and reports `pick-ready` at the gate-lift breadcrumb (overlay
// gone) WITHOUT waiting for the warm pump. Clicks are real pointer
// events. Slots are nominal start times after gate-lift; targets are
// clicked sequentially inside a slot (the viewer's pick chain is
// single-flight, so overlapping clicks would supersede each other) —
// the actual click time is recorded. After the nominal slots, targets
// still lacking a pick or a visible tint are re-clicked every
// --pick-tail-every ms until --pick-tail-ms.
const PICK_SLOTS = (opt["pick-slots"] ? String(opt["pick-slots"]).split(",").map(Number) : [0, 1, 2, 5, 10]).map((s) => s * 1000);
const PICK_SEL_TIMEOUT = Number(opt["pick-timeout"] ?? 2000);
const PICK_HL_WATCH = Number(opt["pick-hl-watch"] ?? 800);
const PICK_TAIL_MS = Number(opt["pick-tail-ms"] ?? 60000);
const PICK_TAIL_EVERY = Number(opt["pick-tail-every"] ?? 5000);

// ── Load timeline (--load-only) ────────────────────────────────
const LOAD_STEPS = ["load-start", "load-blob", "load-buffer", "load-parsed", "load-complete", "first-tiles"];
async function loadRun(pw, baseUrl, frags, runIdx, stamp) {
  const tag = `load run ${runIdx + 1}`;
  const wantProfile = !!opt["load-profile"];
  const wantThreads = !!opt["thread-busy"];
  let tracingBrowser = null;
  const { browser, context, page, consoleErrors, tNav, hookState } = await openPage(pw, baseUrl, frags, {
    __beforeNav: wantProfile || wantThreads
      ? async (ctx, pg) => {
          let cdp = null;
          if (wantProfile) {
            cdp = await ctx.newCDPSession(pg);
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
            await cdp.send("Profiler.start");
          }
          if (wantThreads) {
            tracingBrowser = ctx.browser();
            const cats = ["toplevel", "__metadata"];
            // --thread-busy=profile: also V8 CPU samples of every thread (workers too).
            if (opt["thread-busy"] === "profile") cats.push("disabled-by-default-v8.cpu_profiler", "v8.execute");
            await tracingBrowser.startTracing(pg, { categories: cats });
          }
          return { cdp };
        }
      : undefined,
  });
  await waitStatus(page, ["ready"], consoleErrors);
  const loadWallMs = Date.now() - tNav;
  let threadBusy = null;
  if (tracingBrowser) {
    const buf = await tracingBrowser.stopTracing();
    if (opt["thread-busy"] === "profile") {
      const file = path.join(outDir, `${stamp}-${scenario}-run${runIdx + 1}-load.trace.json`);
      fs.writeFileSync(file, buf);
      log(`${tag}: trace -> ${file}`);
    }
    threadBusy = threadBusyFromTrace(JSON.parse(buf.toString("utf8")));
  }
  let profile = null;
  if (hookState?.cdp) {
    const { profile: prof } = await hookState.cdp.send("Profiler.stop");
    const file = path.join(outDir, `${stamp}-${scenario}-run${runIdx + 1}-load.cpuprofile`);
    fs.writeFileSync(file, JSON.stringify(prof));
    profile = { file, ...(await digestProfile(prof, 30)) };
  }
  const gpu = await checkGpu(page, browser, tag);
  const load = await page.evaluate(() => ({
    timings: window.__perf.timings,
    fetch: window.__perf.fetchTimings,
    crumbs: window.__perf.crumbs.filter((c) => c.c === "model"),
    streamTrace: window.__perf.streamTrace ?? [],
  }));
  await browser.close();
  log(`${tag}: ready in ${loadWallMs} ms (allLoaded ${load.timings.allLoadedMs}, gate-lift ${Math.round(load.timings.gateLiftMs ?? -1)})`);
  return { gpu, loadWallMs, ...load, profile, threadBusy, consoleErrors };
}

// --thread-busy (with --load-only): Chrome trace of the load, top-level
// task time per thread (renderer main, every dedicated worker, GPU main)
// in 1 s buckets, as % busy. Says whether the tile fill-in is bound by
// worker CPU, main-thread CPU, or neither (pacing).
function threadBusyFromTrace(trace) {
  const events = trace.traceEvents ?? trace;
  const names = new Map();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args?.name ?? "?");
  const tasks = events.filter((e) => e.ph === "X" && e.dur > 0 && /^(RunTask|ThreadControllerImpl::RunTask|ThreadPool_RunTask)$/.test(e.name));
  if (!tasks.length) return null;
  const t0 = Math.min(...tasks.map((e) => e.ts));
  const per = new Map();
  for (const e of tasks) {
    const key = `${e.pid}:${e.tid}`;
    const name = names.get(key) ?? key;
    if (!/CrRendererMain|DedicatedWorker|CrGpuMain|VizCompositor/.test(name)) continue;
    if (!per.has(key)) per.set(key, { name, buckets: [] });
    const b = per.get(key).buckets;
    // split the task over 1 s buckets
    let s = e.ts - t0, end = e.ts - t0 + e.dur;
    while (s < end) {
      const i = Math.floor(s / 1e6);
      const cut = Math.min(end, (i + 1) * 1e6);
      b[i] = (b[i] ?? 0) + (cut - s);
      s = cut;
    }
  }
  return [...per.values()].map((p) => ({ name: p.name, pct: Array.from(p.buckets, (x) => Math.round((x ?? 0) / 1e4)) }));
}
function loadTimeline(r) {
  const lines = [];
  const ms = (x) => (x === undefined || x === null ? "-" : String(Math.round(x)));
  const per = new Map();
  for (const c of r.crumbs) {
    const f = c.d?.file;
    if (!f || !LOAD_STEPS.includes(c.a)) continue;
    const k = String(f).replace(/-\d+-\d+-f[\d.]+$/, "");
    if (!per.has(k)) per.set(k, {});
    per.get(k)[c.a] ??= c.t;
  }
  const head = ["model", "start", "blob", "buffer", "parsed", "pushed", "1st tiles", "parse ms", "push ms", "MB"];
  const rows = [...per.entries()].map(([k, s]) => {
    const key = [...Object.keys(r.fetch ?? {})].find((x) => x.startsWith(k));
    const mb = key ? (r.fetch[key].bytes / 2 ** 20).toFixed(1) : "-";
    return [k, ms(s["load-start"]), ms(s["load-blob"]), ms(s["load-buffer"]), ms(s["load-parsed"]), ms(s["load-complete"]), ms(s["first-tiles"]),
      ms(s["load-parsed"] - s["load-buffer"]), ms(s["load-complete"] - s["load-parsed"]), mb];
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)));
  const line = (x) => x.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  ");
  lines.push(line(head));
  rows.forEach((x) => lines.push(line(x)));
  const first = (a) => r.crumbs.find((c) => c.a === a)?.t;
  const last = (a) => [...r.crumbs].reverse().find((c) => c.a === a)?.t;
  const fsum = Object.entries(r.fetch ?? {}).map(([k, v]) => `${k.replace(/-\d+-\d+-f[\d.]+\.frag$/, "")} ${v.ms} ms${v.src ? ` (${v.src})` : ""}`).join(", ");
  if (fsum) lines.push(`   getFragBlob: ${fsum}`);
  lines.push(`   all-first-tiles ${ms(first("all-first-tiles"))} | all loaded ${ms(r.timings.allLoadedMs)} | gate-lift (overlay) ${ms(first("gate-lift"))} | VIEW-COMPLETE ${ms(first("view-complete"))} | last lod-armed ${ms(last("lod-armed"))} | lod-settle ${ms(first("lod-settle"))} | idle ${ms(r.timings.idleMs)} | ready ${ms(r.timings.readyMs)} | wall ${r.loadWallMs}`);
  return lines.join("\n");
}

async function pickGateRun(pw, baseUrl, frags, plan, runIdx) {
  const tag = `pick run ${runIdx + 1}`;
  const { browser, page, consoleErrors, tNav } = await openPage(pw, baseUrl, frags, {
    pickPlan: JSON.stringify({ pose: plan.pose, targets: plan.targets }),
  });
  await waitStatus(page, ["pick-ready"], consoleErrors, "raf");
  const gpu = await checkGpu(page, browser, tag);
  const timings = await page.evaluate(() => window.__perf.timings);
  log(`${tag}: overlay lifted at ${timings.gateLiftMs} ms (allLoaded ${timings.allLoadedMs}), nav->ready wall ${Date.now() - tNav} ms`);
  const clicks = [];
  const state = new Map(plan.targets.map((t) => [t.label, { firstClickT: null, firstPickT: null, firstPickSelMs: null, firstHlT: null, firstHlAfterClickMs: null }]));
  const clickTarget = async (t, slotMs) => {
    await page.mouse.move(t.clientX, t.clientY);
    const prep = await page.evaluate((tt) => window.__perf.pickGate.prepareClick(tt), t);
    const tClick = await page.evaluate(() => window.__perf.pickGate.sinceLift());
    await page.mouse.down({ button: "left" });
    await page.mouse.up({ button: "left" });
    const sel = await page.evaluate(([m, to]) => window.__perf.pickGate.waitSelection(m, to), [prep.mark, PICK_SEL_TIMEOUT]);
    let outcome = "none";
    let got = null;
    if (sel) {
      got = sel.sel.map((s) => `${s.modelId.split("-")[0]}#${s.ids.join("/")}`).join(",");
      outcome = sel.sel.some((s) => s.modelId === t.modelId && s.ids.includes(t.expressId)) ? "ok" : "other";
    }
    let hl = { ms: null, rgb: null };
    if (outcome === "ok") {
      hl = await page.evaluate(([x, y, pre, m, to]) => window.__perf.pickGate.watchHighlight(x, y, pre, m, to), [t.clientX, t.clientY, prep.pre, prep.mark, PICK_HL_WATCH]);
    }
    const rec = {
      target: t.label, slotS: slotMs / 1000, tClickMs: Math.round(tClick), busyAtClick: prep.busy,
      outcome, selected: got, selMs: sel?.ms ?? null, highlightMs: hl.ms, preRgb: prep.pre, postRgb: hl.rgb,
    };
    clicks.push(rec);
    const s = state.get(t.label);
    if (s.firstClickT === null) s.firstClickT = rec.tClickMs;
    if (outcome === "ok" && s.firstPickT === null) { s.firstPickT = Math.round(tClick + rec.selMs); s.firstPickSelMs = rec.selMs; }
    if (hl.ms !== null && s.firstHlT === null) { s.firstHlT = Math.round(tClick + hl.ms); s.firstHlAfterClickMs = hl.ms; }
    log(`${tag}: t=${rec.tClickMs}ms ${t.label}: ${outcome}${rec.selMs !== null ? ` sel ${rec.selMs}ms` : ""}${outcome === "ok" ? ` tint ${hl.ms ?? "not visible"}${hl.ms !== null ? "ms" : ""}` : ""}${got && outcome !== "ok" ? ` (${got})` : ""} busy=${prep.busy}`);
  };
  const waitUntilT = async (ms) => {
    for (;;) {
      const now = await page.evaluate(() => window.__perf.pickGate.sinceLift());
      if (now >= ms) return;
      await sleep(Math.min(50, ms - now));
    }
  };
  for (const slot of PICK_SLOTS) {
    await waitUntilT(slot);
    for (const t of plan.targets) await clickTarget(t, slot);
  }
  // Tail: keep clicking targets that still lack a pick or a visible tint.
  let slot = PICK_SLOTS[PICK_SLOTS.length - 1] + PICK_TAIL_EVERY;
  while (slot <= PICK_TAIL_MS) {
    const pending = plan.targets.filter((t) => { const s = state.get(t.label); return s.firstPickT === null || s.firstHlT === null; });
    if (!pending.length) break;
    await waitUntilT(slot);
    for (const t of pending) await clickTarget(t, slot);
    slot += PICK_TAIL_EVERY;
  }
  const crumbs = await page.evaluate(() => window.__perf.crumbs.filter((c) => c.c === "model" || c.c === "pick"));
  const verify = await page.evaluate((ts) => window.__perf.pickGate.verify(ts), plan.targets);
  for (const h of verify.hits) log(`${tag}: end-of-gate raycast at ${h.label}: ${h.hit ? `${h.hit.modelId.split("-")[0]}#${h.hit.localId}` : "miss"}; target bbox centre now projects to ${JSON.stringify(h.projected)}`);
  log(`${tag}: pose now ${JSON.stringify(verify.pose)} vs plan ${JSON.stringify(plan.pose)}`);
  await browser.close();
  return {
    gpu, timings, crumbs,
    targets: plan.targets.map((t) => ({ ...t, ...state.get(t.label) })),
    clicks, verify, consoleErrors: consoleErrors.slice(0, 20),
  };
}

// ── 7. Reporting ───────────────────────────────────────────────
function fmt(n, d = 1) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "-";
}
function phaseTable(phases) {
  const head = ["phase", "drive", "fps", "p50", "p95", "p99", "max", ">50ms", "LT n/ms", "rend/f", "rend/s", "rCPU ms", "draws/f", "tris/f", "CPU%", "heapMB"];
  const rows = phases.map((p) => [
    p.name, p.drive, fmt(p.fpsMean), fmt(p.frameMs.p50), fmt(p.frameMs.p95), fmt(p.frameMs.p99), fmt(p.frameMs.max, 0),
    String(p.longFramesOver50ms), `${p.longTasks.count}/${p.longTasks.totalMs}`, fmt(p.perFrame.renders.mean, 2),
    fmt(p.perFrame.renders.mean * p.fpsMean, 1), fmt(p.perFrame.renderCpuMs.mean, 2),
    fmt(p.perFrame.drawCalls.mean, 0), `${fmt(p.perFrame.triangles.mean / 1e6, 2)}M`, fmt(p.cpu?.taskPct, 1), fmt(p.heapMB?.max, 0),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padStart(w[i])).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
}

// ── main ───────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
SHOT_PREFIX = `${stamp}-${opt.label ? slug(String(opt.label)) : "shot"}`;
if (!opt.headless && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error("No $DISPLAY/$WAYLAND_DISPLAY — headed Chromium needs a real display for the GPU path.");
  process.exit(1);
}
log(`scenario=${scenario} runs=${runs} drive=${drive} mode=${mode} exp=${opt.exp ?? "-"}`);
const frags = [];
for (const p of modelPaths) frags.push(await ensureFrag(p));
for (const f of frags) log(`  ${f.key}  frag ${(f.fragBytes / 2 ** 20).toFixed(1)} MB  convert ${f.convertMs} ms${f.cached ? " (cached)" : ""}`);
const pw = resolvePlaywright();
log(`playwright: ${pw.from}`);
const server = await startServer();
log(`server: ${server.url}`);

const navResults = [];
const pickResults = [];
const loadResults = [];
let plan = null;
let exitCode = 0;
try {
  const planFile = pickPlanPath(frags);
  if (doPickGate && !opt.recalibrate && fs.existsSync(planFile)) {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    log(`pick plan (cached): ${planFile}`);
  }
  if (loadOnly) {
    for (let i = 0; i < runs; i++) loadResults.push(await loadRun(pw.mod, server.url, frags, i, stamp));
  }
  if (doNav) {
    for (let i = 0; i < runs; i++) {
      const r = await navRun(pw.mod, server.url, frags, i, stamp, { wantPlan: doPickGate && !plan && i === 0 });
      if (r.plan) plan = r.plan;
      navResults.push(r);
    }
  }
  if (doPickGate) {
    if (!plan) plan = (await navRun(pw.mod, server.url, frags, 0, stamp, { calibrateOnly: true })).plan;
    if (!plan.targets.length) throw new Error(`pick calibration found no targets: ${plan.notes.join(" | ")}`);
    for (let i = 0; i < runs; i++) pickResults.push(await pickGateRun(pw.mod, server.url, frags, plan, i));
  }
} catch (err) {
  console.error(`\n[perf] FAILED: ${err?.stack ?? err}`);
  exitCode = 1;
} finally {
  await server.close();
}

if (loadResults.length) {
  const file = path.join(outDir, `${stamp}-${scenario}-load${opt.label ? `-${slug(String(opt.label))}` : ""}.json`);
  fs.writeFileSync(file, JSON.stringify({ stamp, scenario, label: opt.label ?? null, mode, exp: opt.exp ?? null, uncapped: !!opt.uncapped, runs: loadResults }, null, 1));
  console.log(`\n=== FreeField viewer LOAD timeline — ${scenario} (${frags.length} models) — ${mode}${opt.uncapped ? " — uncapped" : ""}${opt.exp ? ` — exp ${opt.exp}` : ""} ===`);
  console.log(`GPU: ${loadResults[0].gpu.unmaskedRenderer}. All times: ms since the harness page script started (T0).`);
  loadResults.forEach((r, i) => {
    console.log(`\n-- load run ${i + 1}`);
    console.log(loadTimeline(r));
    if (r.profile) {
      const p = r.profile;
      console.log(`   CPU profile (main thread, nav -> ready): busy ${p.busyMs} / ${p.totalMs} ms, GC ${p.gcMs} ms, (program) ${p.programMs} ms -> ${p.file}`);
      p.top.forEach((t, j) => console.log(`   ${String(j + 1).padStart(2)}. ${String(t.selfMs).padStart(6)} ms ${String(t.pctBusy).padStart(5)}%  ${t.fn}`));
    }
    if (r.threadBusy) {
      console.log("   thread busy % per 1 s (trace start ~ navigation):");
      for (const t of r.threadBusy) console.log(`   ${t.name.padEnd(26)} ${t.pct.map((x) => String(x).padStart(3)).join("")}`);
    }
    if (opt.trace && r.streamTrace?.length) {
      // --trace: the page's stream trace, ~1 sample/s (t ms: tile requests
      // queued on main / tiles in scene / busy models).
      let last = -Infinity;
      const pts = r.streamTrace.filter((p) => (p.t - last >= 1000 ? ((last = p.t), true) : false));
      console.log(`   stream trace (t: queued/tiles busy): ${pts.map((p) => `${p.t}:${p.pending}/${p.tiles}${p.busy.length ? ` ${p.busy.join("+")}` : ""}`).join(" | ")}`);
    }
    if (r.consoleErrors.length) console.log(`   console errors (${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 3).join(" | ")}`);
  });
  if (loadResults.length > 1) {
    const med = (f) => Math.round(median(loadResults.map(f).filter((x) => x != null)));
    const fc = (r, a) => r.crumbs.find((c) => c.a === a)?.t;
    console.log(`\n-- median over ${loadResults.length} runs: all-first-tiles ${med((r) => fc(r, "all-first-tiles"))} | all loaded ${med((r) => r.timings.allLoadedMs)} | gate-lift ${med((r) => fc(r, "gate-lift"))} | view-complete ${med((r) => fc(r, "view-complete"))} | lod-settle ${med((r) => fc(r, "lod-settle"))} | ready ${med((r) => r.timings.readyMs)}`);
  }
  console.log(`\nJSON: ${file}`);
}
if (navResults.length || pickResults.length) {
  const out = {
    stamp, scenario, label: opt.label ?? null, mode, drive, exp: opt.exp ?? null, uncapped: !!opt.uncapped,
    viewport: VIEWPORT, phaseMs: PH, chromeArgs: opt.chromeArgs,
    git: await new Promise((r) => {
      const p = spawn("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"]);
      let s = ""; p.stdout.on("data", (d) => (s += d)); p.on("exit", () => r(s.trim()));
    }),
    models: frags.map((f) => ({ key: f.key, ifc: f.ifcPath, ifcMB: +(f.ifcBytes / 2 ** 20).toFixed(1), fragMB: +(f.fragBytes / 2 ** 20).toFixed(1), convertMs: f.convertMs, convertCached: f.cached })),
    runs: navResults,
    pickGate: pickResults.length ? { slotsMs: PICK_SLOTS, selTimeoutMs: PICK_SEL_TIMEOUT, highlightWatchMs: PICK_HL_WATCH, plan, runs: pickResults } : null,
  };
  const summary = {};
  if (navResults.length) {
    for (const ph of navResults[0].phases) {
      const key = `${ph.name}/${ph.drive}`;
      const pick = (fn) => navResults.map((r) => fn(r.phases.find((p) => `${p.name}/${p.drive}` === key)));
      const stat = (xs) => ({ median: +median(xs).toFixed(2), min: +Math.min(...xs).toFixed(2), max: +Math.max(...xs).toFixed(2) });
      summary[key] = {
        fps: stat(pick((p) => p.fpsMean)),
        p50: stat(pick((p) => p.frameMs.p50)),
        p95: stat(pick((p) => p.frameMs.p95)),
        p99: stat(pick((p) => p.frameMs.p99)),
        drawCalls: stat(pick((p) => p.perFrame.drawCalls.mean)),
        trianglesM: stat(pick((p) => p.perFrame.triangles.mean / 1e6)),
      };
    }
  }
  out.summary = summary;
  const file = path.join(outDir, `${stamp}-${scenario}${opt.label ? `-${slug(String(opt.label))}` : ""}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));

  // ── stdout report ──
  const g = (navResults[0] ?? pickResults[0]).gpu;
  console.log(`\n=== FreeField viewer perf — ${scenario} (${frags.length} models) — ${mode} — git ${out.git}${opt.exp ? ` — exp ${opt.exp}` : ""} ===`);
  console.log(`GPU: ${g.unmaskedRenderer}  (vendor ${g.unmaskedVendor}; webgl2 ${g.webgl2}; DPR ${g.devicePixelRatio}; renderer PR ${g.rendererPixelRatio}; buffer ${g.drawingBuffer?.w}x${g.drawingBuffer?.h}; AA ${g.contextAttributes?.antialias})`);
  for (const f of out.models) console.log(`  model ${f.key}: ifc ${f.ifcMB} MB -> frag ${f.fragMB} MB, convert ${f.convertMs} ms${f.convertCached ? " (cached)" : ""}`);
  navResults.forEach((r, i) => {
    const t = r.load.timings;
    const vc = r.load.crumbs.find((c) => c.a === "view-complete");
    console.log(`\n-- nav run ${i + 1}: load wall ${r.load.loadWallMs} ms | allLoaded ${t.allLoadedMs} | gate-lift ${Math.round(t.gateLiftMs ?? -1)} | view-complete ${vc ? Math.round(vc.t) : "-"} | pump-settle ${t.pumpSettleMs} (${t.pumpFrames} frames${t.pumpCapped ? ", CAPPED" : ""}) | ready ${t.readyMs} ms`);
    const sc = r.load.sceneAtReady;
    console.log(`   scene at ready: ${sc.meshes} meshes (${sc.visibleMeshes} visible, ${sc.instancedMeshes} instanced/${sc.instances} inst), geometries ${sc.memory?.geometries}, textures ${sc.memory?.textures}, programs ${sc.programs}`);
    if (r.load.pageExperiments.length) console.log(`   page experiments: ${r.load.pageExperiments.join("; ")}`);
    console.log(phaseTable(r.phases));
    if (r.rodChecks) {
      console.log("   render-on-demand check (diff = presented frame vs forced fresh render; >0 px = stale picture):");
      for (const c of r.rodChecks) {
        console.log(`   ${String(c.label).padEnd(14)} renders ${String(c.rendersSinceBegin).padStart(4)}  last1s ${String(c.rendersLast1s).padStart(3)}  lastAgo ${String(c.lastRenderAgoMs).padStart(5)} ms  staleGuard ${c.staleGuardFrames}  diff ${c.diffPx} px (max d ${c.maxDelta})  idleCPU ${c.cpuIdle1s.taskPct}%  ${JSON.stringify(c.byReason)}  ${c.note}`);
      }
    }
    if (r.profile) {
      const p = r.profile;
      console.log(`   CPU profile (orbit, main thread): busy ${p.busyMs} / ${p.totalMs} ms, GC ${p.gcMs} ms, (program) ${p.programMs} ms -> ${p.file}`);
      if (i === 0) p.top.forEach((t, j) => console.log(`   ${String(j + 1).padStart(2)}. ${String(t.selfMs).padStart(6)} ms ${String(t.pctBusy).padStart(5)}%  ${t.fn}`));
    }
    if (r.consoleErrors.length) console.log(`   console errors (${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 3).join(" | ")}`);
  });
  if (navResults.length > 1) {
    console.log(`\n-- nav run-to-run (median [min..max]) over ${navResults.length} runs`);
    for (const [k, s] of Object.entries(summary)) {
      console.log(`   ${k.padEnd(16)} fps ${s.fps.median} [${s.fps.min}..${s.fps.max}]  p50 ${s.p50.median} [${s.p50.min}..${s.p50.max}]  p95 ${s.p95.median} [${s.p95.min}..${s.p95.max}]  draws/f ${s.drawCalls.median}  tris/f ${s.trianglesM.median.toFixed(2)}M`);
    }
  }
  pickResults.forEach((r, i) => {
    const vc = r.crumbs.find((c) => c.a === "view-complete");
    console.log(`\n-- pick-after-load gate run ${i + 1}: overlay lifted at ${r.timings.gateLiftMs} ms after nav start (all loaded ${r.timings.allLoadedMs} ms, view-complete ${vc ? Math.round(vc.t) : "-"} ms); t below = ms after overlay lift`);
    const head = ["target", "class#id", "1st click t", "first pick t", "sel ms", "first tint t", "tint after click", "per-slot outcomes"];
    const rows = r.targets.map((t) => [
      t.label, `${t.category}#${t.expressId}`, String(t.firstClickT ?? "-"),
      t.firstPickT === null ? "NEVER" : String(t.firstPickT), t.firstPickSelMs === null ? "-" : String(t.firstPickSelMs),
      t.firstHlT === null ? "NEVER" : String(t.firstHlT), t.firstHlAfterClickMs === null ? "-" : String(t.firstHlAfterClickMs),
      r.clicks.filter((c) => c.target === t.label).map((c) => `${c.slotS}s:${c.outcome}${c.outcome === "ok" ? (c.highlightMs !== null ? "+tint" : "-notint") : ""}`).join(" "),
    ]);
    const w = head.map((h, k) => Math.max(h.length, ...rows.map((x) => x[k].length)));
    const line = (x) => x.map((c, k) => (k >= 7 ? c : c.padStart(w[k]))).join("  ");
    console.log(line(head));
    rows.forEach((x) => console.log(line(x)));
    if (r.consoleErrors.length) console.log(`   console errors (${r.consoleErrors.length}): ${r.consoleErrors.slice(0, 3).join(" | ")}`);
  });
  console.log(`\nJSON: ${file}`);
}
process.exit(exitCode);
