// packages/ff-viewer-react/perf-harness/main.tsx
//
// Navigation perf harness page. Mounts the REAL <IfcViewer> from
// ../src exactly the way apps/models' ViewerSurface does (files +
// getFragBlob + registerFragments props), but feeds it .frag bytes
// served from disk instead of Dexie, so no Firebase / auth / network
// is involved. Everything the benchmark driver (run.mjs) needs lives
// on `window.__perf`.
//
// URL params:
//   m=<key>.frag      repeatable; one per model, in load order
//   exp=a,b,k:v       experiment flags (see exp.ts / PAGE_EXPERIMENTS)
//   strict=1          wrap in React.StrictMode (the app does in dev)
//   settleCap=<ms>    cap for the wave-38/44 warm pump wait (default 150000)

import { EXP } from "./exp"; // MUST stay first — see exp.ts
import { StrictMode, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as OBC from "@thatopen/components";
// Harness-only: the engine's raycast needs a real Vector2 for `mouse`.
// eslint-disable-next-line no-restricted-imports
import { Vector2, Vector3 } from "three";
import { IfcViewer } from "../src";
import type { IfcViewerHandle, IfcFileListItem, MotionSpeedupsConfig, RenderOnDemandConfig, SplitTileBuildConfig, TileCacheConfig } from "../src";
import { ensureViewerTelemetry } from "../src/telemetry/viewerTelemetry";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Crumb = { t: number; c: string; a: string; d?: Record<string, unknown> };

const params = new URLSearchParams(location.search);
const modelKeys = params.getAll("m");
const settleCapMs = Number(params.get("settleCap") ?? 150_000);
const pickPlan: { pose: unknown; targets: unknown[] } | null = params.get("pickPlan")
  ? JSON.parse(params.get("pickPlan")!)
  : null;
const BUILDING_ID = "perf-building";

const crumbs: Crumb[] = [];
const T0 = performance.now();

// ── Telemetry tap ──────────────────────────────────────────────
// The viewer reports its load lifecycle as telemetry breadcrumbs
// (load-start / load-complete / gate-lift / warm-armed / pump-settle).
// ensureViewerTelemetry() is the same idempotent singleton the viewer
// uses, so wrapping its `breadcrumb` lets the harness observe the
// wave-38/44 pump without touching viewer code.
{
  const tel = ensureViewerTelemetry() as any;
  const orig = tel.breadcrumb.bind(tel);
  tel.breadcrumb = (c: string, a: string, d?: Record<string, unknown>) => {
    crumbs.push({ t: performance.now() - T0, c, a, d });
    return orig(c, a, d);
  };
}

// ── First-visible-tiles sampler (load timeline) ────────────────
// Every 50 ms, count the meshes (tiles) each loaded model has in the
// scene; record a `tiles/first` crumb the first time a model has one
// and a `tiles/all-first` crumb when every model in the URL has one.
// Stops itself once all models are visible (cheap, no per-frame
// traversal during the measured nav phases).
{
  const seen = new Set<string>();
  let throttled = false;
  const iv = setInterval(() => {
    // EXPERIMENT rthrottle:<ms> — from boot, the OBC renderer draws at
    // most once per <ms> (measures how much the per-frame render of a
    // streaming scene slows loading / picks).
    if (!throttled && EXP.has("rthrottle")) {
      const r = getWorld()?.renderer;
      if (r) {
        throttled = true;
        const every = Number(EXP.get("rthrottle"));
        const orig = r.update.bind(r);
        let last = 0;
        r.update = () => {
          const now = performance.now();
          if (now - last < every) return;
          last = now;
          orig();
        };
      }
    }
    const list = (fragmentsMgr as any)?.core?.models?.list;
    if (!list) return;
    for (const [id, m] of list) {
      if (seen.has(id)) continue;
      let n = 0;
      (m as any).object?.traverse?.((o: any) => { if (o.isMesh && o.visible) n++; });
      if (n > 0) {
        seen.add(id);
        crumbs.push({ t: performance.now() - T0, c: "model", a: "first-tiles", d: { file: id, meshes: n } });
      }
    }
    if (modelKeys.length > 0 && seen.size >= modelKeys.length) {
      crumbs.push({ t: performance.now() - T0, c: "model", a: "all-first-tiles" });
      clearInterval(iv);
    }
  }, 50);
}

// ── View-complete sampler (load timeline) ──────────────────────
// "Time until the current view is fully drawn": every 50 ms, once every
// model in the URL is registered, check that NO model is busy (fragments
// `isBusy` = not loaded, a view pass still sweeping on the worker, or
// tile requests still queued on the main thread). The first instant that
// holds for >= VIEW_COMPLETE_HOLD_MS is crumbed `view-complete` (its t is
// the START of the quiet window). Also keeps a coarse stream trace
// (every 250 ms: tile requests queued on main, busy models, tiles in the
// scene) for diagnosing where the fill-in time goes. Stops 1 s after
// `view-complete`, or after 10 min.
const VIEW_COMPLETE_HOLD_MS = 500;
const streamTrace: Array<{ t: number; pending: number; busy: string[]; tiles: number }> = [];
{
  let quietSince: number | null = null;
  let lastTrace = -Infinity;
  let doneAt: number | null = null;
  const iv = setInterval(() => {
    const now = performance.now();
    if (now - T0 > 600_000) { clearInterval(iv); return; }
    const core = (fragmentsMgr as any)?.core;
    const list = core?.models?.list as Map<string, any> | undefined;
    if (!list || modelKeys.length === 0) return;
    const busy: string[] = [];
    let tiles = 0;
    for (const [id, m] of list) {
      if (m.isBusy) busy.push(String(id).split("-")[0]);
      tiles += Number(m.tiles?.size ?? 0);
    }
    if (now - lastTrace >= 250) {
      lastTrace = now;
      streamTrace.push({ t: Math.round(now - T0), pending: core.models.requests?.list?.length ?? -1, busy, tiles });
    }
    if (doneAt !== null) {
      if (now - doneAt > 1000) clearInterval(iv);
      return;
    }
    const allIn = list.size >= modelKeys.length;
    if (!allIn || busy.length > 0) { quietSince = null; return; }
    quietSince ??= now;
    if (now - quietSince >= VIEW_COMPLETE_HOLD_MS) {
      doneAt = now;
      crumbs.push({ t: quietSince - T0, c: "model", a: "view-complete", d: { tiles } });
    }
  }, 50);
}

const files: IfcFileListItem[] = modelKeys.map((key) => ({
  file: { id: key.replace(/\.frag$/, ""), name: key.replace(/\.frag$/, ""), buildingId: BUILDING_ID },
  latestVersion: { id: `${key}-v1`, fragBlobKey: key, versionNumber: 1 },
}));

const fetchTimings: Record<string, { ms: number; bytes: number; src?: string }> = {};

// `--exp=idb`: serve the frag bytes from IndexedDB like the app does
// (Dexie `fragBlobs` rows hold a Blob; Chromium keeps large blobs as
// files on disk). run.mjs seeds the store first in a separate page
// load of the same browser context (`?seedIdb=1`), so the measured
// load reads a real on-disk IDB blob, not an in-memory one.
const IDB_NAME = "ff-perf-frags";
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("fragBlobs", { keyPath: "key" });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function idbReq<T>(rq: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function seedIdb(): Promise<void> {
  const db = await idbOpen();
  for (const key of modelKeys) {
    const res = await fetch(`/__frag/${key}`);
    const blob = await res.blob();
    await idbReq(db.transaction("fragBlobs", "readwrite").objectStore("fragBlobs").put({ key, blob }));
  }
  db.close();
}

async function getFragBlob(key: string): Promise<Blob | null> {
  const t = performance.now();
  if (EXP.has("idb")) {
    const db = await idbOpen();
    const row = await idbReq(db.transaction("fragBlobs", "readonly").objectStore("fragBlobs").get(key)) as { blob: Blob } | undefined;
    db.close();
    if (!row) return null;
    fetchTimings[key] = { ms: Math.round(performance.now() - t), bytes: row.blob.size, src: "idb" };
    return row.blob;
  }
  const res = await fetch(`/__frag/${key}`);
  if (!res.ok) return null;
  const blob = await res.blob();
  fetchTimings[key] = { ms: Math.round(performance.now() - t), bytes: blob.size, src: "http" };
  return blob;
}

const viewerSlice = {
  activeStoreyName: null as string | null,
  setActiveStoreyName: (_n: string | null) => {},
};

let fragmentsMgr: OBC.FragmentsManager | null = null;
function registerFragments(f: OBC.FragmentsManager | null): void {
  fragmentsMgr = f;
}
// `?storeys=1` (measure-check --plan): one synthetic storey tall enough
// to project the whole model, so a level plan can be opened.
const getStoreysForBuilding = async () =>
  params.get("storeys") === "1" ? [{ name: "L1", elevation: 0, height: 40 }] : [];

// ── Helpers ────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
async function until(pred: () => boolean, capMs: number, stepMs = 100): Promise<boolean> {
  const end = performance.now() + capMs;
  while (performance.now() < end) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const r2 = (x: number) => Math.round(x * 100) / 100;

function getWorld(): any {
  const comps = (fragmentsMgr as any)?.components as OBC.Components | undefined;
  if (!comps) return null;
  const worlds = comps.get(OBC.Worlds);
  for (const w of worlds.list.values()) if ((w as any).name === "FreeFieldMain") return w;
  return worlds.list.values().next().value ?? null;
}

function gpuInfo(): Record<string, unknown> {
  const world = getWorld();
  const r = world?.renderer?.three;
  const gl: WebGL2RenderingContext | null = r?.getContext?.() ?? null;
  let unmasked: string | null = null;
  let vendor: string | null = null;
  if (gl) {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) {
      unmasked = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    }
  }
  const canvas = r?.domElement as HTMLCanvasElement | undefined;
  return {
    unmaskedRenderer: unmasked,
    unmaskedVendor: vendor,
    webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext,
    contextAttributes: gl?.getContextAttributes?.() ?? null,
    devicePixelRatio: window.devicePixelRatio,
    rendererPixelRatio: r?.getPixelRatio?.() ?? null,
    canvasCss: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
    drawingBuffer: gl ? { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight } : null,
    viewport: { w: innerWidth, h: innerHeight },
    userAgent: navigator.userAgent,
  };
}

function sceneStats(): Record<string, unknown> {
  const world = getWorld();
  const scene = world?.scene?.three;
  let objects = 0, meshes = 0, visibleMeshes = 0, instanced = 0, instances = 0, lines = 0;
  scene?.traverse?.((o: any) => {
    objects++;
    if (o.isMesh) {
      meshes++;
      let vis = true;
      for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
      if (vis) visibleMeshes++;
      if (o.isInstancedMesh) { instanced++; instances += o.count ?? 0; }
    } else if (o.isLine || o.isLineSegments) lines++;
  });
  const r = world?.renderer?.three;
  const models: Record<string, unknown> = {};
  const list = (fragmentsMgr as any)?.core?.models?.list;
  if (list) for (const [id, m] of list) models[id] = { isBusy: !!m.isBusy };
  return {
    objects, meshes, visibleMeshes, instancedMeshes: instanced, instances, lines,
    memory: r?.info?.memory ? { ...r.info.memory } : null,
    programs: r?.info?.programs?.length ?? null,
    models,
  };
}

// ── Render-call accounting ─────────────────────────────────────
// Wrap WebGLRenderer.render once: three's info.autoReset zeroes the
// counters per render() call, so accumulate after every call and roll
// up per animation frame. Counts ALL renders (main view + any id/
// picking passes) — that is the GPU work the frame actually paid for.
const tally = { renders: 0, calls: 0, tris: 0, points: 0, lines: 0, renderMs: 0 };
function installRenderTap(): void {
  const r = getWorld()?.renderer?.three;
  if (!r || r.__perfTapped) return;
  const orig = r.render.bind(r);
  r.render = (scene: unknown, camera: unknown) => {
    const t = performance.now();
    orig(scene, camera);
    tally.renderMs += performance.now() - t;
    tally.renders++;
    tally.calls += r.info.render.calls;
    tally.tris += r.info.render.triangles;
    tally.points += r.info.render.points;
    tally.lines += r.info.render.lines;
    servePixelRequests(r);
    rodTap(r);
  };
  r.__perfTapped = true;
}

// ── Render-on-demand check (run.mjs --rod-check) ───────────────
// Proves the picture on screen is never stale: while armed, the render
// tap keeps a copy of the LAST main frame drawn into the canvas (= what
// the user sees, since nothing else draws into it). `end()` then forces
// one fresh main render of the current state and diffs it against that
// presented frame. A missed invalidation shows up as differing pixels.
const rod = {
  armed: false,
  lastFrame: null as Uint8Array | null,
  renderTimes: [] as number[],
  stats0: null as any,
  t0: 0,
};
function rodTap(r: any): void {
  if (r.getRenderTarget?.() !== null) return; // id / picking passes
  rod.renderTimes.push(performance.now());
  if (rod.renderTimes.length > 20000) rod.renderTimes.splice(0, 10000);
  if (!rod.armed) return;
  const gl: WebGL2RenderingContext = r.getContext();
  const n = gl.drawingBufferWidth * gl.drawingBufferHeight * 4;
  if (!rod.lastFrame || rod.lastFrame.length !== n) rod.lastFrame = new Uint8Array(n);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, rod.lastFrame);
}
function renderStats(): any {
  return handleRef.current?.getRenderStats?.() ?? null;
}
const rodCheck = {
  /** Arm the presented-frame capture before an action. */
  begin(): void {
    installRenderTap();
    // Per-frame rendering (exp renderalways) cannot leave a stale frame;
    // skip the full-frame readback so its idle CPU number stays fair.
    rod.armed = !EXP.has("renderalways");
    rod.stats0 = renderStats();
    rod.t0 = performance.now();
  },
  /** After the settle wait: idle render rate + stale-pixel diff. */
  async end(label: string): Promise<Record<string, unknown>> {
    const now = performance.now();
    const rendersLast1s = rod.renderTimes.filter((t) => t > now - 1000).length;
    const rendersSinceBegin = rod.renderTimes.filter((t) => t > rod.t0).length;
    const lastRenderAgoMs = rod.renderTimes.length ? Math.round(now - rod.renderTimes[rod.renderTimes.length - 1]) : null;
    const presented = rod.lastFrame ? rod.lastFrame.slice() : null;
    const s1 = renderStats();
    // Force one fresh main render of the current state.
    const before = rod.renderTimes.length;
    const world = getWorld();
    world.renderer.needsUpdate = true;
    for (let i = 0; i < 30 && rod.renderTimes.length === before; i++) await nextFrame();
    const fresh = rod.lastFrame;
    rod.armed = false;
    let diffPx = 0;
    let maxDelta = 0;
    if (presented && fresh && presented.length === fresh.length) {
      for (let i = 0; i < fresh.length; i += 4) {
        const d = Math.max(Math.abs(fresh[i] - presented[i]), Math.abs(fresh[i + 1] - presented[i + 1]), Math.abs(fresh[i + 2] - presented[i + 2]));
        if (d > maxDelta) maxDelta = d;
        if (d > 8) diffPx++;
      }
    }
    const total = fresh ? fresh.length / 4 : 0;
    return {
      label,
      rendersSinceBegin,
      rendersLast1s,
      lastRenderAgoMs,
      staleGuardFrames: s1 && rod.stats0 ? s1.staleFrames - rod.stats0.staleFrames : null,
      byReason: s1 && rod.stats0 ? Object.fromEntries(Object.entries(s1.byReason as Record<string, number>).map(([k, v]) => [k, v - (rod.stats0.byReason[k] ?? 0)]).filter(([, v]) => (v as number) > 0)) : null,
      compared: Boolean(presented && fresh),
      diffPx,
      diffPct: total ? r2((100 * diffPx) / total) : null,
      maxDelta,
    };
  },
  // Actions (page side).
  async hideModel(match: string, visible: boolean): Promise<string> {
    const h = handleRef.current!;
    const all = await h.getAllModelExpressIds();
    const id = [...all.keys()].find((k) => k.includes(match)) ?? [...all.keys()][0];
    h.setElementVisibility(id, new Set(all.get(id) ?? []), visible);
    return `${id}: ${(all.get(id) ?? []).length} ids visible=${visible}`;
  },
  addSection(): string {
    const list = (fragmentsMgr as any).core.models.list as Map<string, any>;
    let box: any = null;
    for (const [, m] of list) { const b = m.box; if (!b || b.isEmpty()) continue; box = box ? box.union(b) : b.clone(); }
    const c = box.getCenter(new Vector3());
    // Vertical cut through the middle, facing the camera side.
    const ok = handleRef.current!.addSectionPlane({ x: c.x, y: c.y, z: c.z }, { x: -1, y: 0, z: 0 });
    return `section at ${[c.x, c.y, c.z].map((v: number) => v.toFixed(1)).join(",")} ok=${ok}`;
  },
  clearSections(): void { handleRef.current!.clearSectionPlanes(); },
  stats: renderStats,
};

// ── Phase measurement ──────────────────────────────────────────
type PhaseState = {
  name: string;
  t0: number;
  lastTs: number | null;
  deltas: number[];
  perFrame: { renders: number[]; calls: number[]; tris: number[]; renderMs: number[] };
  longtasks: { start: number; dur: number }[];
  heap: number[];
  running: boolean;
  obs: PerformanceObserver | null;
  heapTimer: number | null;
};
let phase: PhaseState | null = null;

function heapNow(): number | null {
  const m = (performance as any).memory;
  return m ? m.usedJSHeapSize : null;
}

function camDistance(): { dist: number; pos: number[] } | null {
  const w = getWorld();
  const d = w?.camera?.controls?.distance;
  const p = w?.camera?.three?.position;
  return typeof d === "number" && p ? { dist: r2(d), pos: [r2(p.x), r2(p.y), r2(p.z)] } : null;
}
let phaseCamStart: { dist: number; pos: number[] } | null = null;
function startPhase(name: string): void {
  if (phase?.running) throw new Error(`phase ${phase.name} still running`);
  phaseCamStart = camDistance();
  const st: PhaseState = {
    name, t0: performance.now(), lastTs: null, deltas: [],
    perFrame: { renders: [], calls: [], tris: [], renderMs: [] },
    longtasks: [], heap: [], running: true, obs: null, heapTimer: null,
  };
  try {
    st.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) st.longtasks.push({ start: e.startTime, dur: e.duration });
    });
    st.obs.observe({ type: "longtask", buffered: false });
  } catch { /* longtask unsupported */ }
  const h = heapNow();
  if (h !== null) st.heap.push(h);
  st.heapTimer = window.setInterval(() => {
    const v = heapNow();
    if (v !== null) st.heap.push(v);
  }, 250);
  tally.renders = tally.calls = tally.tris = tally.points = tally.lines = tally.renderMs = 0;
  const loop = (ts: number) => {
    if (!st.running) return;
    if (st.lastTs !== null) {
      st.deltas.push(ts - st.lastTs);
      st.perFrame.renders.push(tally.renders);
      st.perFrame.calls.push(tally.calls);
      st.perFrame.tris.push(tally.tris);
      st.perFrame.renderMs.push(tally.renderMs);
    }
    tally.renders = tally.calls = tally.tris = tally.points = tally.lines = tally.renderMs = 0;
    st.lastTs = ts;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  phase = st;
}

