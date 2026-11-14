// src/viewer/pdf/pdfViewer.ts
//
// PdfViewer — single-page PDF canvas with zoom, pan, fit-width,
// fit-page, page navigation, and a transform model that survives
// re-renders.
//
// Ported from `~/projects/pdf-plan-diff/src/ui/pdf-viewer.js`
// (2026-05-22 revision). Two changes from the source:
//
//   1. The diff/region overlay code (`setDiffBuffer`,
//      `setRegionMode`, `navigateRegion`, `jumpToRegion`,
//      `_updateOverlay`, `_diffImageData`, the region counter
//      DOM ids, etc.) is REMOVED — Free Field Step 1 doesn't
//      have a diff feature, and carrying the dead state would
//      make the port harder to audit.
//
//   2. The class is fully typed. `pdfDoc` is a `PdfApi`
//      (returned by `loadPDF`) rather than the loose shape
//      from the original JS file.
//
// The transform model is preserved verbatim:
//
//   screenPos = pageCoord × scale × _displayScale + _translateX/Y
//   totalScale = scale × _displayScale
//
// Pan is stored as `_viewCenterPageX/Y` — the page-coordinate
// point at the viewport center. This survives re-renders because
// page coordinates are stable regardless of render scale.
//
// `_applyTransform()` is called after EVERY change to
// `_translateX/Y` or `_displayScale`. No exceptions. The
// transform on `.pv-zoom-transform` is the single source of truth.

import type { PdfApi } from "./loadPdf";
import { computeSnapshotCrop } from "./pdfSnapshot";

const RE_RENDER_THRESHOLD = 1.5; // re-render when visual is 1.5× the render resolution
const MAX_RENDER_SCALE = 4; // beyond this CSS-stretch is acceptable (likely text only)

export interface PdfViewerOptions {
  instanceId?: string;
  initialScale?: number;
  /** PDF page dimensions in points (for coord projection). */
  pageWidth?: number;
  pageHeight?: number;
  /**
   * Wave 64 — cap on the pages the viewer exposes (default: every
   * page of the document). Calibration / overlay paths pass `1`:
   * a multi-page upload opens on its first (calibrated) sheet and
   * the page navigation stays locked there.
   */
  maxPages?: number;
}

/**
 * Emitted on every CSS transform change (zoom button, ctrl+wheel,
 * pan, fit, setZoom, _renderCurrentPage's restore-pan step). The
 * single source of truth for "the PDF view changed" — consumers
 * (e.g. the calibration wizard) re-render their overlay from
 * these values instead of polling.
 *
 * `renderScale` is the scale the canvas was last rasterized at;
 * `displayScale` is the CSS scale on `.pv-zoom-transform`;
 * `totalScale` is the product (what the user sees).
 */
export interface ScaleEvent {
  renderScale: number;
  displayScale: number;
  totalScale: number;
}

export class PdfViewer {
  /** Internal id used in error messages / debug. */
  private _instanceId: string;
  /** The PDF API handle returned by `loadPDF`. */
  private pdfDoc: PdfApi;
  /** The DOM node we mount the viewer into. */
  private container: HTMLElement;
  /** Initial scale, remembered so page-change resets land on a sensible zoom. */
  private initialScale: number;
  /** Current PDF.js render scale (= the scale the canvas was last drawn at). */
  private scale: number;
  /** Current page (1-based). Step 1 hard-locks to 1 but the field is here for the day multi-page support lands. */
  private currentPage: number;
  /** Navigable page count: `numPages`, capped by `options.maxPages`. */
  private maxPages: number;
  /** ±0.25 per zoom step. */
  private zoomStep: number;

  private _rendering = false;
  /** A render was requested while one was in flight (wave 63): run
   *  again when it settles instead of dropping it — a page flip during
   *  a render used to update the page number but never draw the page. */
  private _renderQueued = false;
  private _renderTask: { cancel(): void; promise: Promise<void> } | null = null;

  // CSS transform state
  // _displayScale: CSS scale on .pv-zoom-transform (≥ 1, for fluid zoom)
  // _translateX/Y: CSS translate on .pv-zoom-transform (px, for pan)
  private _displayScale = 1;
  private _translateX = 0;
  private _translateY = 0;

  // Pan-preservation through re-render:
  // _viewCenterPageX/Y: page-coordinate point that should sit at the
  // viewport center after the next re-render. null = no preservation
  // needed. This is the stable anchor — page coords don't change when
  // render scale changes.
  private _viewCenterPageX: number | null = null;
  private _viewCenterPageY: number | null = null;

  // Drag-to-pan state
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;

  private zoomPresets: number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  private _dropdownOpen = false;

