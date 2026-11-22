// Browser-only: load two PDF versions and rasterise one page of each into
// the Base frame. Uses pdf.js directly (not api.renderPage, which caps by
// the device pixel ratio). Rendered rasters are kept in an LRU (rasterCache)
// so a settings change re-runs only the diff.

import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { loadPDF, type PdfApi } from "@ff/viewer";
import type { CompareSide, RasterPage } from "../types";
import type { StageTimer } from "./debugTiming";
import { computeGeometry, placeInFrame } from "./geometry";
import { getCachedSize, rasterCache, rasterKey, setCachedSize } from "./rasterCache";
import { yieldFrame } from "./yieldFrame";

export { MAX_RASTER_PIXELS, SIZE_MISMATCH_TOLERANCE } from "./geometry";

export interface RasterizedPair {
  /** Private buffers (safe to transfer to a worker; the cache keeps its own copy). */
  base: RasterPage;
  /** Revision in the Base frame (rescaled to the Base page width, top-left aligned). */
  revision: RasterPage;
  /** Actual raster px per Base page pt (base.width / pageWidthPt). */
  scale: number;
  pageWidthPt: number;
  pageHeightPt: number;
  /** Factor applied to the Revision render scale (1 = same page size). */
  revisionScale: number;
  downscaled: boolean;
  aspectMismatch: boolean;
  /** Sides served from the raster cache (0..2). */
  cacheHits: number;
}