function summarize(xs: number[]): Record<string, number> {
  const s = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    mean: r2(xs.length ? sum / xs.length : NaN),
    p50: r2(pct(s, 50)), p95: r2(pct(s, 95)), max: r2(s.length ? s[s.length - 1] : NaN),
  };
}

function endPhase(): Record<string, unknown> {
  const st = phase;
  if (!st) throw new Error("no phase running");
  st.running = false;
  st.obs?.disconnect();
  if (st.heapTimer !== null) clearInterval(st.heapTimer);
  const h = heapNow();
  if (h !== null) st.heap.push(h);
  const wall = performance.now() - st.t0;
  // Navigation-speedup gestures that ended inside this phase
  // (IfcViewer "nav/motion-end" breadcrumbs).
  const navEnds = crumbs.filter((c) => c.c === "nav" && c.a === "motion-end" && c.t >= st.t0 - T0);
  const navSum = (k: string) => navEnds.reduce((a, c) => a + Number(c.d?.[k] ?? 0), 0);
  const navFrames = navSum("frames");
  const nav = {
    gestures: navEnds.length,
    reasons: navEnds.reduce((m: Record<string, number>, c) => { const r = String(c.d?.reason); m[r] = (m[r] ?? 0) + 1; return m; }, {}),
    motionFrames: navFrames,
    meanHidden: navFrames ? r2(navEnds.reduce((a, c) => a + Number(c.d?.meanHidden ?? 0) * Number(c.d?.frames ?? 0), 0) / navFrames) : 0,
    meanRenderMs: navFrames ? r2(navEnds.reduce((a, c) => a + Number(c.d?.meanRenderMs ?? 0) * Number(c.d?.frames ?? 0), 0) / navFrames) : 0,
    lastBudget: navEnds.length ? navEnds[navEnds.length - 1].d?.budget ?? null : null,
  };
  const d = st.deltas;
  const sorted = [...d].sort((a, b) => a - b);
  const total = d.reduce((a, b) => a + b, 0);
  const ltTotal = st.longtasks.reduce((a, b) => a + b.dur, 0);
  // Frames that actually rendered something (renders > 0) — OBC renders
  // every tick in AUTO mode, but keep the split explicit.
  const renderedIdx = st.perFrame.renders.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  const pick = (arr: number[]) => renderedIdx.map((i) => arr[i]);
  phase = null;
  return {
    name: st.name,
    wallMs: Math.round(wall),
    frames: d.length,
    fpsMean: r2(d.length ? (1000 * d.length) / total : 0),
    frameMs: {
      mean: r2(d.length ? total / d.length : NaN),
      p50: r2(pct(sorted, 50)), p95: r2(pct(sorted, 95)), p99: r2(pct(sorted, 99)),
      max: r2(sorted.length ? sorted[sorted.length - 1] : NaN),
    },
    longFramesOver50ms: d.filter((x) => x > 50).length,
    longFramesOver33ms: d.filter((x) => x > 33.4).length,
    longTasks: {
      count: st.longtasks.length,
      totalMs: Math.round(ltTotal),
      maxMs: Math.round(st.longtasks.reduce((a, b) => Math.max(a, b.dur), 0)),
      pctOfWall: r2((100 * ltTotal) / wall),
    },
    perFrame: {
      renders: summarize(st.perFrame.renders),
      drawCalls: summarize(pick(st.perFrame.calls)),
      triangles: summarize(pick(st.perFrame.tris)),
      renderCpuMs: summarize(pick(st.perFrame.renderMs)),
    },
    heapMB: st.heap.length
      ? {
          start: r2(st.heap[0] / 2 ** 20),
          end: r2(st.heap[st.heap.length - 1] / 2 ** 20),
          max: r2(Math.max(...st.heap) / 2 ** 20),
        }
      : null,
    scene: sceneStats(),
    renderStats: renderStats(),
    nav,
    camera: { start: phaseCamStart, end: camDistance() },
    rawFrameMs: d.map((x) => Math.round(x * 10) / 10),
  };
}

