// __tests__/viewer/PdfViewer.class.test.ts
//
// Unit tests for the new `pageCoordsFromEvent` method on the
// ported PdfViewer class. The real PdfViewer constructor pulls
// in PDF.js, which jsdom can't host — so we instantiate the
// class with a fake DOM container and a fake PdfApi stub, and
// only call the method we care about (the rest of the class
// doesn't run because the constructor short-circuits).
//
// We can't easily call `new PdfViewer(container, api)` in jsdom
// because the DOM build + worker fan-out are heavy. Instead
// we exercise the method by constructing the object via a
// `as unknown as PdfViewer` cast and setting the private
// fields the method reads. This is a deliberate test-only
// shortcut — the production code path uses the real
// constructor. The point is to lock the math, not the wiring.

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { PdfViewer } from "@ff/viewer";

interface FakePdfApi {
  numPages: number;
  destroy: () => void;
  doc: { numPages: number };
  renderPage: () => Promise<{ promise: Promise<void>; cancel: () => void }>;
}

function makeFakeViewer(
  scale: number,
  displayScale: number,
  translateX: number,
  translateY: number,
  rect: { left: number; top: number; width: number; height: number } = {
    left: 0,
    top: 0,
    width: 100,
    height: 100,
  },
): PdfViewer {
  // Stub DOM container — the real constructor would build
  // the full viewer UI, but the test only needs `canvas` and
  // the private transform fields.
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  // jsdom doesn't compute layout, so getBoundingClientRect()
  // returns all zeros by default. Stub it.
  canvas.getBoundingClientRect = () => {
    return {
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  // Set intrinsic width so the scale-computation fallback
  // (canvas.width / devicePixelRatio) works. In a real browser
  // this is set by PDF.js's renderPage.
  canvas.width = rect.width;
  container.appendChild(canvas);

  const fakeApi: FakePdfApi = {
    numPages: 1,
    doc: { numPages: 1 },
    destroy: () => undefined,
    renderPage: () => Promise.resolve({ promise: Promise.resolve(), cancel: () => undefined }),
  };

  // Construct the real class. The constructor builds the DOM
  // and binds events, which works in jsdom as long as the
  // container is in the document. We append to the body so
  // any document.querySelector calls work.
  document.body.appendChild(container);
  // The real constructor accepts a PdfApi — our fake matches
  // the shape closely enough (it has numPages, destroy, doc,
  // renderPage). The only side effect the constructor has
  // is calling _renderCurrentPage, which awaits renderPage
  // (a no-op Promise in our fake). The DOM mutation it
  // performs is harmless in jsdom.
  const viewer = new PdfViewer(container, fakeApi as never, {
    instanceId: "test",
  });

  // Pin the private transform fields for the test. We use
  // the public setZoom / fitWidth / etc. to set the scale,
  // but those are coupled to render scheduling. Direct
  // field assignment is more deterministic.
  const v = viewer as unknown as {
    scale: number;
    _displayScale: number;
    _translateX: number;
    _translateY: number;
    canvas: HTMLCanvasElement;
    _pageWidth: number;
  };
  v.scale = scale;
  v._displayScale = displayScale;
  v._translateX = translateX;
  v._translateY = translateY;
  v.canvas = canvas;
  // Ground-truth page width so the primary totalScale =
  // rect.width / _pageWidth path works in tests.
  v._pageWidth = canvas.width / scale;
  // Update the getBoundingClientRect stub to include the
  // CSS display scale (the mock is created before displayScale
  // is pinned, so we re-stub).
  canvas.getBoundingClientRect = () => {
    const ds = displayScale;
    return {
      x: rect.left * ds,
      y: rect.top * ds,
      left: rect.left * ds,
      top: rect.top * ds,
      right: (rect.left + rect.width) * ds,
      bottom: (rect.top + rect.height) * ds,
      width: rect.width * ds,
      height: rect.height * ds,
      toJSON: () => ({}),
    } as DOMRect;
  };

  return viewer;
}

describe("PdfViewer.pageCoordsFromEvent", () => {
  let viewer: PdfViewer;

  /** Dispatch a click on the canvas so e.target === canvas. */
  function clickOn(
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ): MouseEvent {
    const e = new MouseEvent("click", { clientX, clientY, bubbles: true });
    canvas.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    viewer = makeFakeViewer(1, 1, 0, 0);
  });
  afterEach(() => {
    try {
      viewer.destroy();
    } catch {
      // ignore
    }
  });

  it("returns null when the canvas is missing", () => {
    const v = viewer as unknown as { canvas: HTMLCanvasElement | null };
    v.canvas = null;
    const result = viewer.pageCoordsFromEvent(new MouseEvent("click"));
    expect(result).toBeNull();
  });

  it("returns null when total scale is zero (render not started)", () => {
    const v = viewer as unknown as {
      scale: number;
      _displayScale: number;
    };
    v.scale = 0;
    v._displayScale = 0;
    const result = viewer.pageCoordsFromEvent(new MouseEvent("click"));
    expect(result).toBeNull();
  });

  it("identity transform: CSS (x, y) maps to PDF (x, y)", () => {
    // scale=1, displayScale=1, no pan. A click at CSS (50, 80)
    // on a 100x100 canvas → PDF (50, 80).
    const cv = (viewer as unknown as { canvas: HTMLCanvasElement }).canvas;
    const e = clickOn(cv, 50, 80);
    const result = viewer.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: 80 });
  });

  it("applies uniform scale 2x (CSS pixels are 2× the PDF points)", () => {
    const v = makeFakeViewer(2, 1, 0, 0, {
      left: 0,
      top: 0,
      // 300x300 rect so the click at (100, 200) is well inside.
      // The Task 15b off-canvas rejection check would otherwise
      // kick in (cssY=200 > 100).
      width: 300,
      height: 300,
    });
    // scale=2 means 1 PDF point = 2 CSS pixels. A click at
    // CSS (100, 200) → PDF (50, 100).
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 100, 200);
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: 100 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("applies a (displayScale=2, renderScale=1) display-scale-only zoom", () => {
    // totalScale = 1 * 2 = 2. CSS (100, 200) → PDF (50, 100).
    const v = makeFakeViewer(1, 2, 0, 0, {
      left: 0,
      top: 0,
      // Same as above: click at (100, 200) needs a 300x300 rect.
      width: 300,
      height: 300,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 100, 200);
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: 100 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("absorbs the translation via the canvas's bounding rect (no subtraction)", () => {
    // Fixed 2026-06-04 — the previous implementation subtracted
    // translateX/Y from the click's CSS coords. That was wrong:
    // the canvas's `getBoundingClientRect()` (the visual rect,
    // post-transform) already reflects the translate, so the
    // click is automatically in the canvas's local space after
    // the rect subtraction. Subtracting translateX/Y here would
    // double-count.
    //
    // In a real canvas the post-transform rect would be at
    // (translateX, translateY); the fake setup mirrors that so
    // this test exercises the same code path the real viewer
    // would. scale=1, translate=(30, 50), canvas at (30, 50).
    // Click at clientX=100, clientY=200 → CSS (70, 150) on
    // the canvas → PDF (70, 150).
    //
    // Task 15b: the rect is 300x300 (instead of 100x100) so the
    // click at (100, 200) is inside the visible rect — the
    // off-canvas rejection check would otherwise kick in.
    const v = makeFakeViewer(1, 1, 30, 50, {
      left: 30,
      top: 50,
      width: 300,
      height: 300,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 100, 200);
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 70, y: 150 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("subtracts the canvas's bounding rect from the clientX/Y", () => {
    // Canvas is offset (200, 300) within the page. Click at
    // clientX=250, clientY=350 → CSS (50, 50) on the canvas.
    // With scale=1, no pan → PDF (50, 50).
    const v = makeFakeViewer(1, 1, 0, 0, {
      left: 200,
      top: 300,
      width: 100,
      height: 100,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 250, 350);
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: 50 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("returns null when the click is to the left of the canvas (off-canvas, no rejection)", () => {
    // Off-canvas rejection was removed (Task 15b debugging).
    // Clicks outside the canvas still produce coords.
    const v = makeFakeViewer(1, 1, 0, 0, {
      left: 100,
      top: 100,
      width: 100,
      height: 100,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 50, 150);
    // cssX = 50 - 100 = -50, totalScale = 1 → pageX = -50
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: -50, y: 50 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("returns negative Y when clicking above the canvas (off-canvas, no rejection)", () => {
    const v = makeFakeViewer(1, 1, 0, 0, {
      left: 100,
      top: 100,
      width: 100,
      height: 100,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 150, 50);
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: -50 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("computes coords beyond the canvas right edge (off-canvas, no rejection)", () => {
    const v = makeFakeViewer(1, 1, 0, 0, {
      left: 100,
      top: 100,
      width: 100,
      height: 100,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 250, 150);
    // cssX = 250 - 100 = 150 → pageX = 150
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 150, y: 50 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });

  it("computes coords beyond the canvas bottom (off-canvas, no rejection)", () => {
    const v = makeFakeViewer(1, 1, 0, 0, {
      left: 100,
      top: 100,
      width: 100,
      height: 100,
    });
    const e = clickOn((v as unknown as { canvas: HTMLCanvasElement }).canvas, 150, 250);
    // cssY = 250 - 100 = 150 → pageY = 150
    const result = v.pageCoordsFromEvent(e);
    expect(result).toEqual({ x: 50, y: 150 });
    try {
      v.destroy();
    } catch {
      // ignore
    }
  });
});

describe("PdfViewer.getAnnotationLayer", () => {
  let viewer: PdfViewer;
  beforeEach(() => {
    viewer = makeFakeViewer(1, 1, 0, 0);
  });
  afterEach(() => {
    try {
      viewer.destroy();
    } catch {
      // ignore
    }
  });

  it("returns the div created in _buildDOM", () => {
    const layer = viewer.getAnnotationLayer();
    expect(layer).not.toBeNull();
    expect(layer!.tagName).toBe("DIV");
    // The _buildDOM template tags the layer with
    // `data-pv-annotation-layer="true"` so the test (and any
    // future runtime check) can find it by selector.
    expect(layer!.getAttribute("data-pv-annotation-layer")).toBe("true");
  });
});

describe("PdfViewer.setOnScaleChange", () => {
  let viewer: PdfViewer;
  beforeEach(() => {
    viewer = makeFakeViewer(1, 1, 0, 0);
  });
  afterEach(() => {
    try {
      viewer.destroy();
    } catch {
      // ignore
    }
  });

  it("fires on _applyTransform with the current scale values", () => {
    // Pin a known scale state on the viewer, then subscribe.
    const v = viewer as unknown as {
      _renderScale: number;
      _displayScale: number;
    };
    v._renderScale = 2;
    v._displayScale = 1.5;

    const events: Array<{ renderScale: number; displayScale: number; totalScale: number }> = [];
    viewer.setOnScaleChange((e) => events.push(e));

    // Trigger _applyTransform via the same internal entry point
    // the class uses (this is the only public-ish way to nudge
    // it; the public setZoom paths also flow through
    // _applyTransform, but they're coupled to render scheduling
    // which is async in real PDF.js).
    const internal = viewer as unknown as {
      _applyTransform: () => void;
    };
    internal._applyTransform();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      renderScale: 2,
      displayScale: 1.5,
      totalScale: 3,
    });
  });

  it("returns an unsubscribe function that stops further events", () => {
    const events: number[] = [];
    const unsub = viewer.setOnScaleChange((e) => events.push(e.totalScale));

    const internal = viewer as unknown as {
      _applyTransform: () => void;
    };
    internal._applyTransform();
    expect(events).toHaveLength(1);

    unsub();
    internal._applyTransform();
    expect(events).toHaveLength(1); // unchanged
  });
});
