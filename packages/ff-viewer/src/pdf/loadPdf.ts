// src/viewer/pdf/loadPdf.ts
//
// PDF.js loader + buffer validator. Ported from
// ~/projects/pdf-plan-diff/src/lib/pdf.js and re-typed for
// Free Field.
//
// ── Worker (F1, task 37) ───────────────────────────────────────
//
// The worker comes from a Vite `?url` import of the *installed*
// pdfjs-dist build:
//
//   import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
//
// That gives a same-origin, content-hashed URL that is locked to
// the installed package version BY CONSTRUCTION — the old
// hardcoded `https://unpkg.com/pdfjs-dist@<version>/...` constant
// could silently drift away from the pinned range in
// package.json, and needed a fetch + Blob-URL dance to survive
// the browser's cross-origin worker check.
//
// PDF.js only wraps a worker URL in a Blob when it is
// cross-origin (`PDFWorker._isSameOrigin`); a same-origin URL is
// handed straight to `new Worker(url, { type: "module" })`. So
// the CDN + blob dance is DELETED here, not merely bypassed.
//
// ── cmaps + standard fonts (F2, task 37) ───────────────────────
//
// `cMapUrl` / `standardFontDataUrl` point at `public/pdfjs/…`,
// populated by `apps/settings/scripts/setup-pdfjs-assets.mjs`.
// These are a DIRECTORY COPY, not a `?url` import, and the two
// mechanisms must not be "unified":
//
//   * The worker is ONE file whose URL the bundler can hand us
//     directly → `?url` (hashed, same-origin, no runtime fetch).
//   * cmaps are ~170 individual `.bcmap` files and standard_fonts
//     are ~14 `.pfb`/`.ttf` files, fetched BY NAME at runtime, on
//     demand, only when a document actually needs them. No
//     bundler import can express "fetch this name from this
//     directory" — the files have to exist as real, static
//     assets under `public/`. Hence the copy step.
//
// So: `?url` for the worker, `public/` copy for the asset trees.
// "Simplifying" one into the other breaks one of them.
//
// Single-page enforcement: PDFs with more than one page are
// rejected with a clear error before they reach Dexie. The error
// propagates to <PdfOverlay>, which surfaces it in the UI.

// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient asset typing
/// <reference path="../types/vite-assets.d.ts" />

// The LEGACY build: pdf.js 6's modern build needs the ES2025 `Iterator`
// global (Safari < 18.4 / older field tablets would not boot); the legacy
// build ships its own polyfills and also loads under Node 20 test runs.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// Type-only import for the PDFDocumentProxy / PDFPageProxy types.
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
// Vite `?url` import → the worker URL as a string. The worker
// source itself is never parsed by the bundler; it is emitted as
// an asset and fetched by the browser from the URL below.
// (Type declaration: `src/types/vite-assets.d.ts`.)
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * Free a loaded document. pdf.js 6 removed `PDFDocumentProxy.destroy()`;
 * the loading task owns teardown. Falls back to the 5.x method so a
 * mocked / older document still works.
 */
export async function destroyPdfDocument(doc: PDFDocumentProxy): Promise<void> {
  const d = doc as unknown as {
    loadingTask?: { destroy?: () => Promise<void> | void };
    destroy?: () => Promise<void> | void;
  };
  if (typeof d.loadingTask?.destroy === "function") await d.loadingTask.destroy();
  else if (typeof d.destroy === "function") await d.destroy();
}

/** 50 MB — same as pdf-plan-diff (single-page PDFs are tiny but
 *  the limit defends against the user accidentally picking a huge
 *  scan). */
export const MAX_PDF_SIZE = 50 * 1024 * 1024;

/**
 * The PDF.js worker URL, assigned once at module load.
 *
 * `pdfWorkerUrl` is a same-origin, content-hashed URL produced by
 * Vite's `?url` import (see the file header). Assigning it here
 * — rather than inside `loadPDF` — guarantees the worker source
 * is configured before any `getDocument` call, and means there is
 * no runtime fetch of the worker source at all: the browser
 * fetches the same-origin asset directly.
 */
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Quick validation of a PDF byte buffer — magic bytes, minimum
 * size, max size. Used as the first gate by the upload pipeline
 * (so a corrupted file never reaches Dexie) and by `loadPDF`
 * itself (defensive — we re-check the buffer if the caller
 * skipped the upload-time validation).
 */
