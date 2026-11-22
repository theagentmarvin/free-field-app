// @vitest-environment node
// Wave 64 — multi-page PDFs through the REAL PDF.js parser.
//
// `loadPDF` imports the browser build of pdfjs-dist (worker via a Vite
// `?url` import), which Node cannot host. `getDocument` is routed to
// the legacy build instead, which parses in-process (fake worker), so
// the hand-written 2-page fixture is genuinely parsed here.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return {
    ...actual,
    getDocument: (params: { data: ArrayBuffer }) => {
      // loadPdf points workerSrc at a Vite `?url`; Node's in-process "fake
      // worker" needs the real file URL of the legacy worker instead.
      actual.GlobalWorkerOptions.workerSrc = pathToFileURL(
        createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
      ).href;
      return actual.getDocument({ data: new Uint8Array(params.data) });
    },
  };
});

import { loadPDF } from "@ff/viewer";
import { TWO_PAGE_SIZES, makeTestPdf } from "./fixtures/makeTestPdf";

describe("loadPDF with a real 2-page PDF (wave 64)", () => {
  it("opens both pages with singlePage:false and reports page 1's size", async () => {
    const api = await loadPDF(makeTestPdf(TWO_PAGE_SIZES), { singlePage: false });
    try {
      expect(api.numPages).toBe(2);
      expect(api.width).toBe(612);
      expect(api.height).toBe(792);
      const p2 = await api.doc.getPage(2);
      const vp = p2.getViewport({ scale: 1 });
      expect([vp.width, vp.height]).toEqual([792, 612]);
    } finally {
      api.destroy();
    }
  });

  it("still rejects it under the strict single-page default", async () => {
    await expect(loadPDF(makeTestPdf(TWO_PAGE_SIZES))).rejects.toThrow(
      /single page.*2 pages/,
    );
  });

  it("parses a 1-page fixture under the default", async () => {
    const api = await loadPDF(makeTestPdf([[612, 792]]));
    expect(api.numPages).toBe(1);
    api.destroy();
  });
});
