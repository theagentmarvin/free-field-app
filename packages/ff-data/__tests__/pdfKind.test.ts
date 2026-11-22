import { describe, expect, it } from "vitest";

import { isMappablePdf, MappedPlanMultiPageError, pdfKindOf } from "../src/pdfKind";

describe("pdfKind", () => {
  it("single page = plan (mappable); multi-page = document (not mappable)", () => {
    expect(pdfKindOf({ pageCount: 1 })).toBe("plan");
    expect(pdfKindOf({ pageCount: 3 })).toBe("document");
    expect(isMappablePdf({ pageCount: 1 })).toBe(true);
    expect(isMappablePdf({ pageCount: 2 })).toBe(false);
  });
  it("a missing version or page count counts as a plan (legacy rows)", () => {
    expect(pdfKindOf(null)).toBe("plan");
    expect(pdfKindOf({ pageCount: null })).toBe("plan");
  });
  it("the mapped-plan error names the file and page count", () => {
    const e = new MappedPlanMultiPageError("S-101.pdf", 4);
    expect(e.message).toMatch(/S-101\.pdf.*mapped plan.*4 pages/);
  });
});
