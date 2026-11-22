import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  assertSafeArchive,
  BundleFormatError,
  MAX_BUNDLE_ENTRIES,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  parseBundle,
} from "../../src/bundle/parseBundle";
import { buildSyntheticBundle } from "./fixtures/syntheticBundle";

const MANIFEST = JSON.stringify({ schema: "freefield.bundle/1" });

/** Fake just enough of a JSZip for assertSafeArchive (declared sizes only). */
function fakeZip(entries: Array<{ name: string; un: number; co: number }>): JSZip {
  const files: Record<string, unknown> = {};
  for (const e of entries) {
    files[e.name] = { name: e.name, dir: false, _data: { uncompressedSize: e.un, compressedSize: e.co } };
  }
  return { files } as unknown as JSZip;
}

describe("parseBundle untrusted-input limits", () => {
  it("still opens a normal bundle", async () => {
    const { bytes } = await buildSyntheticBundle();
    await expect(parseBundle(bytes)).resolves.toBeTruthy();
  });

  it("rejects an archive with more than MAX_BUNDLE_ENTRIES entries", async () => {
    const z = new JSZip();
    z.file("manifest.json", MANIFEST);
    for (let i = 0; i < MAX_BUNDLE_ENTRIES + 1; i++) z.file(`f/${i}.txt`, "x");
    const bytes = await z.generateAsync({ type: "uint8array" });
    const err = await parseBundle(bytes).catch((e) => e);
    expect(err).toBeInstanceOf(BundleFormatError);
    expect(String(err.message)).toMatch(/too many files/);
  });

  it("rejects a high-ratio entry (decompression bomb) before inflating it", async () => {
    const z = new JSZip();
    z.file("manifest.json", MANIFEST);
    z.file("models/bomb.ifc", new Uint8Array(12 * 1024 * 1024), {
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const bytes = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.byteLength).toBeLessThan(200 * 1024); // genuinely > 100:1
    const err = await parseBundle(bytes).catch((e) => e);
    expect(err).toBeInstanceOf(BundleFormatError);
    expect(String(err.message)).toMatch(/compression ratio/);
  });

  it("does not apply the ratio check to small, highly-compressible entries", async () => {
    const z = new JSZip();
    z.file("manifest.json", MANIFEST);
    z.file("notes.txt", new Uint8Array(1024 * 1024), { compression: "DEFLATE" });
    const bytes = await z.generateAsync({ type: "uint8array" });
    // Passes the archive guard; fails later only on manifest content.
    const err = await parseBundle(bytes).catch((e) => e);
    expect(String(err.message)).not.toMatch(/ratio|too many|too large/);
  });

  it("rejects an entry whose declared size exceeds the per-entry limit", () => {
    const zip = fakeZip([{ name: "a.ifc", un: MAX_ENTRY_UNCOMPRESSED_BYTES + 1, co: MAX_ENTRY_UNCOMPRESSED_BYTES }]);
    expect(() => assertSafeArchive(zip)).toThrow(/too large to import/);
  });

  it("rejects when declared sizes sum past the total limit", () => {
    const each = MAX_ENTRY_UNCOMPRESSED_BYTES;
    const n = Math.ceil(MAX_TOTAL_UNCOMPRESSED_BYTES / each) + 1;
    const zip = fakeZip(Array.from({ length: n }, (_, i) => ({ name: `m${i}.ifc`, un: each, co: each })));
    expect(() => assertSafeArchive(zip)).toThrow(/expands to more than/);
  });

  it("accepts a large but well-compressed IFC at the ratio boundary", () => {
    expect(() => assertSafeArchive(fakeZip([{ name: "big.ifc", un: 600 * 1048576, co: 6 * 1048576 }]))).not.toThrow();
  });
});
