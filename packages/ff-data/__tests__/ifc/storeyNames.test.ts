// __tests__/ifc/storeyNames.test.ts — duplicate storey names (wave 63
// review item 2): unique per file at extraction, against the real
// web-ifc parse of a sample IFC whose storeys were all renamed alike.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { disambiguateStoreyNames } from "../../src/ifc/storeyNames";
import { parseIfc } from "../../src/ifc/ifcMetadata";

describe("disambiguateStoreyNames", () => {
  it("keeps the first, suffixes later duplicates, skips suffixes already taken", () => {
    const out = disambiguateStoreyNames([
      { name: "A" }, { name: "A" }, { name: "A (2)" }, { name: "B" }, { name: "A" },
    ]);
    expect(out.map((s) => s.name)).toEqual(["A", "A (3)", "A (2)", "B", "A (4)"]);
  });
  it("returns unique names and does not mutate the input", () => {
    const input = [{ name: "X" }, { name: "X" }];
    const out = disambiguateStoreyNames(input);
    expect(input.map((s) => s.name)).toEqual(["X", "X"]);
    expect(new Set(out.map((s) => s.name)).size).toBe(2);
  });
});

describe("extraction", () => {
  it("an IFC with every storey named 'Level 1' yields unique storey names", async () => {
    const text = readFileSync(
      resolve(__dirname, "../../../../apps/settings/public/samples/sample.ifc"),
      "latin1",
    ).replace(/(IFCBUILDINGSTOREY\('[^']*',#\d+,)'[^']*'/g, "$1'Level 1'");
    const parsed = await parseIfc(new Uint8Array(Buffer.from(text, "latin1")));
    const names = parsed.storeys.map((s) => s.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names[0]).toBe("Level 1");
    expect(new Set(names).size).toBe(names.length);
    expect(names[1]).toBe("Level 1 (2)");
  });
});
