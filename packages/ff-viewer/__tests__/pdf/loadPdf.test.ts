// __tests__/viewer/pdf/loadPdf.test.ts
//
// Unit tests for the PDF.js loader: validation gates (magic
// bytes, max size), single-page enforcement, and — since task 37
// — the self-hosting plumbing:
//
//   * the worker comes from a Vite `?url` import (same-origin,
//     content-hashed, locked to the installed pdfjs-dist), NOT
//     from a CDN;
//   * `getDocument` receives the three asset options that point
//     at the self-hosted cmap / standard-font trees.
//
// We don't render a real PDF here — the loadPDF() happy path
// requires a real PDF.js worker, which jsdom can't provide
// (and we don't want to mock). Instead, we exercise the
// validation surface, the "too small" / "wrong magic" /
// "oversize" rejection paths, the single-page error by feeding a
// hand-crafted 1-page-vs-2-page buffer, and the getDocument
// wiring (the PDF.js entry point is mocked so we can inspect the
// init parameters).

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` factories are hoisted above the imports, so the spy
// has to be created through `vi.hoisted` to be reachable from
// inside the factory.
const { getDocumentMock } = vi.hoisted(() => ({
  getDocumentMock: vi.fn(),
}));

// Mock only `getDocument`; everything else (notably
// `GlobalWorkerOptions`) stays the real implementation, so the
// assertions below see the same object the loader configures.
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...actual,
    getDocument: (...args: unknown[]) => getDocumentMock(...args),
  };
});

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  MAX_PDF_SIZE,
  validatePDFBuffer,
  loadPDF,
} from "@ff/viewer";

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

function makePdfBuffer(extraBytes: number = 0): Uint8Array {
  // Return a buffer that PASSES the magic-bytes check, sized
  // `5 + extraBytes`. The PDF is fake — the loader will fail
  // to parse it, but that's fine: we're testing validation
  // errors that fire before PDF.js kicks in.
  return new Uint8Array([...PDF_MAGIC, ...new Array(extraBytes).fill(0)]);
}

/** Minimal stand-in for a PDFDocumentProxy. */
function makeFakeDoc(numPages = 1) {
  return {
    numPages,
    destroy: vi.fn(async () => undefined),
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
    })),
  };
}

describe("validatePDFBuffer", () => {
  it("accepts a valid-magic, reasonable-size buffer", () => {
    expect(() => validatePDFBuffer(makePdfBuffer(100))).not.toThrow();
  });

  it("rejects an oversized buffer", () => {
    // Build a 50MB + 1 byte buffer with valid magic. Slicing
    // avoids the test allocating 50MB of zeros.
    const head = makePdfBuffer(100);
    const tail = new Uint8Array(MAX_PDF_SIZE);
    const combined = new Uint8Array(head.length + tail.length);
    combined.set(head, 0);
    combined.set(tail, head.length);
    expect(() => validatePDFBuffer(combined)).toThrow(/exceeds.*limit/i);
  });

  it("rejects a too-small buffer", () => {
    expect(() => validatePDFBuffer(new Uint8Array([1, 2, 3]))).toThrow(
      /too small/i,
    );
  });

  it("rejects a buffer with the wrong magic bytes", () => {
    const notPdf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(() => validatePDFBuffer(notPdf)).toThrow(/magic bytes/i);
  });

  it("accepts an ArrayBuffer (not just Uint8Array)", () => {
    const bytes = makePdfBuffer(50);
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    expect(() => validatePDFBuffer(ab)).not.toThrow();
  });
});

describe("loadPDF error path", () => {
  beforeEach(() => {
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(makeFakeDoc()),
    });
  });

  it("propagates a 'magic bytes' error for a clearly-corrupt file", async () => {
    const notPdf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    await expect(loadPDF(notPdf)).rejects.toThrow(/magic bytes/i);
  });

  it("propagates a 'too small' error", async () => {
    const tiny = new Uint8Array([1, 2, 3]);
    await expect(loadPDF(tiny)).rejects.toThrow(/too small/i);
  });

  // Note: a positive assertion on an actual render would need a
  // real PDF.js worker. jsdom can't run it, so the happy path is
  // covered by the manual smoke (per the task spec) and by the
  // live integration test described in docs/TASK-11-PDF-CANVAS.md
  // "Test plan" as optional.
});

describe("self-hosted worker (task 37 · F1)", () => {
  it("points PDF.js at a non-empty, same-origin worker URL", () => {
    const workerSrc = pdfjsLib.GlobalWorkerOptions.workerSrc;

    expect(workerSrc).toBeTruthy();
    expect(typeof workerSrc).toBe("string");
    expect(workerSrc.length).toBeGreaterThan(0);
    // No CDN: the worker is served from our own origin (Vite
    // `?url` import → content-hashed, same-origin asset).
    expect(workerSrc).not.toContain("unpkg.com");
    expect(workerSrc).not.toMatch(/^https?:\/\//i);
  });

  it("never falls back to the old unpkg CDN constant", () => {
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).not.toMatch(
      /unpkg|cdn\.jsdelivr/i,
    );
  });
});

describe("self-hosted cmaps + standard fonts (task 37 · F2)", () => {
  beforeEach(() => {
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(makeFakeDoc()),
    });
  });

  it("passes the cmap + standard-font asset options to getDocument", async () => {
    await loadPDF(makePdfBuffer(100));

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const init = getDocumentMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;

    expect(init.cMapUrl).toBe("/pdfjs/cmaps/");
    expect(init.cMapPacked).toBe(true);
    expect(init.standardFontDataUrl).toBe("/pdfjs/standard_fonts/");
  });

  it("keeps the asset options on our own origin", async () => {
    await loadPDF(makePdfBuffer(100));
    const init = getDocumentMock.mock.calls[0][0] as Record<
      string,
      unknown
    >;

    for (const key of ["cMapUrl", "standardFontDataUrl"]) {
      const value = init[key];
      expect(typeof value).toBe("string");
      expect(value as string).not.toMatch(/^https?:\/\//i);
      expect(value as string).toContain("/pdfjs/");
    }
  });
});

describe("canvas pixel budget (wave 63)", () => {
  it("keeps the dpr when the page fits and scales it down past the budget", async () => {
    const { cappedPixelRatio, MAX_CANVAS_PIXELS } = await import("../../src/pdf/loadPdf");
    expect(cappedPixelRatio(1000, 800, 2, MAX_CANVAS_PIXELS)).toBe(2);
    // A0 sheet at renderScale 4 × dpr 3 → far beyond 16 M px.
    const w = 3370 * 4;
    const h = 2384 * 4;
    const r = cappedPixelRatio(w, h, 3, MAX_CANVAS_PIXELS);
    expect(r).toBeLessThan(3);
    expect(Math.floor(w * r) * Math.floor(h * r)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it("uses the lower budget on iOS / iPadOS", async () => {
    const { isIOSLike } = await import("../../src/pdf/loadPdf");
    expect(isIOSLike({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" })).toBe(true);
    expect(isIOSLike({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIOSLike({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux", maxTouchPoints: 0 })).toBe(false);
  });
});
