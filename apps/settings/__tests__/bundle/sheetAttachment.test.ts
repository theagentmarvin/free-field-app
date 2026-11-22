// The sheet payload survives the real path: hand-built PDF with an embedded
// file -> pdf.js getAttachments() -> readSheetPayload (Documents module).
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { readSheetPayload } from "../../../documents/src/sheetData/sheetPayload";
import { buildSyntheticBundle, WALLS } from "./fixtures/syntheticBundle";

async function pdfFrom(bytes: Uint8Array, path: string) {
  const zip = await JSZip.loadAsync(bytes);
  const pdf = await zip.file(path)!.async("uint8array");
  return pdfjs.getDocument({ data: pdf, useWorkerFetch: false } as Parameters<typeof pdfjs.getDocument>[0]).promise;
}

describe("embedded sheet payload via pdf.js", () => {
  it("reads freefield-sheet.json from the plan PDF", async () => {
    const { bytes, elementBoxes } = await buildSyntheticBundle({ rotationRad: 0.4 });
    const doc = await pdfFrom(bytes, "sheets/A101.pdf");
    const payload = await readSheetPayload(doc);
    expect(payload?.sheetNumber).toBe("A101");
    expect(payload?.elements.map((e) => e.gid)).toEqual(WALLS.map((w) => w.gid));
    expect(payload?.elements[0]!.bbox[0]).toBeCloseTo(elementBoxes[WALLS[0]!.gid]![0], 6);
    expect(payload?.elementRecords[WALLS[0]!.gid]!.category).toBe("Walls");
    expect(payload?.links.find((l) => l.targetSheetNumber === "A201")).toBeTruthy();
    await doc.loadingTask.destroy();
  });

  it("returns null for a PDF without the attachment", async () => {
    const { bytes } = await buildSyntheticBundle({ attach: false });
    const doc = await pdfFrom(bytes, "sheets/A101.pdf");
    expect(await readSheetPayload(doc)).toBeNull();
    await doc.loadingTask.destroy();
  });
});