// ── Camera helpers ─────────────────────────────────────────────
async function waitCameraRest(capMs = 4000): Promise<void> {
  const h = handleRef.current;
  if (!h) return;
  let last = h.getViewportRevision();
  let stableSince = performance.now();
  const end = performance.now() + capMs;
  while (performance.now() < end) {
    await nextFrame();
    const v = h.getViewportRevision();
    if (v !== last) { last = v; stableSince = performance.now(); }
    else if (performance.now() - stableSince > 400) return;
  }
}

async function frameAll(): Promise<void> {
  handleRef.current?.resetCameraToDefault();
  await waitCameraRest();
  // pose:in — zoomed-in interior pose: look at the union-bbox centre from
  // a point inside it (frac of the diagonal away, default 0.08).
  const pose = EXP.get("pose");
  if (pose && pose.startsWith("in")) {
    const frac = Number(pose.split("@")[1] ?? 0.08);
    const list = (fragmentsMgr as any).core.models.list as Map<string, any>;
    let box: any = null;
    for (const [, m] of list) { const b = m.box; if (!b || b.isEmpty()) continue; box = box ? box.union(b) : b.clone(); }
    if (box) {
      const c = box.getCenter(new Vector3());
      const d = box.getSize(new Vector3()).length() * frac;
      getWorld().camera.controls.setLookAt(c.x + d * 0.8, c.y + d * 0.15, c.z + d * 0.6, c.x, c.y, c.z, false);
      await waitCameraRest();
    }
  }
}

