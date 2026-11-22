// apps/documents/src/sheetData/loadSheetNumber.ts
//
// The embedded sheet number of a PDF version (read from its freefield-sheet.json
// attachment), parsed once per version and cached with the payload.

import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";

import {
  getCachedPayload,
  readSheetPayload,
  setCachedPayload,
} from "./sheetPayload";
import type { SheetNumberReader } from "./sheetLinks";

export const loadSheetNumber: SheetNumberReader = async (versionId) => {
  const cached = getCachedPayload(versionId);
  if (cached !== undefined) return cached ? cached.sheetNumber : null;
  try {
    const version = await getPdfVersion(versionId);
    const blob = version ? await getPdfBlob(version.blobKey) : null;
    if (!blob) return undefined;
    // lazy: pdf.js is only needed when a link target must be inspected
    const { loadPDF } = await import("@ff/viewer");
    const api = await loadPDF(new Uint8Array(await blob.arrayBuffer()), { singlePage: false });
    try {
      const payload = await readSheetPayload(api.doc);
      if (payload === undefined) return undefined; // transient: do not cache
      setCachedPayload(versionId, payload);
      return payload ? payload.sheetNumber : null;
    } finally {
      api.destroy();
    }
  } catch {
    return undefined;
  }
};
