// __tests__/pdf/PdfViewer.navigation.test.ts
//
// Task 38 — the public navigation door on `PdfViewer`.
//
// `goToPage` / `getCurrentPage` are the ONLY additions this task
// makes to `packages/ff-viewer/src/pdf/pdfViewer.ts`. They are
// thin delegations onto the existing private `_goToPage` state
// machine and the existing `currentPage` field — the diff on
// that file must stay purely additive.
//
// The tests below lock three things:
//   1. `goToPage` moves the current page (delegation works).
//   2. `goToPage` really calls the private `_goToPage` (no
//      re-implementation of the state machine).
//   3. Out-of-range values are ignored, exactly like
//      `_goToPage` ignores them.
//
// Same fake-DOM trick as PdfViewer.class.test.ts: the real
// constructor builds the viewer UI, which works in jsdom, and
// `renderPage` is a no-op promise.

import { describe, expect, it, vi } from "vitest";

import { PdfViewer } from "@ff/viewer";

function makeViewer(numPages: number, maxPages?: number): PdfViewer {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const fakeApi = {
    numPages,
    doc: { numPages },
    destroy: () => undefined,
    renderPage: () =>
      Promise.resolve({
        promise: Promise.resolve(),
        cancel: () => undefined,
      }),
  };

  return new PdfViewer(container, fakeApi as never, {
    instanceId: "test",
    ...(maxPages !== undefined ? { maxPages } : {}),
  });
}

describe("PdfViewer public navigation door (Task 38)", () => {
  it("starts on page 1 and reports it through getCurrentPage()", () => {
    const viewer = makeViewer(5);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.destroy();
  });

  it("goToPage changes the current page", () => {
    const viewer = makeViewer(5);
    viewer.goToPage(3);
    expect(viewer.getCurrentPage()).toBe(3);
    viewer.goToPage(1);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.destroy();
  });

  it("goToPage delegates to the private _goToPage (no duplicated logic)", () => {
    const viewer = makeViewer(5);
    const internal = viewer as unknown as {
      _goToPage: (n: number) => void;
    };
    const spy = vi.spyOn(internal, "_goToPage");
    viewer.goToPage(4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(4);
    viewer.destroy();
  });

  it("ignores out-of-range pages (mirrors _goToPage)", () => {
    const viewer = makeViewer(3);
    viewer.goToPage(0);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.goToPage(-1);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.goToPage(4);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.goToPage(999);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.destroy();
  });

  it("accepts the last page of the document", () => {
    const viewer = makeViewer(3);
    viewer.goToPage(3);
    expect(viewer.getCurrentPage()).toBe(3);
    viewer.destroy();
  });
});

describe("PdfViewer page flips during a render (wave 63)", () => {
  it("a page requested while a render is in flight is drawn when it settles", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const rendered: number[] = [];
    let release: (() => void) | null = null;
    const fakeApi = {
      numPages: 4,
      doc: { numPages: 4 },
      destroy: () => undefined,
      renderPage: (_c: HTMLCanvasElement, page: number) => {
        rendered.push(page);
        const promise =
          rendered.length === 1
            ? new Promise<void>((r) => (release = r))
            : Promise.resolve();
        return Promise.resolve({ promise, cancel: () => undefined, cssWidth: 100, cssHeight: 50 });
      },
    };
    const viewer = new PdfViewer(container, fakeApi as never, { instanceId: "q" });
    await Promise.resolve();
    viewer.goToPage(3); // page 1 still rendering
    expect(rendered).toEqual([1]);
    release!();
    await vi.waitFor(() => expect(rendered).toEqual([1, 3]));
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    // CSS size comes from the render, not canvas pixels / dpr.
    expect(canvas.style.width).toBe("100px");
    viewer.destroy();
  });
});

describe("PdfViewer maxPages cap (wave 64)", () => {
  it("locks a multi-page document to page 1 with maxPages: 1", () => {
    const viewer = makeViewer(2, 1);
    viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(1);
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.querySelector(".pv-total")?.textContent).toBe("1");
    viewer.destroy();
  });

  it("exposes every page without a cap", () => {
    const viewer = makeViewer(2);
    viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(2);
    const root = document.body.lastElementChild as HTMLElement;
    expect(root.querySelector(".pv-total")?.textContent).toBe("2");
    viewer.destroy();
  });

  it("never exceeds the document's page count", () => {
    const viewer = makeViewer(2, 5);
    viewer.goToPage(3);
    expect(viewer.getCurrentPage()).toBe(1);
    viewer.goToPage(2);
    expect(viewer.getCurrentPage()).toBe(2);
    viewer.destroy();
  });
});