// Programmatic navigation through the camera-controls API (the
// `--drive=controls` mode). Positions are a function of elapsed time,
// so total motion is identical regardless of frame rate.
async function driveControls(kind: "orbit" | "pan" | "zoom", ms: number): Promise<void> {
  const ctl = getWorld()?.camera?.controls;
  if (!ctl) throw new Error("no camera controls");
  const dist = Math.max(1, ctl.distance ?? 50);
  const t0 = performance.now();
  let prev = 0;
  let prevPan = { x: 0, y: 0 };
  for (;;) {
    await nextFrame();
    const t = Math.min(ms, performance.now() - t0);
    const s = t / 1000;
    if (kind === "orbit") {
      // 36 deg/s azimuth + gentle polar wobble.
      const az = (Math.PI / 5) * s;
      const polarNow = 0.15 * Math.sin((2 * Math.PI * s) / 3.3);
      const polarPrev = 0.15 * Math.sin((2 * Math.PI * prev) / 3.3);
      ctl.rotate((Math.PI / 5) * (s - prev), polarNow - polarPrev, false);
      void az;
    } else if (kind === "pan") {
      const amp = dist * 0.25;
      const x = amp * Math.sin((2 * Math.PI * s) / 2.5);
      const y = 0.5 * amp * Math.sin((2 * Math.PI * s) / 1.7);
      ctl.truck(x - prevPan.x, y - prevPan.y, false);
      prevPan = { x, y };
    } else {
      // In for 1.25 s, out for 1.25 s, repeat. Rate ~40%/s of the start distance.
      const dir = Math.floor(s / 1.25) % 2 === 0 ? 1 : -1;
      ctl.dolly(dir * dist * 0.4 * (s - prev), false);
    }
    prev = s;
    if (t >= ms) break;
  }
  await waitCameraRest(2000);
}

