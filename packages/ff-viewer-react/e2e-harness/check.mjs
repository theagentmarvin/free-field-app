#!/usr/bin/env node
// packages/ff-viewer-react/e2e-harness/check.mjs
//
// Real-browser check of the viewer pick API under mobile-like conditions:
//   - headless Chromium on the SOFTWARE renderer (SwiftShader), like an
//     emulator WebView,
//   - devicePixelRatio != 1 (default 1.5) and a renderer pixel ratio set by
//     the host,
//   - touch-emulated taps (CDP Input.dispatchTouchEvent: pointerType "touch",
//     no mouse move before the tap),
//   - unmount / remount: no "No camera initialized!" page errors.
//
// Usage: node packages/ff-viewer-react/e2e-harness/check.mjs [--dpr=1.5] [--pr=1.5]
//        [--strict] [--fit] [--mouse] [--keep]
// Needs Playwright core (FF_PLAYWRIGHT_CORE, the repo's node_modules, or a global
// install) and a converted frag at $FF_E2E_FRAG_DIR/sample.frag (see --convert).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const DPR = Number(args.dpr ?? 1.5);
const PR = Number(args.pr ?? DPR);
const JITTER = Number(args.jitter ?? 0);
const fragDir = process.env.FF_E2E_FRAG_DIR ?? path.join(os.tmpdir(), "ff-e2e-frag");
process.env.FF_E2E_FRAG_DIR = fragDir;

if (!fs.existsSync(path.join(fragDir, "sample.frag"))) {
  fs.mkdirSync(fragDir, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [
      path.join(pkgRoot, "perf-harness/convert.mjs"),
      path.resolve(pkgRoot, "../../apps/settings/public/samples/sample.ifc"),
      path.join(fragDir, "sample.frag"),
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("frag conversion failed");
}

async function resolvePlaywright() {
  const cands = [
    process.env.FF_PLAYWRIGHT_CORE,
    path.join(pkgRoot, "node_modules/playwright-core"),
    path.resolve(pkgRoot, "../../node_modules/playwright-core"),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, "package.json"))) {
      const req = createRequire(path.join(c, "package.json"));
      return req(c);
    }
  }
  throw new Error("playwright-core not found; set FF_PLAYWRIGHT_CORE");
}

const viteEntry = createRequire(path.join(pkgRoot, "package.json")).resolve("vite");
const { createServer } = await import(
  pathToFileURL(viteEntry.replace(/index\.cjs$/, "dist/node/index.js").replace(/dist\/node\/index\.js$/, "dist/node/index.js")).href
);
const server = await createServer({ configFile: path.join(here, "vite.config.ts"), server: { port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const pw = await resolvePlaywright();
const browser = await pw.chromium.launch({
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
let failed = 0;
const log = (...a) => console.log(...a);
log(`dpr=${DPR} rendererPixelRatio=${PR} touch=${!args.mouse} nofast=${!!args.nofast}`);
const check = (name, ok, extra = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`);
  if (!ok) failed += 1;
};
try {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 800 },
    deviceScaleFactor: DPR,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message) + (args.stack ? "\n" + e.stack : "")));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console: " + m.text());
  });
  const qs = new URLSearchParams({ m: "sample.frag" });
  if (args.strict) qs.set("strict", "1");
  if (args.fit) qs.set("fit", "1");
  if (args.nofast) qs.set("nofast", "1");
  await page.goto(`${base}?${qs}`);
  await page.waitForFunction(() => window.__e2e?.handle && window.__e2e.fragments, null, { timeout: 60000 });
  await page.waitForFunction(
    () => window.__e2e.fragments.core.models.list.size > 0 &&
      [...window.__e2e.fragments.core.models.list.values()].every((m) => !m.isBusy),
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(1500);
  if (PR !== DPR || args.pr) {
    await page.evaluate((r) => window.__e2e.setPixelRatio(r), PR);
  } else {
    await page.evaluate((r) => window.__e2e.setPixelRatio(r), PR);
  }
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const w = window.__e2e.getWorld();
    const canvas = w.renderer.three.domElement;
    const rect = canvas.getBoundingClientRect();
    return {
      css: { w: rect.width, h: rect.height },
      buf: { w: canvas.width, h: canvas.height },
      dpr: window.devicePixelRatio,
      pr: w.renderer.three.getPixelRatio(),
    };
  });
  log("canvas", JSON.stringify(info));
  check("pixel ratio applied", Math.abs(info.pr - PR) < 1e-6);

  // Points where the worker raycast (the app's own FragmentsModel.raycast
  // equivalent) hits geometry.
  const hits = await page.evaluate(() => window.__e2e.scanHits());
  log(`raycast hits on grid: ${hits.length}`);
  check("model visible to raycast", hits.length >= 3);
  const sample = hits.filter((_, i) => i % Math.max(1, Math.floor(hits.length / 6)) === 0).slice(0, 6);

  async function tapAt(x, y) {
    if (args.mouse) {
      await page.mouse.click(x, y);
      return;
    }
    // Real touch: pointerType "touch", no pointermove before the tap.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(40);
    if (JITTER > 0) {
      // A finger never holds perfectly still: a few CSS px of travel inside the
      // platform's tap slop (~8-10 px) before lift-off.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + JITTER, y: y + JITTER / 2 }] });
      await page.waitForTimeout(30);
      // ...and lifts off where it started, so the expected element is the
      // raycast hit at (x, y) while the gesture travelled JITTER px.
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }
  let okTaps = 0;
  for (const h of sample) {
    await page.evaluate(() => { window.__e2e.picks.length = 0; });
    await tapAt(h.x, h.y);
    // Software GL + a cold worker: allow up to 5 s for the pick to land.
    await page.waitForFunction(() => window.__e2e.picks.length > 0, null, { timeout: 5000 }).catch(() => {});
    const res = await page.evaluate(() => window.__e2e.picks.slice());
    if (!res.length && args.stack) {
      log("    events:", JSON.stringify(await page.evaluate(() => window.__e2eEvents.splice(0))));
    } else {
      await page.evaluate(() => window.__e2eEvents.splice(0));
    }
    const last = res[res.length - 1];
    const ok = !!last && last.expressId === undefined ? false : !!last;
    log(`  tap (${h.x.toFixed(0)},${h.y.toFixed(0)}) raycast=${h.id} pick=${last ? last.expressId : (last === null ? "null(empty-space)" : "none")}`);
    if (ok && last.expressId === h.id) okTaps += 1;
  }
  check("taps on visible elements pick the same element as the raycast", okTaps >= Math.ceil(sample.length * 0.8), `(${okTaps}/${sample.length})`);

  // Unmount / remount must not throw page errors.
  pageErrors.length = 0;
  await page.evaluate(() => window.__e2e.unmount());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__e2e.mount());
  await page.waitForTimeout(2500);
  const camErrors = pageErrors.filter((m) => /No camera initialized/.test(m));
  check("no 'No camera initialized!' after unmount/remount", camErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  await page.screenshot({ path: path.join(os.tmpdir(), "ff-e2e-final.png") });
} finally {
  if (!args.keep) {
    await browser.close();
    await server.close();
  }
}
process.exit(failed ? 1 : 0);
