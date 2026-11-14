// __tests__/PdfNavPanel.test.tsx
//
// Task 38 — the Documents nav panel (outline + thumbnails).
//
// The panel is driven entirely through the <PdfOverlay>
// imperative handle: it reads the loaded PDF.js document from
// `getDocument()` and navigates with `goToPage(n)` /
// `getCurrentPage()`. This test therefore mocks the HANDLE (not
// the viewer) and mocks the PDF.js document it hands out.
//
// Covered:
//   - Outline: a nested outline is flattened into the right
//     1-based page numbers.
//   - Outline: items without a destination (named actions) are
//     skipped silently.
//   - Outline: a document with no outline renders no outline
//     section at all.
//   - Thumbnails: one canvas per page, rendered lazily.
//   - Thumbnails: clicking a thumbnail calls goToPage(n).
//   - Thumbnails: the current page is highlighted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { PdfOverlayHandle } from "@ff/viewer-react";

import PdfNavPanel from "../src/PdfNavPanel";

// ── Fake PDF.js document ──────────────────────────────────────

/** A page reference as PDF.js hands it back. */
interface FakeRef {
  __index: number;
}

interface FakeDoc {
  numPages: number;
  getOutline: ReturnType<typeof vi.fn>;
  getDestination: ReturnType<typeof vi.fn>;
  getPageIndex: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
}

function makeDoc(options: {
  numPages: number;
  outline?: unknown[] | null;
}): FakeDoc {
  const getOutline = vi.fn(async () =>
    options.outline === undefined ? null : options.outline,
  );
  // Named destination → an explicit destination whose first
  // element is the page reference.
  const getDestination = vi.fn(async (id: string) => {
    if (id === "named-1") {
      return [{ __index: 0 } satisfies FakeRef, { name: "XYZ" }];
    }
    return null;
  });
  const getPageIndex = vi.fn(async (ref: FakeRef) => ref.__index);
  const getPage = vi.fn(async (_pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: () => ({ promise: Promise.resolve() }),
  }));
  return {
    numPages: options.numPages,
    getOutline,
    getDestination,
    getPageIndex,
    getPage,
  };
}

// ── Fake overlay handle ────────────────────────────────────────

function makeHandle(doc: unknown, currentPage = 1) {
  return {
    goToPage: vi.fn(),
    getCurrentPage: vi.fn(() => currentPage),
    getDocument: vi.fn(() => doc),
    getTotalScale: () => 1,
    setZoom: () => undefined,
    fitWidth: () => undefined,
    fitPage: () => undefined,
    getAnnotationLayer: () => null,
    onReady: () => undefined,
    setOnScaleChange: () => () => undefined,
  };
}

function renderPanel(
  doc: unknown,
  options: { currentPage?: number } = {},
): { handle: ReturnType<typeof makeHandle> } {
  const handle = makeHandle(doc, options.currentPage ?? 1);
  const overlayRef = { current: handle as unknown as PdfOverlayHandle };
  render(
    <PdfNavPanel overlayRef={overlayRef} activePdfVersionId="pdfv-1" />,
  );
  return { handle };
}

// ── Canvas + IntersectionObserver stubs ────────────────────────

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalIntersectionObserver = (
  globalThis as unknown as { IntersectionObserver?: unknown }
).IntersectionObserver;