// ── Page experiments (applied after settle, before measuring) ──
// Add entries here to try renderer/engine knobs WITHOUT editing the
// viewer. Viewer-internal experiments read globalThis.__ffPerfExp
// directly (see exp.ts).
const PAGE_EXPERIMENTS: Record<string, (v: string) => string | Promise<string>> = {
  // pr:<n> — renderer pixel ratio (render-resolution scale).
  pr: (v) => {
    const world = getWorld();
    world.renderer.three.setPixelRatio(Number(v));
    world.renderer.resize?.();
    return `pixelRatio=${world.renderer.three.getPixelRatio()}`;
  },
  // maxrate:<ms> — fragments core.settings.maxUpdateRate (camera-driven update throttle).
  maxrate: (v) => {
    const s = (fragmentsMgr as any)?.core?.settings;
    if (s) s.maxUpdateRate = Number(v);
    return `maxUpdateRate=${s?.maxUpdateRate}`;
  },
  // dump — draw-call structure report (no behaviour change).
  dump: () => JSON.stringify(structureDump()),
  // sort0 — renderer.sortObjects = false (skips per-object depth sort).
  sort0: () => { getWorld().renderer.three.sortObjects = false; return "sortObjects=false"; },
  // nofc — frustumCulled=false on fragment meshes (skip three's per-object sphere test).
  nofc: () => { let n = 0; forFragMeshes((m) => { m.frustumCulled = false; n++; }); return `frustumCulled=false on ${n}`; },
  // nomwa — scene.matrixWorldAutoUpdate=false + one manual updateMatrixWorld (static scene).
  nomwa: () => {
    const sc = getWorld().scene.three;
    sc.updateMatrixWorld(true);
    sc.matrixWorldAutoUpdate = false;
    return "scene.matrixWorldAutoUpdate=false";
  },
  // gq:<n> — graphicsQuality on every model + settings (0 default; <0 = more culling). DEFAULT/ALL_GEOMETRY only.
  gq: async (v) => {
    const core = (fragmentsMgr as any).core;
    core.settings.graphicsQuality = Number(v);
    for (const [, m] of core.models.list) m.graphicsQuality = Number(v);
    await core.update(true);
    return `graphicsQuality=${v}`;
  },
  // movegq:<n> — "lighter while moving": graphicsQuality=n between controlstart and rest.
  movegq: (v) => {
    const core = (fragmentsMgr as any).core;
    const ctl = getWorld().camera.controls;
    let saved: number | null = null;
    ctl.addEventListener("controlstart", () => {
      if (saved !== null) return;
      saved = core.settings.graphicsQuality;
      for (const [, m] of core.models.list) m.graphicsQuality = Number(v);
      void core.update(true);
    });
    ctl.addEventListener("rest", () => {
      if (saved === null) return;
      for (const [, m] of core.models.list) m.graphicsQuality = saved;
      saved = null;
      void core.update(true);
    });
    return `movegq=${v}`;
  },
  // movehide:<n> — main-thread "lighter while moving": while the camera
  // moves, hide fragment meshes with fewer than n triangles (cheap tiles
  // = mostly small objects); restore at rest. No worker round-trip.
  movehide: (v) => {
    const ctl = getWorld().camera.controls;
    const lim = Number(v) * 3;
    let hidden: any[] | null = null;
    ctl.addEventListener("controlstart", () => {
      if (hidden) return;
      hidden = [];
      forFragMeshes((m) => {
        const n = m.geometry.index ? m.geometry.index.count : 0;
        if (m.visible && n < lim) { m.visible = false; hidden!.push(m); }
      });
    });
    ctl.addEventListener("rest", () => {
      if (!hidden) return;
      for (const m of hidden) m.visible = true;
      hidden = null;
    });
    return `movehide<${v}tris`;
  },
  // movecull:<px> — main-thread screen-size cull WHILE MOVING: between
  // controlstart and rest, hide fragment tiles whose bounding sphere
  // projects to < px pixels radius (small tiles = small objects; tiles
  // are grouped by item dimension class). Restored every frame / at rest.
  movecull: (v) => installScreenCull(Number(v), true),
  // scull:<px> — the same cull, always on (also at rest).
  scull: (v) => installScreenCull(Number(v), false),
};
function installScreenCull(px: number, onlyMoving: boolean): string {
  const world = getWorld();
  const scene = world.scene.three;
  const r = world.renderer.three;
  const ctl = world.camera.controls;
  let moving = !onlyMoving;
  const culled: any[] = [];
  const restore = () => { for (const m of culled) m.visible = true; culled.length = 0; };
  if (onlyMoving) {
    ctl.addEventListener("controlstart", () => { moving = true; });
    ctl.addEventListener("control", () => { moving = true; }); // wheel zoom emits no controlstart
    ctl.addEventListener("rest", () => { moving = false; });
  }
  const meshes: any[] = [];
  forFragMeshes((m) => meshes.push(m));
  let meshesAt = performance.now();
  const v = new Vector3();
  const prev = scene.onBeforeRender;
  const stats = { frames: 0, culled: 0 };
  (perf as any).cullStats = stats;
  scene.onBeforeRender = function (this: unknown, ...a: any[]) {
    prev.apply(scene, a);
    restore();
    if (!moving) return;
    const cam = a[2];
    if (typeof cam.fov !== "number") return;
    if (performance.now() - meshesAt > 500) { meshes.length = 0; forFragMeshes((m) => meshes.push(m)); meshesAt = performance.now(); }
    const k = r.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const m of meshes) {
      if (!m.visible) continue;
      const sph = m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere);
      if (!sph) continue;
      v.copy(sph.center).applyMatrix4(m.matrixWorld);
      const d = v.distanceTo(cam.position);
      if (d > sph.radius && (sph.radius * k) / d < px) { m.visible = false; culled.push(m); }
    }
    stats.frames++; stats.culled += culled.length;
  };
  return `screenCull<${px}px${onlyMoving ? " while moving" : " always"}`;
}
function forFragMeshes(fn: (m: any) => void): void {
  const list = (fragmentsMgr as any)?.core?.models?.list as Map<string, any> | undefined;
  if (!list) return;
  for (const [, model] of list) model.object.traverse((o: any) => { if (o.isMesh) fn(o); });
}
// Per-model / per-material breakdown of what three draws.
function structureDump(): Record<string, unknown> {
  const world = getWorld();
  const r = world.renderer.three;
  const scene = world.scene.three;
  const list = (fragmentsMgr as any)?.core?.models?.list as Map<string, any>;
  const out: Record<string, unknown> = {};
  const triBuckets = [10, 100, 1000, 10000, 1e9];
  for (const [id, model] of list) {
    let meshes = 0, vis = 0, tris = 0, transp = 0, withBR = 0, lines = 0;
    const mats = new Set<unknown>(); const progKeys = new Set<string>();
    const hist = triBuckets.map(() => 0);
    const radii: number[] = [];
    model.object.traverse((o: any) => {
      if (o.isLine || o.isLineSegments) lines++;
      if (!o.isMesh) return;
      meshes++; if (o.visible) vis++;
      const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position?.count ?? 0) / 3;
      tris += n;
      hist[triBuckets.findIndex((b) => n < b)]++;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) { mats.add(m); if (m.transparent) transp++; progKeys.add(`${m.type}|${m.transparent}|${m.clippingPlanes?.length ?? 0}`); }
      if (o.onBeforeRender && o.onBeforeRender.toString().length > 20) withBR++;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      radii.push(o.geometry.boundingSphere.radius);
    });
    radii.sort((a, b) => a - b);
    out[id.slice(0, 24)] = {
      meshes, vis, lines, tris, mats: mats.size, transp, withBR, progKeys: [...progKeys],
      trisHist: Object.fromEntries(triBuckets.map((b, i) => [`<${b}`, hist[i]])),
      radiusP50: r2(pct(radii, 50)), radiusP90: r2(pct(radii, 90)),
      children: model.object.children.length,
      sample: (() => { const c = model.object.children.find((o: any) => o.isMesh); return c ? { ud: c.userData, fc: c.frustumCulled, mau: c.matrixAutoUpdate, mwau: c.matrixWorldAutoUpdate, uwm: c.updateWorldMatrix?.name } : null; })(),
    };
  }
  let lights = 0; scene.traverse((o: any) => { if (o.isLight) lights++; });
  out.renderer = { sortObjects: r.sortObjects, localClipping: r.localClippingEnabled, globalClip: r.clippingPlanes.length, lights, sceneChildren: scene.children.length, shadow: r.shadowMap.enabled, toneMapping: r.toneMapping };
  return out;
}
async function applyPageExperiments(): Promise<string[]> {
  const applied: string[] = [];
  for (const [k, v] of EXP) {
    const fn = PAGE_EXPERIMENTS[k];
    if (fn) applied.push(`${k}: ${await fn(v)}`);
  }
  return applied;
}

