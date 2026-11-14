// __tests__/db/pdfBlobs.test.ts
//
// Round-trip tests for the raw PDF byte store. Mirrors
// __tests__/db/fragBlobs.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import {
  putPdfBlob,
  getPdfBlob,
  deletePdfBlob,
  listPdfBlobKeys,
} from "@ff/data/db/tables/pdfBlobs";
import { resetDb } from "./helpers";

describe("pdfBlobs table", () => {
  beforeEach(async () => {
    await resetDb("pdfBlobs");
  });

  it("put + get round-trips a Blob", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
      type: "application/pdf",
    });
    await putPdfBlob("k1", blob);
    const got = await getPdfBlob("k1");
    expect(got).toBeDefined();
    expect(got?.size).toBe(5);
    const bytes = new Uint8Array(await got!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it("put overwrites an existing key", async () => {
    const a = new Blob([new Uint8Array([1])]);
    const b = new Blob([new Uint8Array([2, 2, 2])]);
    await putPdfBlob("k", a);
    await putPdfBlob("k", b);
    const got = await getPdfBlob("k");
    expect(got?.size).toBe(3);
    const bytes = new Uint8Array(await got!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([2, 2, 2]);
  });

  it("get returns undefined for unknown key", async () => {
    expect(await getPdfBlob("missing")).toBeNull();
  });

  it("delete removes the row", async () => {
    await putPdfBlob("k", new Blob([new Uint8Array([9])]));
    await deletePdfBlob("k");
    expect(await getPdfBlob("k")).toBeNull();
  });

  it("listPdfBlobKeys returns all stored keys", async () => {
    await putPdfBlob("a", new Blob([new Uint8Array([1])]));
    await putPdfBlob("b", new Blob([new Uint8Array([2])]));
    await putPdfBlob("c", new Blob([new Uint8Array([3])]));
    const keys = await listPdfBlobKeys();
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });
});
