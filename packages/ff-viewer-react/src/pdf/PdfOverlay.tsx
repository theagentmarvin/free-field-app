// src/viewer/pdf/PdfOverlay.tsx
//
// React wrapper around the imperative PdfViewer class. Mounts a
// single-page PDF canvas in the right panel; clicking an IFC row
// in the sidebar clears `activePdfVersionId` and the parent
// (<ViewerPanel>) swaps this out for the 3D viewer.
//
// Task 12a Part 2 (Calibration Wizard) update: the overlay now
// accepts `captureClicks` and `onPdfClick` props. When
// `captureClicks` is true, the wrapper div has a click handler
// that calls `pdfViewer.pageCoordsFromEvent(e)` and forwards the
// result to `onPdfClick`. The wizard uses this to record the
// two PDF picks. When `captureClicks` is false (or undefined),
// no click capture — the PDF stays interactive for normal
// pan/zoom (the new behavior is purely additive).
//
// StrictMode-safe: every mount resets `disposedRef.current = false`
// before kicking off the async load, and every cleanup checks the
// ref before touching live state. The pattern is identical to
// `IfcViewer.tsx` — see that file's "mount / unmount" section for
// the full rationale.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Task 20 §1.8.3: PdfOverlay's data dependencies are no longer
// resolved through Settings-local DB tables. The consumer
// provides:
//   - `getPdfVersion`   → load the PdfVersionRecord by id
//   - `getPdfBlob`      → load the PDF bytes from IndexedDB
//
// Each prop is optional and falls back to a safe no-op (matching
// the `viewerSlice` precedent in §1.8.1). The Settings app
// wires its existing DB helpers to the props; the Models app
// doesn't render <PdfOverlay> in Task 20 (no PDF panel).
import { loadPDF, PdfViewer, type PdfApi, type ScaleEvent } from "@ff/viewer";
// Note: pdfViewer.css is imported in @ff/viewer-react/src/index.ts
// (the React shell's barrel) so consumers don't need to add it.

export interface PdfOverlayProps {
  /** Which version to load. Re-loading the same id is a no-op
   *  (the existing viewer is destroyed and a new one is built).
   *  Changing this prop triggers a fresh mount. */
  pdfVersionId: string;
  /** Optional close handler (shows a × button). */
  onClose?: () => void;
  // ─── Calibration wizard (Task 12a Part 2) ──────────────────────
  /**
   * When true, the wrapper div intercepts click events. The
   * click is converted to PDF page coords via the viewer's
   * `pageCoordsFromEvent` and forwarded to `onPdfClick` (if
   * both are set). The cursor changes to a crosshair so the
   * user knows the click is "armed". When false or undefined,
   * no click capture — the PDF stays interactive for
   * pan/zoom/etc.
   */
  captureClicks?: boolean;
  /**
   * Receives a click position as PDF page coordinates. Called
   * from the wrapper's onClick handler. The wizard is the only
   * consumer (see MappingView). If the click happens off the
   * canvas (e.g. on the toolbar) the handler does nothing —
   * the canvas is the only place `captureClicks` makes sense.
   */
  onPdfClick?: (coords: { x: number; y: number }) => void;
  /**
   * Tap-to-create (Wave 5B): fires on a plain TAP of the plan canvas
   * — pointer down→up within a small movement threshold (~6px) and a
   * short duration — so pan/zoom drags are never mistaken for a
   * create intent. Receives PDF page coords like `onPdfClick`, but
   * is NOT gated by `captureClicks` (that remains the armed
   * calibration-wizard path). Only canvas taps fire it — the +
   * marker and toolbar are children, not the canvas, so they are
   * excluded by `pageCoordsFromEvent`'s own canvas check.
   */
  onTap?: (coords: { x: number; y: number }) => void;
  /**
   * Fetch a PdfVersionRecord by id. Task 20 §1.8.3: PdfOverlay
   * no longer imports the Settings DB helper; the consumer
   * (which has its own IndexedDB schema) provides this.
   * Optional — defaults to a `null` resolver (overlay shows
   * an inline error if a version id is supplied without a
   * fetcher).
   */
  getPdfVersion?: (
    pdfVersionId: string,
  ) => Promise<{
    blobKey: string;
    width: number;
    height: number;
  } | null>;
  /**
   * Fetch a PDF blob by key from IndexedDB. Task 20 §1.8.3.
   * Optional — defaults to a `null` resolver.
   */
  getPdfBlob?: (key: string) => Promise<Blob | null>;
  /**
   * Wave 64 — expose every page of a multi-page PDF (page navigation,
   * `goToPage`, thumbnails). The Documents reader sets it.
   *
   * Default `false`: the overlay still OPENS multi-page uploads, but
   * stays locked to page 1, the sheet that calibrations (2-point
   * mapping, LinkView, the 3D floor-plan plane) are defined on.
   */
  allowMultiPage?: boolean;
}