// ── Pick-after-load gate support ───────────────────────────────
// Targets are chosen ONCE per scenario by calibratePickTargets() on a
// fully warmed viewer (framed pose), verified with the engine's worker
// raycast, cached by run.mjs, and replayed on a fresh load via
// `?pickPlan=<json>`: the pose is applied as soon as every model has
// loaded (before the overlay lifts) so the screen points are stable.

type PickTargetSpec = { label: string; model: string; categories: string; name?: string; max?: number };
type PickTarget = {
  label: string; modelId: string; expressId: number; category: string; name?: string;
  clientX: number; clientY: number; diag: number;
};

// Camera pose read/write straight through camera-controls. NOT the
// viewer's getPose(): it hands camera-controls' getTarget() a plain
// object, which getTarget() ignores (it only fills a real Vector3), so
// getPose().target is always [0,0,0] — see the harness report.
type Pose = { pos: number[]; target: number[]; fov: number };
function readPose(): Pose | null {
  const world = getWorld();
  if (!world) return null;
  const c = world.camera.three;
  const t = world.camera.controls.getTarget(new Vector3());
  return { pos: [c.position.x, c.position.y, c.position.z], target: [t.x, t.y, t.z], fov: c.fov };
}
function applyPose(p: Pose): void {
  const world = getWorld();
  const c = world.camera.three;
  if (typeof c.fov === "number" && p.fov) { c.fov = p.fov; c.updateProjectionMatrix(); }
  world.camera.controls.setLookAt(p.pos[0], p.pos[1], p.pos[2], p.target[0], p.target[1], p.target[2], false);
}

async function castAt(clientX: number, clientY: number): Promise<{ modelId: string; localId: number } | null> {
  const world = getWorld();
  const frags = fragmentsMgr as any;
  if (!world || !frags?.raycast) return null;
  const mouse = new Vector2(clientX, clientY);
  const hit = await frags.raycast({ camera: world.camera.three, dom: world.renderer.three.domElement, mouse });
  if (!hit) return null;
  return { modelId: hit.fragments?.modelId ?? hit.modelId, localId: hit.localId };
}

async function calibratePickTargets(specs: PickTargetSpec[]): Promise<{ targets: PickTarget[]; pose: unknown; notes: string[] }> {
  const world = getWorld();
  const cam = world.camera.three;
  const rect = world.renderer.three.domElement.getBoundingClientRect();
  const list = (fragmentsMgr as any).core.models.list as Map<string, any>;
  const targets: PickTarget[] = [];
  const notes: string[] = [];
  for (const spec of specs) {
    const entry = [...list.entries()].find(([id]) => id.includes(spec.model));
    if (!entry) { notes.push(`${spec.label}: no model matching ${spec.model}`); continue; }
    const [modelId, model] = entry;
    const re = new RegExp(spec.categories, "i");
    const cats: string[] = await model.getCategories();
    const hitCats = cats.filter((c) => re.test(c));
    if (!hitCats.length) { notes.push(`${spec.label}: no category /${spec.categories}/ in ${modelId} (has: ${cats.slice(0, 40).join(",")})`); continue; }
    const byCat: Record<string, number[]> = await model.getItemsOfCategories(hitCats.map((c) => new RegExp(`^${c}$`)));
    const ids: { id: number; cat: string }[] = [];
    for (const [cat, arr] of Object.entries(byCat)) for (const id of arr) ids.push({ id, cat });
    ids.sort((a, b) => a.id - b.id);
    const sample = ids.slice(0, 1500);
    const boxes: any[] = await model.getBoxes(sample.map((s) => s.id));
    let cands = sample
      .map((s, i) => ({ ...s, box: boxes[i], name: "" }))
      .filter((c) => c.box && Number.isFinite(c.box.min.x))
      .map((c) => ({ ...c, diag: c.box.min.distanceTo(c.box.max) }))
      .sort((a, b) => b.diag - a.diag || a.id - b.id);
    if (spec.name) {
      // Disambiguate IFC2x3 generic classes (IfcFlowSegment = duct OR
      // pipe) by Name / ObjectType.
      const top = cands.slice(0, 400);
      const data: any[] = await model.getItemsData(top.map((c) => c.id), { attributesDefault: false, attributes: ["Name", "ObjectType"] });
      const nre = new RegExp(spec.name, "i");
      top.forEach((c, i) => {
        const d = data[i] ?? {};
        c.name = `${d.Name?.value ?? ""} | ${d.ObjectType?.value ?? ""}`;
      });
      const before = top.length;
      cands = top.filter((c) => nre.test(c.name));
      if (!cands.length) notes.push(`${spec.label}: no Name/ObjectType match /${spec.name}/ among ${before}; sample names: ${top.slice(0, 8).map((c) => c.name).join(" ; ")}`);
    }
    let found: PickTarget | null = null;
    let tried = 0;
    for (const c of cands) {
      if (tried >= (spec.max ?? 80)) break;
      const p = c.box.min.clone().add(c.box.max).multiplyScalar(0.5).project(cam);
      if (p.z > 1 || p.z < -1) continue;
      const x = rect.left + ((p.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - p.y) / 2) * rect.height;
      if (x < rect.left + 40 || x > rect.right - 40 || y < rect.top + 40 || y > rect.bottom - 40) continue;
      if (targets.some((t) => Math.hypot(t.clientX - x, t.clientY - y) < 30)) continue;
      tried++;
      const hit = await castAt(x, y);
      if (hit && hit.modelId === modelId && hit.localId === c.id) {
        found = { label: spec.label, modelId, expressId: c.id, category: c.cat, name: c.name || undefined, clientX: Math.round(x), clientY: Math.round(y), diag: r2(c.diag) };
        break;
      }
    }
    if (found) targets.push(found);
    else notes.push(`${spec.label}: no unoccluded on-screen candidate among ${tried} tried (${ids.length} in /${spec.categories}/)`);
  }
  return { targets, pose: readPose(), notes };
}