export function validatePDFBuffer(buffer: ArrayBuffer | Uint8Array): void {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.byteLength > MAX_PDF_SIZE) {
    throw new Error(
      `PDF exceeds ${MAX_PDF_SIZE / 1024 / 1024} MB limit (${
        (bytes.byteLength / 1024 / 1024).toFixed(1)
      } MB received)`,
    );
  }
  if (bytes.byteLength < 5) {
    throw new Error("File too small to be a valid PDF");
  }
  // Magic bytes: PDF files start with %PDF- (0x25 0x50 0x44 0x46 0x2D)
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i < 5; i++) {
    if (bytes[i] !== magic[i]) {
      throw new Error("Not a valid PDF — magic bytes missing");
    }
  }
}

/**
 * The handle returned by `loadPDF`. Wraps the underlying
 * PDFDocumentProxy with two methods: `renderPage` (to a canvas)
 * and `destroy` (free the document). The handle also exposes the
 * raw proxy for callers that need `getPage()` directly.
 */
export interface PdfApi {
  /** The underlying PDF.js document. */
  readonly doc: PDFDocumentProxy;
  /** Convenience: `doc.numPages` mirrored. */
  readonly numPages: number;
  /** Page size in PDF points (1pt = 1/72 inch). */
  readonly width: number;
  readonly height: number;
  /**
   * Render `pageNum` to `canvas`. `renderScale` is the PDF.js
   * viewport scale (effective canvas pixel / CSS pixel ratio).
   * Returns the raw PDFRenderTask so the caller can `.cancel()` a
   * pending render before starting another.
   */
  renderPage(
    canvas: HTMLCanvasElement,
    pageNum?: number,
    renderScale?: number,
  ): Promise<{ promise: Promise<void>; cancel(): void }>;
  /** Free the document. Idempotent. */
  destroy(): void;
}

// ── Canvas size budget (wave 63) ─────────────────────────────────────
//
// A page rendered at renderScale 4 × devicePixelRatio 3 is a canvas of
// hundreds of megapixels: browsers fail to allocate it (blank page) or
// the tab is killed (iOS). The backing store is capped at a pixel
// budget; past it the canvas keeps its CSS size and the browser scales
// the bitmap up (slightly soft at extreme zoom, never blank).

/** Desktop budget: ~16 M device pixels per canvas. */
export const MAX_CANVAS_PIXELS = 16_000_000;
/** iOS / iPadOS budget: WebKit's per-tab canvas memory is much lower. */
export const MAX_CANVAS_PIXELS_IOS = 5_242_880;

export function isIOSLike(nav?: {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}): boolean {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!n) return false;
  if (/iPad|iPhone|iPod/.test(n.userAgent ?? "")) return true;
  // iPadOS 13+ reports itself as a Mac with touch.
  return n.platform === "MacIntel" && (n.maxTouchPoints ?? 0) > 1;
}

export function canvasPixelBudget(): number {
  return isIOSLike() ? MAX_CANVAS_PIXELS_IOS : MAX_CANVAS_PIXELS;
}

/**
 * Device pixel ratio to rasterize a `cssWidth × cssHeight` page at so
 * the backing store stays within `maxPixels`. Equals `dpr` when the
 * page fits; otherwise scaled down uniformly.
 */
export function cappedPixelRatio(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxPixels: number = canvasPixelBudget(),
): number {
  const area = cssWidth * dpr * cssHeight * dpr;
  if (!(area > maxPixels) || cssWidth <= 0 || cssHeight <= 0) return dpr;
  return dpr * Math.sqrt(maxPixels / area);
}

/**
 * Load a PDF from a buffer. Configures the PDF.js worker the
 * first time it's called and returns a typed handle. Throws on:
 *   - invalid buffer (magic bytes / size)
 *   - worker fetch failure
 *   - PDF.js parse failure
 *   - single-page enforcement (numPages !== 1, unless `singlePage: false`)
 */
