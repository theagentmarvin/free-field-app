// packages/ff-viewer-react/perf-harness/measure-check.mjs
//
// Wave 67: drive the 3D measurement tools in the real <IfcViewer> and
// dump evidence (DOM label layer, scene lines, screenshots).
//
//   FF_PERF_DIR=<dir> flock <dir>/bench.lock node perf-harness/measure-check.mjs \
//     --variant=length --out=<dir>/shots --tag=before [--headless]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkgRequire = createRequire(path.join(pkgRoot, "package.json"));
const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return [m[1], m[2] ?? true]; }));
const perfDir = process.env.FF_PERF_DIR ?? path.join(os.homedir(), ".cache/ff-perf-verify");
const cacheDir = opt["cache-dir"] ?? path.join(os.homedir(), ".cache/ff-perf-verify/perf-cache");
const outDir = opt.out ?? path.join(perfDir, "shots");
fs.mkdirSync(outDir, { recursive: true });
const tag = opt.tag ?? "run";
const frag = fs.readdirSync(cacheDir).find((f) => f.startsWith(opt.model ?? "STRUCTURAL_VDC_SM_GUID") && f.endsWith(".frag"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pw = createRequire(import.meta.url)(process.env.FF_PLAYWRIGHT_CORE ?? "playwright-core");
process.env.FF_PERF_FRAG_DIR = cacheDir;
const vitePkg = pkgRequire.resolve("vite/package.json");
const vite = await import(pathToFileURL(path.join(path.dirname(vitePkg), "dist/node/index.js")).href);
const server = await vite.createServer({ configFile: path.join(here, "vite.config.ts"), server: { port: Number(opt.port ?? 5391), strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await pw.chromium.launch({ headless: !!opt.headless, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=gl"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 }, deviceScaleFactor: 1 })).newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => errors.push("pageerror " + String(e.stack ?? e).slice(0, 700)));
const result = { tag, errors };
try {
  await page.goto(`${base}?m=${frag}${opt.plan ? "&storeys=1" : ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__perf && ["ready", "error"].includes(window.__perf.status), null, { timeout: 180000 });
  await page.evaluate(() => window.__perf.frameAll());
  await sleep(2500);
  const rect = await page.evaluate(() => window.__perf.canvasRect());
  if (opt.plan) {
    const ok = await page.evaluate(() => window.__perf.handle.openLevel("L1"));
    result.planOpened = ok;
    await sleep(4000);
    await page.screenshot({ path: path.join(outDir, `${tag}-plan-open.png`) });
    // Armed by openLevel (2D system). Click along projection lines.
    const r2 = await page.evaluate(() => window.__perf.canvasRect());
    const pcx = r2.x + r2.w / 2, pcy = r2.y + r2.h / 2;
    result.activeTool = await page.evaluate(() => window.__perf.handle.activeTool);
    const P = opt.planPts ? JSON.parse(opt.planPts) : [[-150, 0], [150, 0]];
    for (const [dx, dy] of P) {
      await page.mouse.move(pcx + dx, pcy + dy, { steps: 8 });
      await sleep(700);
      await page.screenshot({ path: path.join(outDir, `${tag}-plan-move-${dx}.png`) });
      await page.mouse.click(pcx + dx, pcy + dy);
      await sleep(900);
    }
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, `${tag}-plan-after.png`) });
    result.planEntries = await page.evaluate(() => window.__perf.handle.getMeasurements());
    console.log(JSON.stringify(result, null, 1));
    await browser.close();
    await server.close();
    process.exit(0);
  }
  const variants = String(opt.variant ?? "length").split(",");
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const PTS = {
    length: [[-120, 40], [140, -30]],
    area: [[-200, 120], [-100, 130], [-110, 60], [-210, 50]],
    angle: opt.degenerate ? [[60, 120], [60, 120], [60, 120]] : [[-60, -40], [40, 20], [130, -60]],
    volume: [[-30, -60]],
  };
  for (const variant of variants) {
    await page.evaluate((v) => window.__perf.handle.setMeasureMode("measure", v), variant);
    const pts = PTS[variant];
    let idx = 0;
    for (const [dx, dy] of pts) {
      await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
      await sleep(900);
      if (idx++ === (variant === "length" ? 1 : 0)) await page.screenshot({ path: path.join(outDir, `${tag}-${variant}-preview.png`) });
      await page.mouse.click(cx + dx, cy + dy);
      await sleep(700);
    }
    if (variant === "area") { await page.mouse.dblclick(cx + pts[3][0], cy + pts[3][1]); await sleep(900); }
    if (variant === "volume") { await page.mouse.click(cx + 20, cy + 20); await sleep(900); await page.keyboard.press("Enter"); await sleep(1500); }
    await sleep(1200);
  }
  await page.screenshot({ path: path.join(outDir, `${tag}-${variants.join("+")}-armed.png`) });
  await page.evaluate(() => window.__perf.handle.setMeasureMode("select"));
  await sleep(1200);
  await page.screenshot({ path: path.join(outDir, `${tag}-${variants.join("+")}-disarmed.png`) });
  result.list = await page.evaluate(() => window.__perf.handle.getMeasurements?.());
  if (opt.focus && result.list?.length) {
    await page.evaluate((id) => window.__perf.handle.focusMeasurement(id), result.list[0].id);
    await sleep(2500);
    await page.screenshot({ path: path.join(outDir, `${tag}-focus.png`) });
    await page.evaluate((id) => window.__perf.handle.deleteMeasurement(id), result.list[0].id);
    await sleep(800);
    result.afterDelete = await page.evaluate(() => window.__perf.handle.getMeasurements().length);
    await page.screenshot({ path: path.join(outDir, `${tag}-after-delete.png`) });
  }
  result.idle = await page.evaluate(async () => {
    const h = window.__perf.handle; const a = h.getRenderStats?.(); const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2500));
    const b = h.getRenderStats?.();
    return { rendersPerSec: a && b ? (b.renders - a.renders) / ((performance.now() - t0) / 1000) : null, keys: b ? Object.keys(b).slice(0, 12) : null };
  });
  console.log(JSON.stringify(result, null, 1));
} catch (e) {
  result.fail = String(e);
  console.log(JSON.stringify(result, null, 1));
} finally {
  await browser.close();
  await server.close();
}