// Selection events (listener + timestamp).
const selEvents: { t: number; sel: { modelId: string; ids: number[] }[] }[] = [];
let selSubscribed = false;
function subscribeSelection(): void {
  if (selSubscribed || !handleRef.current) return;
  selSubscribed = true;
  handleRef.current.onSelectionChange((sel) => {
    const flat = [...sel.entries()].map(([modelId, ids]) => ({ modelId, ids: [...ids] }));
    selEvents.push({ t: performance.now(), sel: flat });
  });
}

// Pixel readback from inside the render tap (default framebuffer only,
// right after the main render — preserveDrawingBuffer is off, so this is
// the only moment the pixel is valid).
type PixReq = { x: number; y: number; resolve: (rgb: number[]) => void };
const pixReqs: PixReq[] = [];
function servePixelRequests(r: any): void {
  if (!pixReqs.length || r.getRenderTarget?.() !== null) return;
  const gl: WebGL2RenderingContext = r.getContext();
  const pr = r.getPixelRatio();
  const canvas = r.domElement as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const buf = new Uint8Array(4 * 9);
  for (const q of pixReqs.splice(0)) {
    const px = Math.round((q.x - rect.left) * pr);
    const py = Math.round(gl.drawingBufferHeight - (q.y - rect.top) * pr);
    gl.readPixels(px - 1, py - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // 3x3 block as 9 rgb triplets (flat, 27 numbers). Thin elements can
    // be ~1 px wide, so tint detection is per pixel (see isTinted).
    const out: number[] = [];
    for (let i = 0; i < 9; i++) out.push(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
    q.resolve(out);
  }
}
function samplePixel(x: number, y: number, capMs = 500): Promise<number[] | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), capMs);
    pixReqs.push({ x, y, resolve: (rgb) => { clearTimeout(t); resolve(rgb); } });
  });
}
// Highlight tint = 50% blend of #ff6a00 (getSelectStyle) over the
// element colour, so it pushes red up and blue down.
// Per pixel of the 3x3 block: tinted when red-minus-blue rose by >= 25
// AND blue dropped by >= 15 vs the pre-click sample, with red >= 120.
function isTinted(pre: number[] | null, now: number[]): boolean {
  for (let i = 0; i < 9; i++) {
    const [r, , b] = [now[i * 3], now[i * 3 + 1], now[i * 3 + 2]];
    const [pr, , pb] = pre ? [pre[i * 3], pre[i * 3 + 1], pre[i * 3 + 2]] : [0, 0, 0];
    if (r >= 120 && r - b - (pr - pb) >= 25 && pb - b >= 15) return true;
  }
  return false;
}

const pickGate = {
  liftT: null as number | null,
  // Diagnostic: current pose + what the worker raycast sees at each target point.
  async verify(targets: PickTarget[]): Promise<{ pose: unknown; hits: unknown[] }> {
    const hits = [];
    const world = getWorld();
    const rect = world.renderer.three.domElement.getBoundingClientRect();
    const list = (fragmentsMgr as any).core.models.list as Map<string, any>;
    for (const t of targets) {
      let projected: number[] | null = null;
      const m = list.get(t.modelId);
      if (m) {
        const [b] = await m.getBoxes([t.expressId]);
        if (b) {
          const p = b.min.clone().add(b.max).multiplyScalar(0.5).project(world.camera.three);
          projected = [Math.round(rect.left + ((p.x + 1) / 2) * rect.width), Math.round(rect.top + ((1 - p.y) / 2) * rect.height)];
        }
      }
      hits.push({ label: t.label, hit: await castAt(t.clientX, t.clientY), projected });
    }
    return { pose: readPose(), hits };
  },
  sinceLift(): number { return pickGate.liftT === null ? NaN : performance.now() - pickGate.liftT; },
  async prepareClick(t: { clientX: number; clientY: number }): Promise<{ pre: number[] | null; mark: number; busy: boolean }> {
    handleRef.current?.clearSelection();
    await nextFrame(); await nextFrame();
    const pre = await samplePixel(t.clientX, t.clientY);
    let busy = false;
    const list = (fragmentsMgr as any)?.core?.models?.list;
    if (list) for (const [, m] of list) if (m.isBusy) busy = true;
    return { pre, mark: performance.now(), busy };
  },
  // Wait for the first selection event after `mark`; null on timeout.
  async waitSelection(mark: number, timeoutMs: number): Promise<{ ms: number; sel: { modelId: string; ids: number[] }[] } | null> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const ev = selEvents.find((e) => e.t > mark && e.sel.length > 0);
      if (ev) return { ms: Math.round(ev.t - mark), sel: ev.sel };
      if (performance.now() > end) return null;
      await nextFrame();
    }
  },
  async watchHighlight(x: number, y: number, pre: number[] | null, mark: number, timeoutMs: number): Promise<{ ms: number; rgb: number[] } | { ms: null; rgb: number[] | null }> {
    const end = performance.now() + timeoutMs;
    let last: number[] | null = null;
    while (performance.now() < end) {
      const rgb = await samplePixel(x, y, 200);
      if (rgb) {
        last = rgb;
        if (isTinted(pre, rgb)) return { ms: Math.round(performance.now() - mark), rgb };
      }
    }
    return { ms: null, rgb: last };
  },
};

// ── Load + settle orchestration ────────────────────────────────
const timings: Record<string, number | null> = {};
const handleRef: { current: IfcViewerHandle | null } = { current: null };

const perf = {
  status: "booting" as "booting" | "loading" | "settling" | "ready" | "pick-ready" | "error",
  error: null as string | null,
  exp: Object.fromEntries(EXP),
  pageExperiments: [] as string[],
  crumbs,
  streamTrace,
  timings,
  fetchTimings,
  get handle() { return handleRef.current; },
  get fragments() { return fragmentsMgr; },
  get components() { return (fragmentsMgr as any)?.components ?? null; },
  get world() { return getWorld(); },
  OBC,
  gpuInfo,
  sceneStats,
  frameAll,
  waitCameraRest,
  startPhase,
  endPhase,
  driveControls,
  calibratePickTargets,
  pickGate,
  rodCheck,
  selEvents,
  canvasRect():{ x: number; y: number; w: number; h: number } | null {
    const c = getWorld()?.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  },
};
(window as any).__perf = perf;