/** Minimal 2D context stub — jsdom has no canvas backend. */
function installCanvasStub(): void {
  HTMLCanvasElement.prototype.getContext = (() =>
    ({} as unknown as CanvasRenderingContext2D)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

/** Minimal IntersectionObserver stub with manual triggering. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;

  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.elements.push(element);
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Mark every observed element as visible. */
  trigger(): void {
    const entries = this.elements.map(
      (target) =>
        ({
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        }) as unknown as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** Reveal every thumbnail the observer is watching. */
function revealThumbnails(): void {
  act(() => {
    for (const observer of FakeIntersectionObserver.instances) {
      observer.trigger();
    }
  });
}

describe("PdfNavPanel", () => {
  beforeEach(() => {
    installCanvasStub();
    FakeIntersectionObserver.instances = [];
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
      FakeIntersectionObserver;
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
      originalIntersectionObserver;
    vi.restoreAllMocks();
  });

  // ── Outline ────────────────────────────────────────────────

  it("flattens a nested outline into 1-based page numbers", async () => {
    const doc = makeDoc({
      numPages: 3,
      outline: [
        {
          title: "General Notes",
          dest: "named-1",
          items: [
            {
              title: "Scope of Work",
              dest: [{ __index: 2 } satisfies FakeRef, { name: "Fit" }],
            },
          ],
        },
      ],
    });
    renderPanel(doc);

    await waitFor(() => {
      expect(
        screen.getByTestId("documents-nav-outline-item-0"),
      ).toBeInTheDocument();
    });

    const first = screen.getByTestId("documents-nav-outline-item-0");
    expect(first).toHaveTextContent("General Notes");
    expect(first).toHaveAttribute("data-page", "1");

    const second = screen.getByTestId("documents-nav-outline-item-1");
    expect(second).toHaveTextContent("Scope of Work");
    // The nested item points at page index 2 → displayed as page 3.
    expect(second).toHaveAttribute("data-page", "3");
    expect(second).toHaveAttribute("data-depth", "1");

    // Named destination resolution went through getDestination.
    expect(doc.getDestination).toHaveBeenCalledWith("named-1");
    expect(doc.getPageIndex).toHaveBeenCalled();
  });

  it("skips outline items that have no destination", async () => {
    const doc = makeDoc({
      numPages: 2,
      outline: [
        { title: "Named action", dest: null },
        {
          title: "Real page",
          dest: [{ __index: 1 } satisfies FakeRef, { name: "Fit" }],
        },
      ],
    });
    renderPanel(doc);

    await waitFor(() => {
      expect(
        screen.getByTestId("documents-nav-outline-item-0"),
      ).toBeInTheDocument();
    });

    // The action-only item is gone; the resolvable one survived
    // and became the FIRST entry.
    const item = screen.getByTestId("documents-nav-outline-item-0");
    expect(item).toHaveTextContent("Real page");
    expect(item).toHaveAttribute("data-page", "2");
    expect(
      screen.queryByTestId("documents-nav-outline-item-1"),
    ).toBeNull();
    expect(screen.queryByText("Named action")).toBeNull();
  });

  it("renders no outline section when the document has no outline", async () => {
    const doc = makeDoc({ numPages: 1, outline: null });
    renderPanel(doc);

    await waitFor(() => {
      expect(doc.getOutline).toHaveBeenCalled();
    });
    // Give the state update a tick to land.
    await waitFor(() => {
      expect(
        screen.getByTestId("documents-nav-thumbnails"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("documents-nav-outline")).toBeNull();
  });

  // ── Thumbnails ─────────────────────────────────────────────

  it("renders one thumbnail canvas per page", async () => {
    const doc = makeDoc({ numPages: 3, outline: null });
    renderPanel(doc);

    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0);
    });
    revealThumbnails();

    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledTimes(3);
    });
    expect(doc.getPage).toHaveBeenCalledWith(1);
    expect(doc.getPage).toHaveBeenCalledWith(2);
    expect(doc.getPage).toHaveBeenCalledWith(3);

    const canvases = document.querySelectorAll(
      '[data-testid^="documents-nav-thumb-"] canvas',
    );
    expect(canvases).toHaveLength(3);
  });

  it("wave 63: thumbnails clean up their page and cancel an in-flight render on unmount", async () => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const doc = makeDoc({ numPages: 2, outline: null });
    let done = 0;
    doc.getPage.mockImplementation(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      // page 1 finishes, page 2 hangs until cancelled
      render: () =>
        ++done === 1
          ? { promise: Promise.resolve(), cancel }
          : { promise: new Promise(() => undefined), cancel },
      cleanup,
    }));
    const handle = makeHandle(doc);
    const overlayRef = { current: handle as unknown as PdfOverlayHandle };
    const { unmount } = render(
      <PdfNavPanel overlayRef={overlayRef} activePdfVersionId="pdfv-1" />,
    );
    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1)); // page 1 done
    await waitFor(() => expect(done).toBe(2)); // page 2 render started
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it("renders immediately when the browser has no IntersectionObserver", async () => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    const doc = makeDoc({ numPages: 2, outline: null });
    renderPanel(doc);

    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledTimes(2);
    });
  });

  it("jumps to the clicked page", async () => {
    const doc = makeDoc({ numPages: 3, outline: null });
    const { handle } = renderPanel(doc);

    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0);
    });
    revealThumbnails();
    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledTimes(3);
    });
    fireEvent.click(screen.getByTestId("documents-nav-thumb-3"));
    expect(handle.goToPage).toHaveBeenCalledTimes(1);
    expect(handle.goToPage).toHaveBeenCalledWith(3);
  });

  it("renders the thumbnails lazily (only when they become visible)", async () => {
    const doc = makeDoc({ numPages: 3, outline: null });
    renderPanel(doc);

    // The observer is registered, but nothing has been drawn yet.
    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0);
    });
    expect(doc.getPage).not.toHaveBeenCalled();

    act(() => {
      for (const observer of FakeIntersectionObserver.instances) {
        observer.trigger();
      }
    });

    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledTimes(3);
    });
  });

  it("highlights the current page", async () => {
    const doc = makeDoc({ numPages: 3, outline: null });
    renderPanel(doc, { currentPage: 2 });

    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0);
    });
    revealThumbnails();
    await waitFor(() => {
      expect(doc.getPage).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTestId("documents-nav-thumb-2")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("documents-nav-thumb-1")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("re-reads the document when the active version changes", async () => {
    const docA = makeDoc({ numPages: 2, outline: null });
    const docB = makeDoc({ numPages: 5, outline: null });
    const handle = makeHandle(docA, 1);
    const overlayRef = { current: handle as unknown as PdfOverlayHandle };

    const { rerender } = render(
      <PdfNavPanel overlayRef={overlayRef} activePdfVersionId="pdfv-1" />,
    );
    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0);
    });
    revealThumbnails();
    await waitFor(() => {
      expect(docA.getPage).toHaveBeenCalledTimes(2);
    });

    // Document switch: the handle now hands out another document.
    handle.getDocument.mockReturnValue(docB);
    rerender(
      <PdfNavPanel overlayRef={overlayRef} activePdfVersionId="pdfv-2" />,
    );

    await waitFor(() => {
      expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(3);
    });
    revealThumbnails();
    await waitFor(() => {
      expect(docB.getPage).toHaveBeenCalledTimes(5);
    });
    expect(
      document.querySelectorAll('[data-testid^="documents-nav-thumb-"] canvas'),
    ).toHaveLength(5);
  });
});