export async function loadPDF(
  buffer: ArrayBuffer | Uint8Array,
  options: {
    maxRenderScale?: number;
    devicePixelRatio?: number;
    /**
     * When true (the default), PDFs with numPages !== 1 are
     * rejected. The Settings calibration pipeline depends on
     * this — it uploads single-page plans only. The Documents
     * module passes `{ singlePage: false }` to accept multi-page
     * PDFs (full spec books, multi-sheet plan sets, etc.).
     *
     * Explicit `false` is the only way to opt out; explicit `true`
     * or `undefined` keeps the historical strict behavior. This
     * shape lets the Settings pipeline keep working unchanged
     * while the Documents pipeline gets the multi-page capability
     * it needs.
     */
    singlePage?: boolean;
  } = {},
): Promise<PdfApi> {
  validatePDFBuffer(buffer);

  // jsdom's `window.devicePixelRatio` is undefined → default to 1.
  const dpr =
    options.devicePixelRatio ??
    (typeof window !== "undefined" ? window.devicePixelRatio ?? 1 : 1);

  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // PDF.js takes an ArrayBuffer; pass a slice (defensive — the
  // PDF.js source code historically called `.byteLength` on
  // `data` directly, which misbehaves on Uint8Array views with
  // `byteOffset` non-zero). The cast is needed because the
  // `bytes.buffer` type is `ArrayBufferLike` which includes
  // SharedArrayBuffer in modern TS lib defs; PDF.js's overload
  // for `data` accepts only ArrayBuffer.
  const data: ArrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  // The DocumentInitParameters overload lets us set
  // `maxCanvasPixels` (the `data` shorthand overload doesn't).
  // We re-declare the type inline to avoid a `verbatimModuleSyntax`
  // issue with `import * as pdfjsLib` — the type lives in
  // `pdfjs-dist/types/src/display/api` and the `pdfjs-dist`
  // top-level export re-exports it.
  interface InitParams {
    data: ArrayBuffer;
    maxCanvasPixels?: number;
    // CJK character maps + standard (non-embedded) fonts. These
    // are served from our OWN origin (see
    // `apps/settings/scripts/setup-pdfjs-assets.mjs`) — PDF.js
    // fetches them BY NAME at runtime, which is why they are a
    // `public/` directory copy rather than a `?url` import (see
    // the file header for why the two mechanisms differ).
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
    wasmUrl?: string;
    iccUrl?: string;
    // Hardening (GHSA-hq66-cqwq-w95j). pdf.js 6 has no font-eval path and
    // only runs document scripts through PDFScriptingManager (never used
    // here); these stay explicit so a future viewer/pinned 5.x is safe too.
    isEvalSupported: boolean;
    enableScripting: boolean;
    [key: string]: unknown;
  }
  const initParams: InitParams = {
    data,
    // Allow large canvases for high-DPI / high-zoom renders.
    maxCanvasPixels: canvasPixelBudget(),
    // CJK (Chinese/Japanese/Korean) character maps — needed for
    // documents whose fonts are not embedded.
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    // Standard 14 fonts + the fonts PDF.js ships for
    // non-embedded text.
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    isEvalSupported: false,
    enableScripting: false,
  };
  const doc = await pdfjsLib.getDocument(initParams).promise;

  // Single-page enforcement. Free Field's PDF canvas is a
  // single-page view; multi-page uploads are rejected at
  // validation so they never reach Dexie. The pipeline ALSO
  // checks numPages before writing, but we re-check here so
  // `loadPDF` is safe to call from non-pipeline code paths
  // (tests, debug).
  //
  // Multi-page opt-in: pass `{ singlePage: false }` to accept
  // PDFs with numPages > 1. The default (`singlePage !== false`)
  // preserves the historical strict behavior so the Settings
  // calibration flow is unaffected.
  const singlePage = options.singlePage !== false;
  if (singlePage && doc.numPages !== 1) {
    await destroyPdfDocument(doc);
    throw new Error(
      `PDF must be a single page — received ${doc.numPages} pages`,
    );
  }

  // Read page 1's intrinsic size. We hold a cached `width/height`
  // on the handle so callers don't have to await `getPage` just
  // to learn the page size.
  const page = (await doc.getPage(1)) as PDFPageProxy;
  const vp = page.getViewport({ scale: 1 });
  const width = vp.width;
  const height = vp.height;

  return {
    doc,
    numPages: doc.numPages,
    width,
    height,
    renderPage: (
      canvas: HTMLCanvasElement,
      pageNum: number = 1,
      renderScale: number = 1,
    ) => {
      return doc.getPage(pageNum).then((p) => {
        const v = p.getViewport({ scale: renderScale });
        // Wave 63: cap the backing store (see MAX_CANVAS_PIXELS).
        const ratio = cappedPixelRatio(v.width, v.height, dpr);
        const physW = Math.max(1, Math.floor(v.width * ratio));
        const physH = Math.max(1, Math.floor(v.height * ratio));

        // Preserve any CSS size already on the canvas so CSS
        // zoom stays stable across re-renders.
        const cssW = canvas.style.width || `${v.width}px`;
        const cssH = canvas.style.height || `${v.height}px`;

        canvas.width = physW;
        canvas.height = physH;
        canvas.style.width = cssW;
        canvas.style.height = cssH;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          throw new Error("Could not get 2D canvas context for PDF render");
        }
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

        const task = p.render({
          canvasContext: ctx,
          viewport: v,
          canvas,
        });
        // The page's CSS size at this render scale — the canvas
        // pixel size no longer implies it once the budget caps it.
        return Object.assign(task, { cssWidth: v.width, cssHeight: v.height });
      });
    },
    destroy: () => {
      void destroyPdfDocument(doc);
    },
  };
}