export interface RasterizeOptions {
  dpi: number | "auto";
  signal?: AbortSignal;
  onStage?: (stage: "loading" | "rendering") => void;
  timer?: StageTimer;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function openSide(side: CompareSide, timer?: StageTimer): Promise<PdfApi> {
  const t0 = performance.now();
  const version = await getPdfVersion(side.pdfVersionId);
  if (!version) throw new Error(`PDF version not found: ${side.pdfVersionId}`);
  const blob = await getPdfBlob(version.blobKey);
  if (!blob) throw new Error(`PDF data is not available for version ${side.pdfVersionId}`);
  const t1 = performance.now();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const api = await loadPDF(bytes, { singlePage: false, devicePixelRatio: 1 });
  timer?.add("loadBlob", t1 - t0);
  timer?.add("loadPDF", performance.now() - t1);
  return api;
}

async function pageSizePt(api: PdfApi, pageNum: number): Promise<{ w: number; h: number }> {
  if (pageNum < 1 || pageNum > api.numPages) {
    throw new Error(`Page ${pageNum} is out of range (1-${api.numPages})`);
  }
  const page = await api.doc.getPage(pageNum);
  // getViewport honours the page's /Rotate.
  const vp = page.getViewport({ scale: 1 });
  return { w: vp.width, h: vp.height };
}

interface RenderTarget {
  /** Final raster size. */
  width: number;
  height: number;
  /** >1 / <1: resample the render by this factor into the frame (smoothed). */
  resampleFactor?: number;
}

/**
 * Render a page at `scale`. Without a target the raster is the render itself
 * (floored size). With a target the render is drawn (resampled when
 * `resampleFactor` != 1) into a white target-sized frame, top-left aligned.
 */
async function renderPage(
  api: PdfApi,
  pageNum: number,
  scale: number,
  signal: AbortSignal | undefined,
  target?: RenderTarget,
  timer?: StageTimer,
): Promise<RasterPage> {
  const t0 = performance.now();
  const page = await api.doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const canvas = document.createElement("canvas");
  let frame: HTMLCanvasElement | null = null;
  try {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get a 2D canvas context for compare");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const t1 = performance.now();
    timer?.add("getPage", t1 - t0);
    const task = page.render({ canvas, canvasContext: ctx, viewport });
    const onAbort = () => task.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await task.promise;
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw e;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    const t2 = performance.now();
    timer?.add("render", t2 - t1);
    const k = target?.resampleFactor ?? 1;
    if (target && k !== 1) {
      frame = document.createElement("canvas");
      frame.width = target.width;
      frame.height = target.height;
      const fctx = frame.getContext("2d", { willReadFrequently: true });
      if (!fctx) throw new Error("Could not get a 2D canvas context for compare");
      fctx.fillStyle = "#ffffff";
      fctx.fillRect(0, 0, target.width, target.height);
      fctx.imageSmoothingEnabled = true;
      fctx.imageSmoothingQuality = "high";
      fctx.drawImage(canvas, 0, 0, width, height, 0, 0, width * k, height * k);
      const data = fctx.getImageData(0, 0, target.width, target.height).data;
      timer?.add("getImageData", performance.now() - t2);
      return { width: target.width, height: target.height, data };
    }
    const raw: RasterPage = { width, height, data: ctx.getImageData(0, 0, width, height).data };
    timer?.add("getImageData", performance.now() - t2);
    return target ? placeInFrame(raw, target.width, target.height) : raw;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (frame) {
      frame.width = 0;
      frame.height = 0;
    }
    page.cleanup();
  }
}

/** Opens each version at most once per run (the same version on both sides shares a doc). */
class DocSet {
  private docs = new Map<string, Promise<PdfApi>>();
  constructor(private timer?: StageTimer) {}
  open(side: CompareSide): Promise<PdfApi> {
    let p = this.docs.get(side.pdfVersionId);
    if (!p) {
      p = openSide(side, this.timer);
      this.docs.set(side.pdfVersionId, p);
    }
    return p;
  }
  async destroyAll(): Promise<void> {
    const all = [...this.docs.values()];
    this.docs.clear();
    for (const p of all) {
      try {
        (await p).destroy();
      } catch {
        /* never opened */
      }
    }
  }
}

export async function rasterizePair(
  baseSide: CompareSide,
  revSide: CompareSide,
  opts: RasterizeOptions,
): Promise<RasterizedPair> {
  const { timer, signal } = opts;
  opts.onStage?.("loading");
  const docs = new DocSet(timer);
  try {
    // Page sizes are cached per version+page; only a miss opens the document.
    const sizeOf = async (side: CompareSide) => {
      const hit = getCachedSize(side.pdfVersionId, side.page);
      if (hit) return hit;
      const size = await pageSizePt(await docs.open(side), side.page);
      setCachedSize(side.pdfVersionId, side.page, size);
      return size;
    };
    const [bs, rs] = await Promise.all([sizeOf(baseSide), sizeOf(revSide)]);
    checkAbort(signal);
    timer?.mark("sizes");
    const geo = computeGeometry(bs.w, bs.h, rs.w, rs.h, opts.dpi);

    const baseKey = rasterKey(baseSide.pdfVersionId, baseSide.page, geo.renderScale);
    const revKey = rasterKey(
      revSide.pdfVersionId,
      revSide.page,
      geo.revRenderScale,
      0,
      `${geo.baseWidthPx}x${geo.baseHeightPx}@${geo.resampleFactor.toFixed(5)}`,
    );
    const baseHit = rasterCache.get(baseKey);
    const revHit = rasterCache.get(revKey);
    const cacheHits = (baseHit ? 1 : 0) + (revHit ? 1 : 0);

    if (!baseHit || !revHit) {
      opts.onStage?.("rendering");
      await yieldFrame();
    }
    const renderSide = async (side: CompareSide, scale: number, key: string, target?: RenderTarget) => {
      const raster = await renderPage(await docs.open(side), side.page, scale, signal, target, timer);
      rasterCache.set(key, raster); // the cache stores its own copy
      return raster;
    };
    // Both sides render concurrently (pdf.js parses each document in its own worker).
    const [base, revision] = await Promise.all([
      baseHit ?? renderSide(baseSide, geo.renderScale, baseKey),
      revHit ??
        renderSide(revSide, geo.revRenderScale, revKey, {
          width: geo.baseWidthPx,
          height: geo.baseHeightPx,
          resampleFactor: geo.resampleFactor,
        }),
    ]);
    checkAbort(signal);
    timer?.mark("rasters");
    return {
      base,
      revision:
        revision.width === base.width && revision.height === base.height
          ? revision
          : placeInFrame(revision, base.width, base.height),
      scale: base.width / bs.w,
      pageWidthPt: bs.w,
      pageHeightPt: bs.h,
      revisionScale: geo.revisionScale,
      downscaled: geo.downscaled,
      aspectMismatch: geo.aspectMismatch,
      cacheHits,
    };
  } finally {
    await docs.destroyAll();
  }
}