export interface PdfOverlayHandle {
  /** Total visual scale (renderScale × displayScale). */
  getTotalScale(): number;
  /** Jump to a specific total scale. */
  setZoom(scale: number): void;
  /** Fit the page to the viewport width. */
  fitWidth(): void;
  /** Fit the page to the viewport (both axes). */
  fitPage(): void;
  /**
   * Returns the DOM node an external SVG overlay (the wizard's
   * pick marker SVG) should be portaled into. The node is a
   * sibling of the canvas inside `.pv-zoom-transform`, so an
   * SVG portaled into it inherits the parent's CSS transform.
   * Markers placed at canvas-local CSS coords track the canvas
   * for free — no rAF, no getBoundingClientRect re-projection.
   * See Task 15b spec.
   *
   * Returns null if the viewer hasn't built its DOM yet; the
   * wizard re-reads on the next render.
   */
  getAnnotationLayer(): HTMLDivElement | null;
  /**
   * Register a callback that fires once when the PDF is
   * fully rendered and the canvas transform is settled.
   * Use this to gate portal rendering — prevents the
   * "marker appears then disappears" flash during initial
   * load when _renderCurrentPage is still in flight.
   */
  onReady(cb: () => void): void;
  /**
   * Subscribe to scale-change events. The callback fires on
   * every CSS transform change. The returned function
   * unsubscribes — call from a `useEffect` cleanup.
   *
   * Returns a no-op unsubscribe if the viewer hasn't been
   * built yet (a defensive fallback so callers don't have to
   * guard the cleanup).
   */
  setOnScaleChange(cb: (e: ScaleEvent) => void): () => void;
  // ─── Task 38: outline + thumbnails door ────────────────────
  /**
   * Jump to a page (1-based). Delegates to the viewer's public
   * `goToPage` door, which delegates to the private `_goToPage`
   * state machine — out-of-range values are ignored.
   *
   * Added for the Documents nav panel (outline entries and
   * thumbnail tiles jump the reader to a page).
   */
  goToPage(n: number): void;
  /**
   * The page currently displayed (1-based). Read-only.
   *
   * Added for the Documents nav panel (the "current page"
   * highlight on the thumbnail strip).
   */
  getCurrentPage(): number;
  /**
   * Read-only handle to the loaded PDF.js document (the
   * `PDFDocumentProxy` behind the viewer). Null until the PDF
   * finishes loading, null again after the overlay is torn down.
   *
   * Added for the Documents nav panel: it reads the outline
   * (`getOutline`) and renders the page thumbnails from THIS
   * document — so the app parses the PDF exactly once. The
   * thumbnails are drawn on the panel's OWN canvases, never on
   * the viewer's canvas.
   */
  getDocument(): PdfApi["doc"] | null;
  /**
   * Day-3 location snapshot: crop the rendered page around a
   * normalized uv and return a jpeg dataURL (see PdfViewer). Null
   * when the page isn't rendered (or capture fails) — the caller
   * falls back to the placeholder.
   */
  getPageSnapshot(
    page: number,
    uv: [number, number],
    maxWidthPx?: number,
  ): string | null;
}

