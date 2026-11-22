import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { BundleFormatError, parseBundle } from "../../src/bundle/parseBundle";
import { buildSyntheticBundle } from "./fixtures/syntheticBundle";

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: "uint8array" });
}

describe("parseBundle", () => {
  it("reads manifest and lists entries of a valid bundle", async () => {
    const { bytes } = await buildSyntheticBundle();
    const b = await parseBundle(bytes);
    expect(b.manifest.schema).toBe("freefield.bundle/1");
    expect(b.manifest.sheets.map((s) => s.number)).toEqual(["A101", "A201"]);
    expect(b.entries).toContain("models/arch.ifc");
    expect(b.has("sheets/A101.pdf")).toBe(true);
    const pdf = await b.readBytes("sheets/A101.pdf");
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(await b.readText("manifest.json")).toContain("freefield.bundle/1");
  });

  it("rejects an archive without a manifest", async () => {
    await expect(parseBundle(await zipOf({ "a.txt": "x" }))).rejects.toThrow(/manifest.json is missing/);
  });

  it("rejects a non-zip", async () => {
    await expect(parseBundle(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(BundleFormatError);
  });

  it("rejects an unsupported schema id", async () => {
    const z = await zipOf({ "manifest.json": JSON.stringify({ schema: "other/9" }) });
    await expect(parseBundle(z)).rejects.toThrow(/Unsupported bundle schema "other\/9"/);
  });

  it("rejects an invalid manifest shape", async () => {
    const z = await zipOf({
      "manifest.json": JSON.stringify({ schema: "freefield.bundle/1", project: {}, models: [], sheets: [] }),
    });
    await expect(parseBundle(z)).rejects.toThrow(/Invalid bundle manifest/);
  });

  it("rejects malformed JSON", async () => {
    await expect(parseBundle(await zipOf({ "manifest.json": "{nope" }))).rejects.toThrow(/not valid JSON/);
  });

  it("reports a missing entry on read", async () => {
    const { bytes } = await buildSyntheticBundle();
    const b = await parseBundle(bytes);
    await expect(b.readBytes("sheets/none.pdf")).rejects.toThrow(/not found/);
  });
});
