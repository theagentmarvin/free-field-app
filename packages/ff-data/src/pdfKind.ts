// packages/ff-data/src/pdfKind.ts
//
// Two kinds of PDF (2026-11-16):
//   - "plan"     — single page. Mappable with the 2-point calibration,
//                  so it drives LinkView, plan measuring in metres and
//                  plan task pins.
//   - "document" — multi-page. Read, measure, outline; never mappable.
// The kind is derived from the LATEST version's page count, so no
// schema change. A mapped plan refuses a multi-page new version
// (MappedPlanMultiPageError) — it would orphan its mapping.

export type PdfKind = "plan" | "document";

export function pdfKindOf(
  version: { pageCount?: number | null } | null | undefined,
): PdfKind {
  return (version?.pageCount ?? 1) > 1 ? "document" : "plan";
}

export function isMappablePdf(
  version: { pageCount?: number | null } | null | undefined,
): boolean {
  return pdfKindOf(version) === "plan";
}

export class MappedPlanMultiPageError extends Error {
  readonly pageCount: number;
  constructor(fileName: string, pageCount: number) {
    super(
      `"${fileName}" is a mapped plan, so a new version must be a single page ` +
        `(this file has ${pageCount} pages). Upload it under a different name ` +
        `to keep it as a document.`,
    );
    this.name = "MappedPlanMultiPageError";
    this.pageCount = pageCount;
  }
}
