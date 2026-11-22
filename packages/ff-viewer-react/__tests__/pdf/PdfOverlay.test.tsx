// __tests__/viewer/pdf/PdfOverlay.test.tsx
//
// Component tests for <PdfOverlay>.
//
// We don't run the real PDF.js worker (jsdom can't host a
// WebWorker), so `loadPDF` is mocked to return a fake `PdfApi`
// whose methods are no-ops. This lets us assert the React-level
// wiring: StrictMode-safe mount, blob → version resolution,
// error surface, and `destroy()` called on unmount / prop
// change.
//
// See docs/TASK-11-PDF-CANVAS.md "Component tests" for the
// happy-path assertions. The ones we cover here:
//
//   - Mount loads the version + blob from Dexie, instantiates a
//     PdfViewer.
//   - Unmount calls `destroy()` on the PdfViewer.
//   - Switching `pdfVersionId` prop reloads the canvas
//     (unmount old, mount new).
//   - Errors during load (e.g. version missing) surface inline.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, act } from "@testing-library/react";

// Task 20 §1.8.3: PdfOverlay now takes getPdfVersion and
// getPdfBlob as props (it no longer imports Settings's DB
// tables). The test uses a simple in-memory map as the "DB"
// — same shape the Settings app provides, just instantiated
// locally so the test is self-contained in the package.
import { PdfOverlay } from "@ff/viewer-react";

// We need to mock loadPDF BEFORE the component is imported
// (otherwise the real pdfjs-dist import path runs and jsdom
// doesn't have DOMMatrix / worker etc.).
//
// IMPORTANT: this used to be TWO separate `vi.mock("@ff/viewer")`
// calls — one for `loadPDF` and one for the `PdfViewer` class.
// Vitest keeps only the LAST registration for a module id, so the
// `loadPDF` mock was silently dropped and every render failed with
// `No "loadPDF" export is defined on the "@ff/viewer" mock`.
// Both exports now live in a single factory.
const mockRenderPage = vi.fn();
const mockDestroy = vi.fn();
const mockLoadPDF = vi.fn();

// Mock the PdfViewer class to avoid rendering real DOM and
// invoking the real render loop. We track mount / destroy.
const mockViewerDestroy = vi.fn();
const mockViewerConstructor = vi.fn();

vi.mock("@ff/viewer", () => ({
  // `loadPDF` boots pdfjs-dist (worker + DOMMatrix), which jsdom
  // can't host — stub it with a fake PdfApi whose methods are
  // no-ops so the React-level wiring can be asserted.
  loadPDF: (...args: unknown[]) => {
    mockLoadPDF(...args);
    return Promise.resolve({
      doc: { numPages: 1 },
      numPages: 1,
      width: 612,
      height: 792,
      renderPage: mockRenderPage.mockResolvedValue({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      }),
      destroy: mockDestroy,
    });
  },
  PdfViewer: class FakePdfViewer {
    constructor(container: HTMLElement, _api: unknown, opts?: unknown) {
      mockViewerConstructor(container, _api, opts);
    }
    getTotalScale() { return 1; }
    setZoom(_s: number) {}
    fitWidth() {}
    fitPage() {}
    // pageCoordsFromEvent: Task 12a Part 2 calibration wizard.
    // Tests that exercise the new captureClicks flow get the
    // full method. The implementation mirrors the real one:
    // assume scale=1, no pan, return the click's canvas-relative
    // CSS coords. Tests that care about the exact value override
    // the field below.
    pageCoordsFromEvent(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null }) {
      return { x: e.clientX, y: e.clientY };
    }
    // Task 15b: annotation-layer API. The fake returns a real
    // div appended to the container so any consumer that
    // portals into it has somewhere to land.
    getAnnotationLayer(): HTMLDivElement {
      const div = document.createElement("div");
      div.setAttribute("data-pv-annotation-layer", "true");
      return div;
    }
    setOnScaleChange(_cb: (e: { renderScale: number; displayScale: number; totalScale: number }) => void): () => void {
      return () => undefined;
    }
    destroy() { mockViewerDestroy(); }
  },
}));

// In-memory fake of the Settings Dexie schema. The test
// populates it with a project → building → pdfFile → pdfVersion
// → blob chain, then passes the lookup functions to <PdfOverlay>
// as props. The shape matches the Settings app's record types
// structurally — duck typing handles the conversion.
type FakeVersion = {
  id: string;
  pdfFileId: string;
  blobKey: string;
  width: number;
  height: number;
};
const fakeDb = {
  versions: new Map<string, FakeVersion>(),
  blobs: new Map<string, Blob>(),
};

function resetFakeDb(): void {
  fakeDb.versions.clear();
  fakeDb.blobs.clear();
  // Auto-incrementing id counter.
  (fakeDb as unknown as { _idCounter: number })._idCounter = 0;
}
resetFakeDb();