async function settle(): Promise<void> {
  try {
    perf.status = "loading";
    const n = files.length;
    const count = (a: string) => crumbs.filter((c) => c.c === "model" && c.a === a).length;
    const ok = await until(() => count("load-complete") + count("load-fail") >= n, 600_000, 50);
    if (!ok) throw new Error("models did not finish loading within 600 s");
    if (count("load-fail") > 0) throw new Error(`model load failed: ${JSON.stringify(crumbs.filter((c) => c.a === "load-fail"))}`);
    timings.allLoadedMs = Math.round(performance.now() - T0);
    if (pickPlan) {
      // Pick-after-load gate: do NOT wait for the warm pump. Apply the
      // calibrated pose now (before the overlay lifts) and hand over at
      // gate-lift — the moment the loading overlay disappears.
      installRenderTap();
      subscribeSelection();
      if (pickPlan.pose) applyPose(pickPlan.pose as any);
      await until(() => count("gate-lift") > 0, 180_000, 5);
      const gl = crumbs.find((c) => c.a === "gate-lift");
      if (!gl) throw new Error("gate-lift breadcrumb never arrived");
      pickGate.liftT = T0 + gl.t;
      timings.gateLiftMs = Math.round(gl.t);
      perf.status = "pick-ready";
      return;
    }
    perf.status = "settling";
    // Phase 1 (gate lift) → phase 2 (lod-armed per model, ends with
    // `lod-settle`; older viewer builds: warm pump → `pump-settle`).
    await until(() => count("gate-lift") > 0, 180_000, 50);
    timings.gateLiftMs = crumbs.find((c) => c.a === "gate-lift")?.t ?? null;
    const isSettle = (c: Crumb) => c.c === "model" && (c.a === "lod-settle" || c.a === "pump-settle");
    const settled = await until(() => crumbs.some(isSettle), settleCapMs, 100);
    const ps = crumbs.find(isSettle);
    timings.pumpSettleMs = ps ? Math.round(ps.t) : null;
    timings.pumpFrames = (ps?.d?.frames as number) ?? null;
    timings.pumpCapped = settled ? 0 : 1;
    // Then require every model idle (isBusy false) for 1 s, cap 20 s.
    let quietSince: number | null = null;
    await until(() => {
      const list = (fragmentsMgr as any)?.core?.models?.list;
      let busy = false;
      if (list) for (const [, m] of list) if (m.isBusy) busy = true;
      if (busy) { quietSince = null; return false; }
      quietSince ??= performance.now();
      return performance.now() - quietSince > 1000;
    }, 20_000, 100);
    timings.idleMs = Math.round(performance.now() - T0);
    installRenderTap();
    perf.pageExperiments = await applyPageExperiments();
    await frameAll();
    timings.readyMs = Math.round(performance.now() - T0);
    perf.status = "ready";
  } catch (err) {
    perf.error = err instanceof Error ? err.message : String(err);
    perf.status = "error";
  }
}

// Built-in navigation speedups (IfcViewer `motionSpeedups` prop) —
// overrides for A/B runs:
//   nospeedups        motionSpeedups={false}
//   movebudget:<N>    fixed motion tile budget N (0 = budget off)
//   movepr:<x>        moving pixel-ratio factor (1 = off)
//   nofreeze          keep refreshing tiles while moving
function motionSpeedupsFromExp(): MotionSpeedupsConfig | false | undefined {
  if (EXP.has("nospeedups")) return false;
  const cfg: MotionSpeedupsConfig = {};
  if (EXP.has("movebudget")) {
    const n = Number(EXP.get("movebudget"));
    cfg.budget = n > 0 ? { min: n, max: n, initial: n } : false;
  }
  if (EXP.has("movepr")) cfg.movingPixelRatioScale = Number(EXP.get("movepr"));
  if (EXP.has("nofreeze")) cfg.freezeView = false;
  return Object.keys(cfg).length ? cfg : undefined;
}
const MOTION_SPEEDUPS = motionSpeedupsFromExp();

// Render on demand (IfcViewer `renderOnDemand` prop) — A/B overrides:
//   renderalways      renderOnDemand={false} (render every frame, AUTO)
//   rodka:<ms>        keep-alive window after an invalidation
//   rodhb:<ms>        idle heartbeat period (0 = off, the default)
function renderOnDemandFromExp(): RenderOnDemandConfig | boolean {
  if (EXP.has("renderalways")) return false;
  const cfg: RenderOnDemandConfig = {};
  if (EXP.has("rodka")) cfg.keepAliveMs = Number(EXP.get("rodka"));
  if (EXP.has("rodhb")) cfg.heartbeatMs = Number(EXP.get("rodhb"));
  return Object.keys(cfg).length ? cfg : true;
}
const RENDER_ON_DEMAND = renderOnDemandFromExp();

// Split tile build (IfcViewer `splitTileBuild` prop, default off) — A/B:
//   split             splitTileBuild={true} (auto helper count)
//   split:<N>         N helper workers per big model
//   splitinf:<N>      tile builds in flight per helper
//   splitmin:<MB>     minimum model size in MB
function splitTileBuildFromExp(): SplitTileBuildConfig | boolean {
  if (!EXP.has("split")) return false;
  const cfg: SplitTileBuildConfig = {};
  if (EXP.get("split")) cfg.helpers = Number(EXP.get("split"));
  if (EXP.has("splitinf")) cfg.inflight = Number(EXP.get("splitinf"));
  if (EXP.has("splitmin")) cfg.minBytes = Number(EXP.get("splitmin")) * 1024 * 1024;
  return Object.keys(cfg).length ? cfg : true;
}
const SPLIT_TILE_BUILD = splitTileBuildFromExp();

// Tile cache (IfcViewer `tileCache` prop, default on) — A/B:
//   notilecache       tileCache={false}
//   tcmin:<MB>        minimum model size in MB
function tileCacheFromExp(): TileCacheConfig | boolean {
  if (EXP.has("notilecache")) return false;
  if (EXP.has("tcmin")) return { minBytes: Number(EXP.get("tcmin")) * 1024 * 1024 };
  return true;
}
const TILE_CACHE = tileCacheFromExp();

function Harness(): JSX.Element {
  const ref = useRef<IfcViewerHandle | null>(null);
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <IfcViewer
        ref={(h) => { ref.current = h; handleRef.current = h; }}
        projectId="perf-project"
        activeBuildingId={BUILDING_ID}
        files={files}
        getFragBlob={getFragBlob}
        registerFragments={registerFragments}
        getStoreysForBuilding={getStoreysForBuilding}
        viewerSlice={viewerSlice}
        motionSpeedups={MOTION_SPEEDUPS}
        renderOnDemand={RENDER_ON_DEMAND}
        splitTileBuild={SPLIT_TILE_BUILD}
        tileCache={TILE_CACHE}
      />
    </div>
  );
}

if (params.get("seedIdb") === "1") {
  // Seed page (run.mjs --exp=idb): store the frags, mount nothing.
  (window as any).__perf = { status: "seeding", error: null };
  seedIdb().then(
    () => { (window as any).__perf.status = "seeded"; },
    (err) => { (window as any).__perf.status = "error"; (window as any).__perf.error = String(err); },
  );
} else {
  const root = createRoot(document.getElementById("root")!);
  root.render(params.get("strict") === "1" ? <StrictMode><Harness /></StrictMode> : <Harness />);
  void settle();
}
