// apps/documents/src/sheetData/sheetLinks.ts
//
// Resolve a sheet link's target to a PDF of the same building.
//
// Bundle sheets are stored as `<number> - <name>.pdf` (the importer's naming,
// possibly with " (2)" for colliding names). Filename matching is EXACT (case
// sensitive, the importer's sanitising), and when the candidate PDF's embedded
// payload is readable its own sheetNumber decides, so sheet numbers that
// contain " - " or differ only in case never collide.

import type { SheetLink } from "./sheetPayload";

export interface SheetPdfRef {
  pdfFileId: string;
  name: string;
  /** Latest version id of the PDF. */
  versionId: string;
}

const MAX_NAME_PART = 80;

/** Same sanitising as the bundle importer's PDF naming. */
export function sanitizeNamePart(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").trim().replace(/[. ]+$/, "");
  return cleaned.slice(0, MAX_NAME_PART).trim();
}

/** PDFs whose NAME starts with exactly `<number> - ` or is `<number>.pdf`. */
export function exactNumberCandidates(
  sheetNumber: string | null | undefined,
  pdfs: readonly SheetPdfRef[],
): SheetPdfRef[] {
  if (!sheetNumber || !sheetNumber.trim()) return [];
  const n = sanitizeNamePart(sheetNumber);
  if (!n) return [];
  return pdfs.filter((p) => p.name === `${n}.pdf` || p.name.startsWith(`${n} - `));
}

/** Filename-only resolution (exact): the first exact candidate. */
export function findSheetPdf(
  sheetNumber: string | null | undefined,
  pdfs: readonly SheetPdfRef[],
): SheetPdfRef | null {
  return exactNumberCandidates(sheetNumber, pdfs)[0] ?? null;
}

/**
 * Reads a PDF version's embedded sheet number: the string, `null` when the PDF
 * has no sheet data (a plain PDF), `undefined` when it could not be read.
 */
export type SheetNumberReader = (versionId: string) => Promise<string | null | undefined>;

/**
 * Resolve by sheet number. Candidates are the exact filename matches; a
 * candidate whose embedded sheetNumber equals the target wins, one whose
 * embedded number is different is rejected, and candidates with no readable
 * embedded number are used only as a fallback (first exact filename match).
 */
export async function resolveSheetPdf(
  sheetNumber: string | null | undefined,
  pdfs: readonly SheetPdfRef[],
  readSheetNumber: SheetNumberReader,
): Promise<SheetPdfRef | null> {
  let fallback: SheetPdfRef | null = null;
  for (const c of exactNumberCandidates(sheetNumber, pdfs)) {
    const embedded = await readSheetNumber(c.versionId);
    if (embedded === sheetNumber) return c;
    if (typeof embedded === "string" && embedded !== "") continue; // another sheet's PDF
    fallback ??= c;
  }
  return fallback;
}

/** A link is navigable when it names a target sheet at all. */
export function isNavigableLink(link: SheetLink): boolean {
  return link.targetIncluded !== false && !!(link.targetSheetNumber && link.targetSheetNumber.trim());
}

/** Hint shown for a link whose target sheet is not part of the bundle. */
export function notIncludedHint(link: SheetLink): string {
  const n = link.targetSheetNumber?.trim();
  return n ? `Sheet ${n} is not in the bundle.` : "The linked sheet is not in the bundle.";
}

export function resolveLinkTarget(
  link: SheetLink,
  pdfs: readonly SheetPdfRef[],
): SheetPdfRef | null {
  return isNavigableLink(link) ? findSheetPdf(link.targetSheetNumber, pdfs) : null;
}