  // Deferred re-render state (fires after zoom gesture ends)
  private _renderScale: number; // the scale the canvas is currently rendered at

  /** PDF page dimensions in points. Ground truth for coord projection. */
  private _pageWidth = 0;
  // _pageHeight stored for future use (clamping, aspect check).
  // Used by _computeMinTotalScale (Task 16b zoom-floor fix).
  private _pageHeight = 0;

  // DOM refs
  private wrapper!: HTMLDivElement;
  private scrollEl!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  /**
   * Sibling of `.pv-canvas-stack` inside `.pv-zoom-transform`.
   * Sized to the canvas's CSS dimensions on every render. This
   * is where the wizard's SVG pick overlay is portaled — it
   * shares the parent's CSS transform, so markers track the
   * canvas for free (no rAF, no getBoundingClientRect
   * re-projection). See Task 15b spec.
   */
  private annotationLayer!: HTMLDivElement;
  private zoomValEl!: HTMLSpanElement;
  private zoomDD!: HTMLDivElement;
  private pageNumInp!: HTMLInputElement;
  private transformEl!: HTMLDivElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;

  /**
   * Subscribers notified on every CSS transform change. See
   * `setOnScaleChange` and `_fireScaleChange`. We use a Set
   * (not an array) so unsubscribing is O(1) and idempotent.
   */
  private _scaleListeners = new Set<(e: ScaleEvent) => void>();

  /** Fires exactly once when the first page render settles. */
  private _readyCallbacks: Array<() => void> = [];
  private _ready = false;

  // Bound handler for outside-click dropdown close. Kept as a
  // field so we can remove the exact same function reference in
  // `destroy()`.
  private _closeZoomDropHandler: () => void;

  constructor(
    container: HTMLElement,
    pdfDoc: PdfApi,
    options: PdfViewerOptions = {},
  ) {
    this._instanceId = options.instanceId ?? "unknown";
    this.pdfDoc = pdfDoc;
    this.container = container;
    this.initialScale = options.initialScale ?? 1;
    this.scale = this.initialScale;
    this.currentPage = 1;
    this.maxPages =
      options.maxPages !== undefined && options.maxPages >= 1
        ? Math.min(pdfDoc.numPages, Math.floor(options.maxPages))
        : pdfDoc.numPages;
    this.zoomStep = 0.25;
    this._renderScale = this.initialScale;
    this._pageWidth = options.pageWidth ?? 0;
    this._pageHeight = options.pageHeight ?? 0;

    this._closeZoomDropHandler = (): void => this._closeZoomDropdown();

    this._buildDOM();
    this._bindEvents();
    this._bindScrollPan();
    this._renderCurrentPage();
  }