function makePdfVersionWithBlob(name: string): {
  version: FakeVersion;
  getPdfVersion: (id: string) => Promise<FakeVersion | null>;
  getPdfBlob: (key: string) => Promise<Blob | null>;
} {
  const counter = (fakeDb as unknown as { _idCounter: number })._idCounter++;
  const version: FakeVersion = {
    id: `v-${name}-${counter}`,
    pdfFileId: `f-${name}-${counter}`,
    blobKey: `blob-${name}-${counter}`,
    width: 612,
    height: 792,
  };
  fakeDb.versions.set(version.id, version);
  fakeDb.blobs.set(
    version.blobKey,
    new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])]),
  );
  return {
    version,
    getPdfVersion: async (id: string) => fakeDb.versions.get(id) ?? null,
    getPdfBlob: async (key: string) => fakeDb.blobs.get(key) ?? null,
  };
}

describe("<PdfOverlay>", () => {
  beforeEach(async () => {
    resetFakeDb();
    mockViewerDestroy.mockClear();
    mockViewerConstructor.mockClear();
    mockLoadPDF.mockClear();
    mockRenderPage.mockClear();
    mockDestroy.mockClear();
  });

  it("loads the version + blob and mounts the PdfViewer", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("a.pdf");
    render(<PdfOverlay pdfVersionId={v.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    expect(mockLoadPDF).toHaveBeenCalledTimes(1);
  });

  it("wave 64: opens multi-page uploads but locks the viewer to page 1 by default", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("a.pdf");
    render(<PdfOverlay pdfVersionId={v.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    expect(mockLoadPDF.mock.calls[0]?.[1]).toEqual({ singlePage: false });
    expect(mockViewerConstructor.mock.calls[0]?.[2]).toMatchObject({ maxPages: 1 });
  });

  it("wave 64: allowMultiPage exposes every page (no page cap)", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("a.pdf");
    render(
      <PdfOverlay
        pdfVersionId={v.id}
        getPdfVersion={getPdfVersion}
        getPdfBlob={getPdfBlob}
        allowMultiPage
      />,
    );
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    expect(mockLoadPDF.mock.calls[0]?.[1]).toEqual({ singlePage: false });
    const opts = mockViewerConstructor.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("maxPages");
  });

  it("calls PdfViewer.destroy() on unmount", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("a.pdf");
    const { unmount } = render(<PdfOverlay pdfVersionId={v.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    await act(async () => {
      unmount();
    });
    expect(mockViewerDestroy).toHaveBeenCalled();
  });

  it("re-mounts (and re-destroys) when pdfVersionId changes", async () => {
    const { version: v1, getPdfVersion, getPdfBlob } =
      makePdfVersionWithBlob("a.pdf");
    const { version: v2 } = makePdfVersionWithBlob("b.pdf");
    const { rerender } = render(<PdfOverlay pdfVersionId={v1.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalledTimes(1);
    });
    rerender(<PdfOverlay pdfVersionId={v2.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalledTimes(2);
    });
    expect(mockViewerDestroy).toHaveBeenCalled();
  });

  it("surfaces an inline error when the version is missing", async () => {
    // The resolvers come from a DIFFERENT (existing) version, so
    // the id below resolves to null → the overlay shows its inline
    // error state.
    const { getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("missing.pdf");
    render(<PdfOverlay pdfVersionId="definitely-not-a-real-id" getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="pdf-overlay-error"]'),
      ).toBeInTheDocument();
    });
  });

  it("renders no close button (the viewer has no × control)", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("a.pdf");
    render(<PdfOverlay pdfVersionId={v.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(document.querySelector('[data-debug="pdf-overlay-info"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="pdf-overlay-close"]')).toBeNull();
    expect(document.querySelector('[aria-label*="Close PDF"]')).toBeNull();
  });
});

// ─── Task 12a Part 2: captureClicks + onPdfClick ─────────────

describe("<PdfOverlay> — captureClicks (Task 12a Part 2)", () => {
  beforeEach(() => {
    // Reset the in-memory fake DB (the Settings app's `resetDb`
    // helper doesn't exist in this package — the fake DB is local).
    resetFakeDb();
    mockViewerDestroy.mockClear();
    mockViewerConstructor.mockClear();
    mockLoadPDF.mockClear();
    mockRenderPage.mockClear();
    mockDestroy.mockClear();
  });

  it("forwards click coords to onPdfClick when captureClicks is true", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("capture.pdf");
    const handleClick = vi.fn();
    render(
      <PdfOverlay
        pdfVersionId={v.id}
        captureClicks
        onPdfClick={handleClick} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    // Wait for the PdfViewer to mount (so the canvas exists).
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    const overlay = document.querySelector(
      "[data-testid=\"pdf-overlay\"]",
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    // Synthetic click at (50, 80) on the overlay.
    fireEvent.click(overlay, { clientX: 50, clientY: 80 });
    expect(handleClick).toHaveBeenCalledWith({ x: 50, y: 80 });
  });

  it("does NOT forward clicks when captureClicks is false (default)", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("no-capture.pdf");
    const handleClick = vi.fn();
    render(
      <PdfOverlay pdfVersionId={v.id} onPdfClick={handleClick} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    const overlay = document.querySelector(
      "[data-testid=\"pdf-overlay\"]",
    ) as HTMLElement;
    fireEvent.click(overlay, { clientX: 50, clientY: 80 });
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("does NOT forward clicks when onPdfClick is missing", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("no-cb.pdf");
    render(<PdfOverlay pdfVersionId={v.id} captureClicks getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />);
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    // No crash, no error.
    const overlay = document.querySelector(
      "[data-testid=\"pdf-overlay\"]",
    ) as HTMLElement;
    expect(() => fireEvent.click(overlay, { clientX: 50, clientY: 80 })).not.toThrow();
  });

  it("exposes the captureClicks state via data-attribute", async () => {
    // The resolvers are required for the overlay to actually mount
    // the PdfViewer (without them the version lookup fails and the
    // overlay renders its inline error instead).
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("attr.pdf");
    const { rerender } = render(
      <PdfOverlay pdfVersionId={v.id} captureClicks={false} onPdfClick={() => {}} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    await waitFor(() => {
      expect(mockViewerConstructor).toHaveBeenCalled();
    });
    let overlay = document.querySelector(
      "[data-testid=\"pdf-overlay\"]",
    ) as HTMLElement;
    expect(overlay.dataset.captureClicks).toBe("false");

    rerender(
      <PdfOverlay pdfVersionId={v.id} captureClicks onPdfClick={() => {}} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    overlay = document.querySelector(
      "[data-testid=\"pdf-overlay\"]",
    ) as HTMLElement;
    expect(overlay.dataset.captureClicks).toBe("true");
  });
});

// ─── Wave 5B: tap-to-create onTap (click-vs-drag, canvas-only) ───

// jsdom has no `window.PointerEvent`, so `fireEvent.pointerDown/Up`
// falls back to `new Event(...)` which DROPS `clientX`/`clientY`.
// Dispatch a `MouseEvent` with the pointer type instead — React's
// onPointerDown/onPointerUp fire on the type name and the native event
// keeps its coordinates (the same reason `fireEvent.click` works).
function firePointer(
  el: HTMLElement,
  type: "pointerdown" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  el.dispatchEvent(
    new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }),
  );
}

describe("<PdfOverlay> — onTap (Wave 5B tap-to-create)", () => {
  beforeEach(() => {
    resetFakeDb();
    mockViewerDestroy.mockClear();
    mockViewerConstructor.mockClear();
    mockLoadPDF.mockClear();
    mockRenderPage.mockClear();
    mockDestroy.mockClear();
  });

  it("fires onTap for a stationary, quick press and hands it page coords", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("tap.pdf");
    const onTap = vi.fn();
    render(
      <PdfOverlay pdfVersionId={v.id} onTap={onTap} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    const overlay = document.querySelector("[data-testid=\"pdf-overlay\"]") as HTMLElement;

    firePointer(overlay, "pointerdown", 50, 80);
    firePointer(overlay, "pointerup", 50, 80);

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith({ x: 50, y: 80 });
  });

  it("does NOT fire onTap for a drag (movement beyond the threshold)", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("drag.pdf");
    const onTap = vi.fn();
    render(
      <PdfOverlay pdfVersionId={v.id} onTap={onTap} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    const overlay = document.querySelector("[data-testid=\"pdf-overlay\"]") as HTMLElement;

    firePointer(overlay, "pointerdown", 0, 0);
    firePointer(overlay, "pointerup", 40, 0);

    expect(onTap).not.toHaveBeenCalled();
  });

  it("fires onTap even without captureClicks armed", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("unarmed.pdf");
    const onTap = vi.fn();
    render(
      <PdfOverlay pdfVersionId={v.id} captureClicks={false} onTap={onTap} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />,
    );
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    const overlay = document.querySelector("[data-testid=\"pdf-overlay\"]") as HTMLElement;

    firePointer(overlay, "pointerdown", 10, 20);
    firePointer(overlay, "pointerup", 10, 20);

    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("<PdfOverlay> — StrictMode double mount", () => {
  beforeEach(() => {
    mockViewerConstructor.mockClear();
    mockViewerDestroy.mockClear();
    mockLoadPDF.mockClear();
    resetFakeDb();
  });

  it("builds exactly ONE viewer (no ghost viewer from the first mount)", async () => {
    const { version: v, getPdfVersion, getPdfBlob } = makePdfVersionWithBlob("strict.pdf");
    const { StrictMode } = await import("react");
    render(
      <StrictMode>
        <PdfOverlay pdfVersionId={v.id} getPdfVersion={getPdfVersion} getPdfBlob={getPdfBlob} />
      </StrictMode>,
    );
    await waitFor(() => expect(mockViewerConstructor).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(mockViewerConstructor).toHaveBeenCalledTimes(1);
  });
});