/**
 * Tap-to-create (Wave 5B) gesture thresholds. Kept local to the PDF
 * surface so ff-viewer-react does not depend on the tasks package;
 * the same numbers live in `@ff/tasks-react/src/createMarker.ts` and
 * are unit-tested there.
 */
const TAP_MOVE_THRESHOLD_PX = 6;
const TAP_MAX_DURATION_MS = 500;

export const PdfOverlay = forwardRef<PdfOverlayHandle, PdfOverlayProps>(
  function PdfOverlay(
    {
      pdfVersionId,
      onClose,
      captureClicks,
      onPdfClick,
      onTap,
      getPdfVersion: getPdfVersionProp,
      getPdfBlob: getPdfBlobProp,
      allowMultiPage = false,
    },
    ref,
  ) {
    // Task 20 §1.8.3: prop-injected DB helpers. Each has a
    // safe no-op default; the Settings app passes the real
    // hooks, the Models app doesn't render <PdfOverlay> in
    // Task 20 so the defaults are never hit.
    //
    // CRITICAL (audit-monorepo-diff-2026-06-19 §5 Risk #3):
    // keep the no-op defaults in refs so the function reference
    // is stable across renders. If we used inline `async () => null`
    // here, the function reference would change every render.
    // Today this isn't in any useEffect dep array, but it's the
    // EXACT pattern that caused IfcViewer's infinite
    // create/destroy loop (audit-post-phase-1-lite-2026-06-19
    // #1). Fix it now, before a future refactor adds a dep.
    const getPdfVersionNoopRef = useRef<
      (id: string) => Promise<{
        blobKey: string;
        width: number;
        height: number;
      } | null>
    >(async () => null);
    const getPdfBlobNoopRef = useRef<(key: string) => Promise<Blob | null>>(
      async () => null,
    );
    const getPdfVersion = getPdfVersionProp ?? getPdfVersionNoopRef.current;
    const getPdfBlob = getPdfBlobProp ?? getPdfBlobNoopRef.current;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewerRef = useRef<PdfViewer | null>(null);
    // Task 38: read-only handle to the loaded PDF.js document.
    // Set right after the viewer is in place, so a consumer that
    // sees a non-null document can also rely on the viewer
    // existing (the nav panel subscribes to scale changes the
    // moment it gets the document).
    const docRef = useRef<PdfApi["doc"] | null>(null);

    // StrictMode-safe: see IfcViewer.tsx for the full write-up.
    // The double-mount in dev sets disposedRef = true on the
    // first cleanup, so we must reset it on every mount.
    const disposedRef = useRef(false);

    const [loadError, setLoadError] = useState<Error | null>(null);
    const [pageInfo, setPageInfo] = useState<{ width: number; height: number } | null>(null);
    // Store the viewer's scale-change unsubscribe so the
    // cleanup can tear it down. Set in the async IIFE
    // after the viewer is built — not in a separate effect
    // (which would fire too early, before viewerRef.current
    // exists).
    const unsubScaleRef = useRef<(() => void) | null>(null);
    // Wave 5B tap-to-create: pointer-down stamp for the tap-vs-drag
    // discriminator (cleared on pointer-up).
    const tapDownRef = useRef<{ x: number; y: number; t: number } | null>(null);

    useEffect(() => {
      disposedRef.current = false;

      const container = containerRef.current;
      if (!container) return;

      let pdfViewer: PdfViewer | null = null;

      (async () => {
        if (disposedRef.current) return;
        const version = await getPdfVersion(pdfVersionId);
        if (disposedRef.current) return;
        if (!version) {
          throw new Error(`PdfVersionRecord not found: ${pdfVersionId}`);
        }
        const blob = await getPdfBlob(version.blobKey);
        if (disposedRef.current) return;
        if (!blob) {
          throw new Error(`PdfBlob missing: ${version.blobKey}`);
        }
        const buffer = await blob.arrayBuffer();
        if (disposedRef.current) return;
        // Multi-page uploads are accepted everywhere (the settings
        // upload stores them); without `allowMultiPage` the viewer
        // is capped to page 1 below.
        const api = await loadPDF(new Uint8Array(buffer), {
          singlePage: false,
        });
        if (disposedRef.current) {
          api.destroy();
          return;
        }
        setPageInfo({ width: version.width, height: version.height });

        pdfViewer = new PdfViewer(container, api, {
          instanceId: pdfVersionId,
          // Use PdfApi's scale-1 dimensions (ground truth), not
          // version.width/height which may be stale if the DB
          // stored rendered dimensions instead of points.
          pageWidth: api.width,
          pageHeight: api.height,
          ...(allowMultiPage ? {} : { maxPages: 1 }),
        });
        viewerRef.current = pdfViewer;
        // Task 38: publish the loaded document to the imperative
        // handle (`getDocument()`). Set AFTER `viewerRef` so the
        // ordering guarantee above holds.
        docRef.current = api.doc;
        // Subscribe to scale changes once the viewer is live.
        // The viewer fires _fireScaleChange() from its ctor's
        // _renderCurrentPage() path, so subscribers get the
        // initial scale on the first tick.
        unsubScaleRef.current = pdfViewer.setOnScaleChange((e) => setRenderScale(e.renderScale));
      })().catch((err) => {
        if (disposedRef.current) return;
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });

      return () => {
        // Only run real cleanup. The strict-mode double-unmount
        // would otherwise tear down a perfectly good viewer.
        if (disposedRef.current) return;
        disposedRef.current = true;
        unsubScaleRef.current?.();
        unsubScaleRef.current = null;
        try {
          viewerRef.current?.destroy();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[PdfOverlay] destroy threw:", err);
        } finally {
          viewerRef.current = null;
          // Task 38: drop the document handle with the viewer.
          docRef.current = null;
          setPageInfo(null);
        }
      };
    }, [pdfVersionId, allowMultiPage]);

    useImperativeHandle(
      ref,
      (): PdfOverlayHandle => ({
        getTotalScale: () => viewerRef.current?.getTotalScale() ?? 1,
        setZoom: (scale) => viewerRef.current?.setZoom(scale),
        fitWidth: () => viewerRef.current?.fitWidth(),
        fitPage: () => viewerRef.current?.fitPage(),
        getAnnotationLayer: () => viewerRef.current?.getAnnotationLayer() ?? null,
        onReady: (cb) => {
          viewerRef.current?.onReady(cb);
        },
        // The empty-function fallback handles the case where the
        // viewer hasn't been built yet — calling the returned
        // unsubscribe is a no-op (the Set was never populated).
        setOnScaleChange: (cb) =>
          viewerRef.current?.setOnScaleChange(cb) ?? ((): void => {}),
        // ─── Task 38: outline + thumbnails door ──────────────
        // Pure delegation to the viewer's public door — the
        // state machine stays private to @ff/viewer.
        goToPage: (n) => viewerRef.current?.goToPage(n),
        getCurrentPage: () => viewerRef.current?.getCurrentPage() ?? 1,
        getDocument: () => docRef.current,
        getPageSnapshot: (page, uv, maxWidthPx = 400) =>
          viewerRef.current?.getPageSnapshot(page, uv, maxWidthPx) ?? null,
      }),
      [],
    );

    // renderScale is consumed by the info badge (page size ×
    // scale readout). Updated by the viewer's setOnScaleChange
    // subscription, which is wired inside the async IIFE above
    // (after the viewer is built).
    const [renderScale, setRenderScale] = useState(1);

    // Click handler for the wizard. We forward a synthetic
    // ReactMouseEvent's underlying native event to
    // `pageCoordsFromEvent` (which reads e.clientX/Y + the
    // canvas's bounding rect). We only do this when both
    // `captureClicks` and `onPdfClick` are set — otherwise the
    // wrapper is a no-op for clicks and the PDF stays
    // interactive (pan/zoom, etc.).
    const handleWrapperClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
      if (!captureClicks || !onPdfClick) return;
      // Ignore clicks that land on the toolbar or × button —
      // they shouldn't count as a "pick" intent. The toolbar
      // is the first child of the wrapper; we test by walking
      // the target's class list.
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".pv-toolbar")) return;
      if (target && target.closest("button")) return;
      const native = e.nativeEvent;
      const coords = viewerRef.current?.pageCoordsFromEvent(native);
      if (coords) onPdfClick(coords);
    };

    // ─── Wave 5B · tap-to-create (NOT gated by captureClicks) ───
    const handleWrapperPointerDown = (
      e: ReactPointerEvent<HTMLDivElement>,
    ): void => {
      if (!onTap) return;
      tapDownRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    };

    const handleWrapperPointerUp = (
      e: ReactPointerEvent<HTMLDivElement>,
    ): void => {
      if (!onTap) return;
      const down = tapDownRef.current;
      tapDownRef.current = null;
      if (!down) return;
      const dt = Date.now() - down.t;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (dt > TAP_MAX_DURATION_MS) return;
      if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD_PX) return; // drag → no tap
      // canvas-only: the + marker and toolbar are children, not the
      // canvas, so pageCoordsFromEvent returns null for them.
      const native = e.nativeEvent as unknown as MouseEvent;
      const coords = viewerRef.current?.pageCoordsFromEvent(native);
      if (coords) onTap(coords);
    };

    return (
      <div
        ref={containerRef}
        data-testid="pdf-overlay"
        data-pdf-version-id={pdfVersionId}
        data-capture-clicks={captureClicks ? "true" : "false"}
        onClick={captureClicks ? handleWrapperClick : undefined}
        onPointerDown={handleWrapperPointerDown}
        onPointerUp={handleWrapperPointerUp}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          background: "#F3F4F6",
          // Crosshair is the universal "this click is a pick"
          // cursor. We only set it when captureClicks is on;
          // otherwise the canvas keeps its default grab/grabbing
          // cursors for pan/zoom.
          cursor: captureClicks ? "crosshair" : undefined,
          // 2026-06-05 regression fix: the ViewerPanel wraps this
          // in a `pointer-events: none` div (so clicks pass through
          // to the IfcViewer's canvas behind). Children that need
          // interaction (the PDF scroll/pan area and the close
          // button) must explicitly opt back in with
          // `pointer-events: auto`. Without this, drag-to-pan
          // and Ctrl+wheel zoom are dead.
          pointerEvents: "auto",
        }}
      >
        {loadError ? (
          <div
            role="alert"
            data-testid="pdf-overlay-error"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
              color: "#991b1b",
              background: "#fef2f2",
              fontFamily: "system-ui, sans-serif",
              fontSize: 14,
              lineHeight: 1.5,
              textAlign: "center",
              zIndex: 5,
            }}
          >
            {loadError.message}
          </div>
        ) : null}
        {onClose ? (
          <button
            type="button"
            data-testid="pdf-overlay-close"
            onClick={onClose}
            aria-label="Close PDF and return to 3D viewer"
            title="Close PDF"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 32,
              height: 32,
              // 2026-06-03 (Task 15 follow-up): the close
              // button opts back into pointer-events: auto
              // because the absolute wrapper around PdfOverlay
              // in ViewerPanel is pointer-events: none (so
              // the IfcViewer behind still receives events).
              // Without this, the button is unclickable and
              // the user is stuck on the PDF.
              pointerEvents: "auto",
              borderRadius: 4,
              border: "1px solid rgba(255, 255, 255, 0.2)",
              background: "rgba(0, 0, 0, 0.55)",
              color: "#e8eaed",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            }}
          >
            ×
          </button>
        ) : null}
        {!loadError && pageInfo ? (
          <div
            data-debug="pdf-overlay-info"
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              padding: "4px 8px",
              background: "rgba(0, 0, 0, 0.55)",
              color: "#9aa0a6",
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              borderRadius: 4,
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            {Math.round(pageInfo.width)} × {Math.round(pageInfo.height)} pt @{" "}
            {Math.round(renderScale * 100)}%
          </div>
        ) : null}
      </div>
    );
  },
);

export default PdfOverlay;