  // Minimum total scale to keep the page filling the viewport (no gray).
  // Re-computed on every change so viewport resizes are self-correcting.
  // Uses page CSS pixel dimensions (pageWidth × renderScale) vs scroll
  // container size. Clamped at 1 — never force zoom-in on pages that are
  // smaller than the viewport at scale 1.
  private _computeMinTotalScale(): number {
    const pageCSSW = this._pageWidth * this.scale;
    const pageCSSH = this._pageHeight * this.scale;
    if (!pageCSSW || !pageCSSH) return 0.25;
    return Math.min(
      1,
      Math.max(
        this.scrollEl.clientWidth / pageCSSW,
        this.scrollEl.clientHeight / pageCSSH,
      ),
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * The total visual scale = render scale × CSS display scale.
   * Read-only. Used by the <PdfOverlay> imperative handle so
   * outside code can inspect / drive the zoom level.
   */
  getTotalScale(): number {
    return this.scale * this._displayScale;
  }

  /**
   * Jump to a page (1-based).
   *
   * Task 38 — this is the ONLY public door onto the private
   * `_goToPage` state machine. The method is a pure delegation:
   * the range check, the zoom reset and the re-render all still
   * live in `_goToPage`, unchanged. Out-of-range values are
   * ignored exactly like `_goToPage` ignores them.
   *
   * Added so the Documents nav panel (outline + thumbnail jump)
   * can drive the viewer without any new event plumbing.
   */
  goToPage(n: number): void {
    this._goToPage(n);
  }

  /**
   * The page currently displayed (1-based). Read-only.
   *
   * Task 38 — the Documents nav panel uses it to highlight the
   * current thumbnail. Same value the page-number input shows.
   */
  getCurrentPage(): number {
    return this.currentPage;
  }

  /**
   * Location-snapshot capture (Day-3): crop a region centred on the
   * normalized uv and return a jpeg dataURL scaled to `maxWidthPx`
   * wide, with a pin cross drawn at the exact tap point.
   *
   * Returns null when the requested page is not the currently-rendered
   * one, the canvas hasn't rendered yet, or the 2D context is
   * unavailable (jsdom) — the caller falls back to the placeholder.
   */
  getPageSnapshot(
    page: number,
    uv: [number, number],
    maxWidthPx = 400,
  ): string | null {
    if (page !== this.currentPage) return null; // not rendered
    if (!this._ready || !this.canvas || this.canvas.width === 0) return null;
    if (typeof document === "undefined") return null;
    try {
      const crop = computeSnapshotCrop(
        uv,
        this.canvas.width,
        this.canvas.height,
        maxWidthPx,
      );
      if (!crop) return null;

      const out = document.createElement("canvas");
      out.width = crop.dw;
      out.height = crop.dh;
      const ctx = out.getContext("2d");
      if (!ctx) return null;

      ctx.drawImage(
        this.canvas,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        crop.dw,
        crop.dh,
      );

      // Pin cross at the exact tap point (uv maps to canvas px).
      const fx = uv[0] < 0 ? 0 : uv[0] > 1 ? 1 : uv[0];
      const fy = uv[1] < 0 ? 0 : uv[1] > 1 ? 1 : uv[1];
      const sx = (fx * this.canvas.width - crop.sx) * (crop.dw / crop.sw);
      const sy2 = (fy * this.canvas.height - crop.sy) * (crop.dh / crop.sh);
      const arm = Math.max(6, Math.min(24, Math.round(crop.dw / 20)));
      ctx.strokeStyle = "#1a73e8";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - arm, sy2);
      ctx.lineTo(sx + arm, sy2);
      ctx.moveTo(sx, sy2 - arm);
      ctx.lineTo(sx, sy2 + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy2, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();

      return out.toDataURL("image/jpeg", 0.8);
    } catch {
      return null;
    }
  }

  /**
   * Returns the DOM node the wizard (or any other consumer) should
   * portal an SVG overlay into. The node is a sibling of the
   * canvas inside `.pv-zoom-transform`, so it inherits the parent's
   * CSS transform — markers placed at canvas-local CSS coords
   * track the canvas for free, no rAF polling, no
   * `getBoundingClientRect` re-projection.
   *
   * Returns the actual DOM node (not a ref-to-a-ref) so an HMR
   * replacement of the viewer produces a fresh layer immediately
   * and the next render's `createPortal` call mounts into the new
   * layer.
   *
   * Returns null if `_buildDOM` hasn't run yet (callers should
   * re-evaluate on the next render).
   */
  getAnnotationLayer(): HTMLDivElement | null {
    return this.annotationLayer ?? null;
  }

  /**
   * Register a one-shot callback that fires when the first
   * _renderCurrentPage() completes (canvas sized, transform
   * settled, markers safe to place). If already ready, fires
   * asynchronously so the caller can set up state first.
   */
  onReady(cb: () => void): void {
    if (this._ready) {
      queueMicrotask(cb);
      return;
    }
    this._readyCallbacks.push(cb);
  }

  private _fireReady(): void {
    if (this._ready) return;
    this._ready = true;
    const cbs = this._readyCallbacks;
    this._readyCallbacks = [];
    for (const cb of cbs) cb();
  }

  /**
   * Subscribe to scale-change events. The callback is invoked
   * on every CSS transform change (zoom button, ctrl+wheel, pan,
   * fit, setZoom, _renderCurrentPage's restore-pan step). The
   * returned function unsubscribes — call it from a `useEffect`
   * cleanup.
   *
   * If the viewer is destroyed or the unsubscribe fires while
   * the callback is in flight, the Set just drops it; the
   * callback itself is not wrapped in try/catch (an exception
   * propagates to the caller of the public method that fired
   * the change, which is fine — that's the source of truth).
   */
  setOnScaleChange(cb: (e: ScaleEvent) => void): () => void {
    this._scaleListeners.add(cb);
    return () => {
      this._scaleListeners.delete(cb);
    };
  }

  /**
   * Notify all scale-change subscribers. Called from inside
   * `_applyTransform` so every public/private code path that
   * moves the view produces exactly one event.
   */
  private _fireScaleChange(): void {
    const ev: ScaleEvent = {
      renderScale: this._renderScale,
      displayScale: this._displayScale,
      totalScale: this._renderScale * this._displayScale,
    };
    this._scaleListeners.forEach((cb) => cb(ev));
  }

  /**
   * Jump the view to an arbitrary total visual scale. The viewer
   * picks a render scale and a CSS display scale that multiply to
   * the target — same heuristic the in-viewer zoom buttons use.
   */
  setZoom(scale: number): void {
    if (scale <= 0) return;
    const clamped = Math.max(this._computeMinTotalScale(), Math.min(10, scale));
    const renderScale = Math.min(MAX_RENDER_SCALE, clamped);
    this._animateToScale(renderScale, clamped / renderScale);
  }

  /** Fit the page to the viewport width. */
  fitWidth(): void {
    void this._fitWidth();
  }

  /** Fit the page to the viewport (both axes). */
  fitPage(): void {
    void this._fitPage();
  }

  /**
   * Convert a MouseEvent on the PDF canvas to PDF page coordinates
   * (in points). Returns null if the event isn't on the canvas or
   * the viewer hasn't initialized the transform yet, or if the
   * click happened outside the canvas's visible rect.
   *
   * The transform model (from `_renderCurrentPage`):
   *   displayPos = pageCoord × scale × _displayScale + translate
   *               = pageCoord × totalScale + translate
   *
   * `displayPos` is the click's CSS coords relative to the canvas's
   * VISUAL rect (i.e. post-transform). The visual rect already
   * includes the translate — `getBoundingClientRect()` returns
   * the post-transform box — so the inverse is simply:
   *
   *   pageCoord = displayPos / totalScale
   *
   * Subtracting `_translateX/Y` would double-count. Fixed
   * 2026-06-04 — paired with the `pageToPaneCss` fix to keep
   * the round-trip (click → store → redraw) consistent.
   *
   * Off-canvas click rejection (Task 15b, 2026-06-04): we also
   * reject clicks where the click point is outside the canvas's
   * visible rect. The PDF pane has `overflow: hidden` and the
   * user can pan the canvas so part of it is clipped. Clicking
   * the empty pane area (which is the wizard's PdfOverlay root,
   * not the canvas) would otherwise produce a pick with
   * negative `pageY` and an invisible marker. The bug is fixed
   * at the source — the wizard never has to re-validate.
   *
   * `getBoundingClientRect` returns the visual rect
   * post-CSS-transform. If the parent has `transform: scale(s)`,
   * `rect.width` and `rect.height` are the scaled dimensions in
   * viewport pixels. The check `cssX > rect.width` correctly
   * detects clicks outside the canvas's visible region. The
   * translation does NOT need to be added/subtracted — the bug
   * `7d22a53`/`ac9305d` already fixed that; do not regress it.
   *
   * Used by the calibration wizard to translate a click on the
   * PdfOverlay into the (x, y) the similarity transform expects.
   * Step 1 the wizard is the only consumer; the API is additive
   * (no breaking change to the rest of the class).
   */
  pageCoordsFromEvent(e: MouseEvent): { x: number; y: number } | null {
    // Use the event target's bounding rect, NOT this.canvas's.
    // HMR and React re-renders can replace the canvas DOM node
    // without updating PdfViewer's internal ref — this.canvas
    // may point to a detached element whose getBoundingClientRect
    // returns zombie coords (wrong top/left). The event target is
    // always the live DOM node under the click.
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== "CANVAS") {
      // eslint-disable-next-line no-console
      return null;
    }
    const rect = target.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;

    // Compute totalScale from page dimensions (ground truth).
    // canvas intrinsic size can be stale during a pending
    // re-render — this.scale may have changed for a new render
    // that hasn't completed yet, so canvas.width doesn't match
    // this.scale. Page dimensions are constant.
    //
    // rect.width = pageWidth * renderScale * displayScale
    //            = pageWidth * totalScale
    const totalScale = this._pageWidth > 0
      ? rect.width / this._pageWidth
      : (() => {
          const dpr = window.devicePixelRatio || 1;
          const cssW = this.canvas?.width ? this.canvas.width / dpr : 0;
          if (cssW === 0) return 1;
          return this.scale * (rect.width / cssW);
        })();
    if (totalScale === 0) {
      return null;
    }

    return {
      x: cssX / totalScale,
      y: cssY / totalScale,
    };
  }

  /** Tear down: cancel pending renders, remove DOM, drop PDF ref. */
  destroy(): void {
    // Mark the instance id once at the top of teardown so a
    // failed cleanup can be traced back to the right viewer in
    // dev-mode logs. (The id is informational only — kept on
    // the instance to avoid growing the API surface.)
    void this._instanceId;
    if (this._renderTask) {
      try {
        this._renderTask.cancel();
      } catch {
        // ignore
      }
      this._renderTask = null;
    }
    this._rendering = false;
    this.pdfDoc.destroy();
    this.pdfDoc = null as unknown as PdfApi;
    document.removeEventListener("click", this._closeZoomDropHandler);
    if (this.wrapper && this.wrapper.parentNode) {
      this.wrapper.remove();
    }
  }

  // ─── DOM ─────────────────────────────────────────────────────────────────

  private _buildDOM(): void {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pv-root";
    this.wrapper.innerHTML = `
      <div class="pv-toolbar">
        <div class="pv-nav">
          <button class="pv-btn pv-prev" title="Previous page" disabled>
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <div class="pv-page-info">
            <input class="pv-page-num" type="number" value="1" min="1" max="${this.maxPages}" />
            <span class="pv-sep">/</span>
            <span class="pv-total">${this.maxPages}</span>
          </div>
          <button class="pv-btn pv-next" title="Next page" disabled>
            <svg viewBox="0 0 24 24"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
          </button>
        </div>
        <div class="pv-sep-v"></div>
        <div class="pv-zoom-controls">
          <button class="pv-btn pv-zoom-out" title="Zoom out">
            <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z"/></svg>
          </button>
          <div class="pv-zoom-wrap">
            <span class="pv-zoom-val" id="pv-zoom-val">100%</span>
            <div class="pv-zoom-dropdown" id="pv-zoom-dd"></div>
          </div>
          <button class="pv-btn pv-zoom-in" title="Zoom in">
            <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm-1-2h2v2h1v-2h2V9h-2V7h-1v2h-2v1z"/></svg>
          </button>
        </div>
        <div class="pv-sep-v"></div>
        <div class="pv-fit-btns">
          <button class="pv-btn pv-fit-w" title="Fit width">
            <svg viewBox="0 0 24 24"><path d="M3 5v14h18V5H3zm16 12H5V7h14v10zM7 12h2v3H7v-3zm4-1h2v4h-2v-4zm4 2h2v2h-2v-2z"/></svg>
          </button>
          <button class="pv-btn pv-fit-p" title="Fit page">
            <svg viewBox="0 0 24 24"><path d="M3 5v14h18V5H3zm16 6h-3.5V7.5h-2V11H10V7.5h-2V11H4.5v2H8v3.5h2V13h3.5v3.5h2V13H19v-2z"/></svg>
          </button>
        </div>
      </div>
      <div class="pv-scroll" id="pv-scroll">
        <div class="pv-page-wrap">
          <div class="pv-zoom-transform">
            <div class="pv-canvas-stack">
              <canvas id="pv-base-canvas"></canvas>
            </div>
            <div class="pv-annotation-layer" data-pv-annotation-layer="true"></div>
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(this.wrapper);

    this.scrollEl = this.wrapper.querySelector("#pv-scroll") as HTMLDivElement;
    this.canvas = this.wrapper.querySelector("#pv-base-canvas") as HTMLCanvasElement;
    this.annotationLayer = this.wrapper.querySelector(
      "[data-pv-annotation-layer=\"true\"]",
    ) as HTMLDivElement;
    this.zoomValEl = this.wrapper.querySelector("#pv-zoom-val") as HTMLSpanElement;
    this.zoomDD = this.wrapper.querySelector("#pv-zoom-dd") as HTMLDivElement;
    this.pageNumInp = this.wrapper.querySelector(".pv-page-num") as HTMLInputElement;
    this.transformEl = this.wrapper.querySelector(".pv-zoom-transform") as HTMLDivElement;
    this.prevBtn = this.wrapper.querySelector(".pv-prev") as HTMLButtonElement;
    this.nextBtn = this.wrapper.querySelector(".pv-next") as HTMLButtonElement;

    // Step 1: single-page. Disable prev/next entirely. The
    // `disabled` attribute is set in the markup but we re-assert
    // here so a future multi-page flip works without ceremony.
    this.prevBtn.disabled = true;
    this.nextBtn.disabled = true;

    this._buildZoomDropdown();
  }

  private _buildZoomDropdown(): void {
    const totalScale = this._displayScale * this.scale;
    const presets = [...this.zoomPresets];
    if (!presets.includes(totalScale)) {
      presets.push(totalScale);
      presets.sort((a, b) => a - b);
    }
    this.zoomDD.innerHTML = presets
      .map(
        (s) =>
          `<button class="pv-zoom-dropdown-item${s === totalScale ? " active" : ""}" data-scale="${s}">${Math.round(s * 100)}%</button>`,
      )
      .join("");
  }

  // ─── Events ──────────────────────────────────────────────────────────────

  private _bindEvents(): void {
    this.wrapper.querySelector(".pv-zoom-in")!.addEventListener("click", () =>
      this._zoomBy(this.zoomStep),
    );
    this.wrapper.querySelector(".pv-zoom-out")!.addEventListener("click", () =>
      this._zoomBy(-this.zoomStep),
    );
    this.wrapper.querySelector(".pv-fit-w")!.addEventListener("click", () =>
      this._fitWidth(),
    );
    this.wrapper.querySelector(".pv-fit-p")!.addEventListener("click", () =>
      this._fitPage(),
    );
    this.prevBtn.addEventListener("click", () => this._goToPage(this.currentPage - 1));
    this.nextBtn.addEventListener("click", () => this._goToPage(this.currentPage + 1));

    this.zoomValEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleZoomDropdown();
    });

    this.zoomDD.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest(".pv-zoom-dropdown-item") as HTMLButtonElement | null;
      if (!item) return;
      const s = parseFloat(item.dataset.scale ?? "");
      if (!s || s === this.getTotalScale()) return;
      const renderScale = Math.min(MAX_RENDER_SCALE, s);
      const newDisplayScale = s / renderScale;
      this._animateToScale(renderScale, newDisplayScale);
      this._closeZoomDropdown();
    });

    document.addEventListener("click", this._closeZoomDropHandler);

    this.pageNumInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const n = parseInt((e.target as HTMLInputElement).value, 10);
        if (n >= 1 && n <= this.maxPages) this._goToPage(n);
        else (e.target as HTMLInputElement).value = String(this.currentPage);
      }
    });

    this.wrapper.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      if (e.key === "+" || e.key === "=") this._zoomBy(this.zoomStep);
      if (e.key === "-") this._zoomBy(-this.zoomStep);
      // Page-up / page-down / left-right are no-ops in single-page
      // mode (the buttons are disabled too). Keeping the wiring
      // so a future multi-page flip works without ceremony.
      if (e.key === "ArrowLeft" || e.key === "PageUp") this._goToPage(this.currentPage - 1);
      if (e.key === "ArrowRight" || e.key === "PageDown") this._goToPage(this.currentPage + 1);
      if (e.key === "Home") this._goToPage(1);
      if (e.key === "End") this._goToPage(this.maxPages);
    });
    this.wrapper.tabIndex = 0;
  }

  private _toggleZoomDropdown(): void {
    this._dropdownOpen = !this._dropdownOpen;
    this.zoomDD.classList.toggle("open", this._dropdownOpen);
    if (this._dropdownOpen) this._rebuildZoomDropdown();
  }

  private _closeZoomDropdown(): void {
    this._dropdownOpen = false;
    this.zoomDD.classList.remove("open");
  }

  private _rebuildZoomDropdown(): void {
    this._buildZoomDropdown();
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  private async _renderCurrentPage(): Promise<void> {
    if (this._rendering) {
      this._renderQueued = true;
      return;
    }
    this._rendering = true;
    this._renderQueued = false;

    try {
      if (this._renderTask) {
        this._renderTask.cancel();
        this._renderTask = null;
      }

      const pageNum = this.currentPage;
      this.pageNumInp.value = String(pageNum);
      this.prevBtn.disabled = pageNum <= 1;
      this.nextBtn.disabled = pageNum >= this.maxPages;

      // Step 1: save viewport-anchor in page coordinates so we can
      // restore it after the re-render. If the caller already set
      // _viewCenterPageX/Y (e.g. setZoom), don't overwrite — those
      // values encode explicit intent.
      if (this._viewCenterPageX === null) {
        const vcX = this.scrollEl.clientWidth / 2;
        const vcY = this.scrollEl.clientHeight / 2;
        const totalScale = this._renderScale * this._displayScale;

        this._viewCenterPageX = (vcX - this._translateX) / totalScale;
        this._viewCenterPageY = (vcY - this._translateY) / totalScale;
      }

      // Preserve CSS zoom intent & reset transform.
      const savedDisplayScale = this._displayScale;
      this._displayScale = 1;
      this._translateX = 0;
      this._translateY = 0;
      this._applyTransform();

      // Render page
      const task = await this.pdfDoc.renderPage(this.canvas, pageNum, this.scale);
      this._renderTask = task;

      try {
        await task.promise;
      } catch (e) {
        const err = e as { name?: string };
        if (err?.name !== "RenderingCancelledException") throw e;
        return;
      } finally {
        if (this._renderTask === task) this._renderTask = null;
      }

      this._renderScale = this.scale;

      // Force the canvas CSS size to match the intrinsic
      // pixel dimensions. loadPdf.renderPage preserves any
      // pre-existing CSS size (so a render at scale 2 leaves
      // the CSS at 2384px even after a subsequent re-render
      // at scale 1). The intrinsic dimensions are always
      // correct (set by PDF.js from the viewport), so we
      // derive the correct CSS size from them via DPR.
      // Without this, pageCoordsFromEvent computes wrong
      // page coordinates because totalScale (from internal
      // state) disagrees with the actual visual rect.
      // Wave 63: a capped render (canvas pixel budget) reports its
      // CSS size on the task; the pixel size / dpr would shrink the
      // page instead of letting CSS scale the bitmap up.
      const sized = task as { cssWidth?: number; cssHeight?: number };
      const dpr = window.devicePixelRatio || 1;
      const cssW = sized.cssWidth ?? this.canvas.width / dpr;
      const cssH = sized.cssHeight ?? this.canvas.height / dpr;
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
      // Multi-page documents can mix sheet sizes: keep the page size
      // used for click → page-coordinate projection in step with the
      // page actually shown.
      if (sized.cssWidth !== undefined && sized.cssHeight !== undefined && this.scale > 0) {
        this._pageWidth = sized.cssWidth / this.scale;
        this._pageHeight = sized.cssHeight / this.scale;
      }

      // Restore CSS display scale
      this._displayScale = savedDisplayScale;

      // Restore pan from page-coordinate center
      if (this._viewCenterPageX !== null) {
        const totalScale = this.scale * this._displayScale;
        const vcX = this.scrollEl.clientWidth / 2;
        const vcY = this.scrollEl.clientHeight / 2;
        // Capture the Y value before we null it out — the type
        // narrow above only covers X, but they're set together
        // and cleared together throughout the class.
        const centerY = this._viewCenterPageY as number;

        this._translateX = vcX - this._viewCenterPageX * totalScale;
        this._translateY = vcY - centerY * totalScale;

        this._viewCenterPageX = null;
        this._viewCenterPageY = null;
      }
      this._applyTransform();

      // Ensure scroll container width matches canvas
      const wrap = this.wrapper.querySelector(".pv-page-wrap") as HTMLDivElement | null;
      if (wrap) {
        wrap.style.width = `${this.canvas.offsetWidth}px`;
        wrap.style.height = `${this.canvas.offsetHeight}px`;
      }

      // Size the annotation layer to match the canvas's CSS
      // dimensions. Task 15b: the layer is a sibling of the
      // canvas inside `.pv-zoom-transform`; an SVG portaled into
      // it inherits the parent's CSS transform, so markers placed
      // at canvas-local CSS coords track the canvas for free.
      // The layer is sized in CSS pixels of the parent's local
      // coord system (pre-CSS-transform), so the SVG's `width` /
      // `height` line up with the canvas's `offsetWidth/Height`.
      this.annotationLayer.style.width = `${this.canvas.offsetWidth}px`;
      this.annotationLayer.style.height = `${this.canvas.offsetHeight}px`;

      this.zoomValEl.textContent = `${Math.round(this.getTotalScale() * 100)}%`;
      this._rebuildZoomDropdown();
    } finally {
      this._rendering = false;
      this._fireReady();
      if (this._renderQueued && this.pdfDoc) {
        this._renderQueued = false;
        void this._renderCurrentPage();
      }
    }
  }

  // ─── CSS Transform (zoom + pan) ──────────────────────────────────────────

  // INVARIANT: _applyTransform() MUST be called after any change to
  // _translateX, _translateY, or _displayScale. It is the single
  // source of truth for the PDF view's visual state — both for
  // the CSS transform on the wrapper AND for the scale-change
  // event that consumers subscribe to.
  private _applyTransform(): void {
    this.transformEl.style.transform =
      `translate(${this._translateX}px, ${this._translateY}px) scale(${this._displayScale})`;
    this._fireScaleChange();
  }

  // ─── Drag-to-Pan ─────────────────────────────────────────────────────────

  private _bindScrollPan(): void {
    const scrollEl = this.scrollEl;

    scrollEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input, select")) return;
      e.preventDefault();
      this._dragging = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
    });

    scrollEl.addEventListener("mousemove", (e) => {
      if (!this._dragging) return;
      this._translateX += e.clientX - this._dragStartX;
      this._translateY += e.clientY - this._dragStartY;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._applyTransform();
    });

    const stopDrag = (): void => {
      this._dragging = false;
    };
    scrollEl.addEventListener("mouseup", stopDrag);
    scrollEl.addEventListener("mouseleave", stopDrag);

    // Ctrl/Cmd + wheel → zoom centered on cursor
    scrollEl.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();

        const rect = scrollEl.getBoundingClientRect();
        const vpX = e.clientX - rect.left;
        const vpY = e.clientY - rect.top;

        const zoomDir = e.deltaY < 0 ? 1 : -1;
        const minScale = this._computeMinTotalScale();
        const newTotalScale = Math.max(
          minScale,
          Math.min(10, this.getTotalScale() + zoomDir * this.zoomStep),
        );
        if (newTotalScale === this.getTotalScale()) return;

        // Anchor: keep the document point under cursor fixed
        const s0 = this._displayScale;
        const s1 = newTotalScale / this.scale;
        this._translateX = vpX - s1 * ((vpX - this._translateX) / s0);
        this._translateY = vpY - s1 * ((vpY - this._translateY) / s0);
        this._displayScale = s1;

        this._applyTransform();
        this.zoomValEl.textContent = `${Math.round(newTotalScale * 100)}%`;
        this._rebuildZoomDropdown();
      },
      { passive: false },
    );
  }

  // ─── Deferred re-render after zoom gesture ──────────────────────────────

  private _animateToScale(renderScale: number, displayScale: number): void {
    if (this._rendering) return;

    // Save the page-coordinate center so _renderCurrentPage can
    // restore it. Only compute if the caller hasn't already set a
    // target.
    if (this._viewCenterPageX === null) {
      const vcX = this.scrollEl.clientWidth / 2;
      const vcY = this.scrollEl.clientHeight / 2;
      const totalScale = this.scale * this._displayScale;
      this._viewCenterPageX = (vcX - this._translateX) / totalScale;
      this._viewCenterPageY = (vcY - this._translateY) / totalScale;
    }

    this._displayScale = displayScale;
    this._translateX = 0;
    this._translateY = 0;
    this._applyTransform();

    this.zoomValEl.textContent = `${Math.round(renderScale * displayScale * 100)}%`;
    this._rebuildZoomDropdown();

    if (renderScale !== this.scale) {
      this.scale = renderScale;
      void this._renderCurrentPage();
    } else {
      // No re-render needed. Restore pan from saved page-coordinate
      // center.
      if (this._viewCenterPageX !== null) {
        const totalScale = this.scale * this._displayScale;
        const vcX = this.scrollEl.clientWidth / 2;
        const vcY = this.scrollEl.clientHeight / 2;
        const centerY = this._viewCenterPageY as number;
        this._translateX = vcX - this._viewCenterPageX * totalScale;
        this._translateY = vcY - centerY * totalScale;
        this._viewCenterPageX = null;
        this._viewCenterPageY = null;
        this._applyTransform();
      }
    }
  }

  private _zoomBy(delta: number): void {
    const minScale = this._computeMinTotalScale();
    const newTotalScale = Math.max(
      minScale,
      Math.min(10, this.getTotalScale() + delta),
    );
    if (newTotalScale === this.getTotalScale()) return;

    const newDisplayScale = newTotalScale / this.scale;
    if (
      newDisplayScale >= RE_RENDER_THRESHOLD &&
      this._renderScale < MAX_RENDER_SCALE
    ) {
      const newRenderScale = Math.min(MAX_RENDER_SCALE, newTotalScale);
      this._animateToScale(newRenderScale, newTotalScale / newRenderScale);
    } else {
      this._displayScale = newDisplayScale;
      this._applyTransform();
      this.zoomValEl.textContent = `${Math.round(newTotalScale * 100)}%`;
      this._rebuildZoomDropdown();
    }
  }

  private async _fitWidth(): Promise<void> {
    const info = await this._getPageInfo(this.currentPage);
    if (!info) return;
    const targetScale = Math.max(
      0.25,
      Math.min(MAX_RENDER_SCALE, this.scrollEl.clientWidth / info.width),
    );
    this._animateToScale(targetScale, 1);
  }

  private async _fitPage(): Promise<void> {
    const info = await this._getPageInfo(this.currentPage);
    if (!info) return;
    const targetScale = Math.max(
      0.25,
      Math.min(
        MAX_RENDER_SCALE,
        Math.min(
          this.scrollEl.clientWidth / info.width,
          this.scrollEl.clientHeight / info.height,
        ),
      ),
    );
    this._animateToScale(targetScale, 1);
  }

  private async _getPageInfo(
    pageNum: number,
  ): Promise<{ width: number; height: number } | null> {
    try {
      const page = await this.pdfDoc.doc.getPage(pageNum);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    } catch {
      return null;
    }
  }

  // ─── Navigation ──────────────────────────────────────────────────────────

  private _goToPage(n: number): void {
    if (n < 1 || n > this.maxPages) return;
    this.currentPage = n;
    this.scale = this.initialScale;
    this._displayScale = 1;
    this._translateX = 0;
    this._translateY = 0;
    this._viewCenterPageX = null;
    this._viewCenterPageY = null;
    void this._renderCurrentPage();
  }
}
