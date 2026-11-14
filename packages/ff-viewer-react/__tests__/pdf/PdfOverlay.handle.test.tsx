// __tests__/pdf/PdfOverlay.handle.test.tsx
//
// Task 38 — the three new members on the <PdfOverlay> imperative
// handle:
//
//   - `goToPage(n)`      → delegates to the viewer's public door
//   - `getCurrentPage()` → the page the viewer is showing
//   - `getDocument()`    → the loaded PDF.js document (null before
//                          the load finishes)
//
// The document handle is what lets the Documents nav panel read
// the outline and render page thumbnails from the SAME parsed
// document the viewer is using (no second parse, no second
// worker).
//
// `loadPDF` + `PdfViewer` are mocked (jsdom can't host the
// PDF.js worker), same as PdfOverlay.test.tsx.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

// `vi.hoisted` lifts the shared spies above the module imports —
// the `vi.mock` factory below runs while "@ff/viewer" is being
// imported, so it can't close over a plain `const` declared in
// the test body (TDZ).
const h = vi.hoisted(() => ({
  doc: { numPages: 3, marker: "fake-pdf-document" },
  goToPage: vi.fn(),
  getCurrentPage: vi.fn(() => 2),
  getPageSnapshot: vi.fn(() => null),
  viewerConstructor: vi.fn(),
  viewerDestroy: vi.fn(),
  loadPDF: vi.fn(),
}));

vi.mock("@ff/viewer", () => ({
  loadPDF: (...args: unknown[]) => {
    h.loadPDF(...args);
    return Promise.resolve({
      doc: h.doc,
      numPages: 3,
      width: 612,
      height: 792,
      renderPage: () =>
        Promise.resolve({ promise: Promise.resolve(), cancel: vi.fn() }),
      destroy: vi.fn(),
    });
  },
  PdfViewer: class FakePdfViewer {
    constructor(container: HTMLElement, _api: unknown) {
      h.viewerConstructor(container, _api);
    }
    getTotalScale() {
      return 1;
    }
    setZoom(_scale: number) {}
    fitWidth() {}
    fitPage() {}
    getAnnotationLayer(): HTMLDivElement | null {
      return null;
    }
    onReady(_cb: () => void) {}
    setOnScaleChange(
      _cb: (e: { renderScale: number; displayScale: number; totalScale: number }) => void,
    ): () => void {
      return () => undefined;
    }
    // ─── Task 38 door ────────────────────────────────────────
    goToPage(n: number) {
      h.goToPage(n);
    }
    getCurrentPage() {
      return h.getCurrentPage();
    }
    getPageSnapshot(page: number, uv: [number, number], maxWidthPx = 400) {
      return h.getPageSnapshot(page, uv, maxWidthPx);
    }
    destroy() {
      h.viewerDestroy();
    }
  },
}));

import { PdfOverlay, type PdfOverlayHandle } from "@ff/viewer-react";

const version = { blobKey: "blob-1", width: 612, height: 792 };

describe("<PdfOverlay> handle — Task 38 navigation + document door", () => {
  beforeEach(() => {
    h.goToPage.mockClear();
    h.getCurrentPage.mockClear();
    h.getPageSnapshot.mockClear();
    h.viewerConstructor.mockClear();
    h.viewerDestroy.mockClear();
    h.loadPDF.mockClear();
    h.getCurrentPage.mockReturnValue(2);
    h.getPageSnapshot.mockReturnValue(null);
  });

  it("goToPage delegates to the viewer", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    await waitFor(() => expect(h.viewerConstructor).toHaveBeenCalled());

    ref.current?.goToPage(7);
    expect(h.goToPage).toHaveBeenCalledTimes(1);
    expect(h.goToPage).toHaveBeenCalledWith(7);
  });

  it("getCurrentPage returns the viewer's current page", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    await waitFor(() => expect(h.viewerConstructor).toHaveBeenCalled());

    expect(ref.current?.getCurrentPage()).toBe(2);
    h.getCurrentPage.mockReturnValue(5);
    expect(ref.current?.getCurrentPage()).toBe(5);
  });

  it("getDocument returns the loaded PDF.js document", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    await waitFor(() => expect(h.viewerConstructor).toHaveBeenCalled());

    expect(ref.current?.getDocument()).toBe(h.doc);
  });

  it("getDocument is null until the PDF has loaded", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    // A version lookup that never settles → the viewer is never
    // built → there is no document to hand out.
    const pending = new Promise<typeof version>(() => undefined);
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={() => pending}
        getPdfBlob={async () => null}
      />,
    );

    expect(ref.current).not.toBeNull();
    expect(ref.current?.getDocument()).toBeNull();
    expect(h.viewerConstructor).not.toHaveBeenCalled();
  });

  it("getDocument is null again after the overlay is torn down", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    const { unmount } = render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    await waitFor(() => expect(h.viewerConstructor).toHaveBeenCalled());
    expect(ref.current?.getDocument()).toBe(h.doc);

    // Keep a handle on the imperative handle object itself: React
    // detaches `ref.current` on unmount, but the handle still
    // points at the overlay's refs — the document must be gone.
    const handle = ref.current;
    unmount();
    expect(handle?.getDocument()).toBeNull();
  });

  it("getPageSnapshot is null before the viewer builds (jsdom-safe)", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.getPageSnapshot(1, [0.5, 0.5])).toBeNull();
  });

  it("getPageSnapshot delegates to the viewer once built", async () => {
    const ref = { current: null as PdfOverlayHandle | null };
    render(
      <PdfOverlay
        ref={ref}
        pdfVersionId="v1"
        getPdfVersion={async () => version}
        getPdfBlob={async () => new Blob([new Uint8Array([1, 2, 3])])}
      />,
    );
    await waitFor(() => expect(h.viewerConstructor).toHaveBeenCalled());

    h.getPageSnapshot.mockReturnValue("data:image/jpeg;base64,AAAA");
    expect(ref.current?.getPageSnapshot(1, [0.5, 0.5], 300)).toBe("data:image/jpeg;base64,AAAA");
    expect(h.getPageSnapshot).toHaveBeenCalledWith(1, [0.5, 0.5], 300);
  });
});
