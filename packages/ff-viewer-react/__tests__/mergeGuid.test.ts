import { describe, expect, it } from "vitest";
import {
  flattenItemData,
  getPropertyGroups,
  mergeGuidIntoAttributes,
} from "../src/flattenItemData";

describe("mergeGuidIntoAttributes", () => {
  it("adds GlobalId when the record has none", () => {
    const out = mergeGuidIntoAttributes({ Name: "Wall" }, "2O2Fr$t4X7Zf8NOew3FLOH");
    expect(out.globalId).toBe("2O2Fr$t4X7Zf8NOew3FLOH");
    expect(out.attributes).toEqual({ Name: "Wall", GlobalId: "2O2Fr$t4X7Zf8NOew3FLOH" });
  });

  it("never overrides an existing GlobalId and does not mutate the input", () => {
    const input = { GlobalId: "AAA", Name: "x" };
    const out = mergeGuidIntoAttributes(input, "BBB");
    expect(out.globalId).toBe("AAA");
    expect(out.attributes.GlobalId).toBe("AAA");
    expect(input).toEqual({ GlobalId: "AAA", Name: "x" });
  });

  it("leaves the record alone when the model has no guid", () => {
    const out = mergeGuidIntoAttributes({ Name: "x" }, null);
    expect(out).toEqual({ attributes: { Name: "x" }, globalId: null });
  });

  it("carries the pset grouping symbol over to the copy", () => {
    const flat = flattenItemData({
      Name: { value: "Wall" },
      IsDefinedBy: [
        { Name: { value: "Pset_A" }, HasProperties: [{ Name: { value: "P" }, NominalValue: { value: "1" } }] },
      ],
    } as never);
    const before = getPropertyGroups(flat);
    const out = mergeGuidIntoAttributes(flat, "G");
    expect(getPropertyGroups(out.attributes)).toEqual(before);
    expect(Object.keys(out.attributes)).toContain("GlobalId");
  });
});
