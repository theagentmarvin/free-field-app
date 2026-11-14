// Wave 63: PropertiesDrawer grouping must not split pset / property
// names on the first ".".
import { describe, expect, it } from "vitest";

import { flattenItemData } from "@ff/viewer-react";
import { groupElementProperties } from "../../src/components/groupElementProperties";

const prop = (name: string, value: string) => ({
  Name: { value: name },
  NominalValue: { value },
});

describe("groupElementProperties", () => {
  it("keeps dotted pset and property names intact", () => {
    const flat = flattenItemData({
      Name: { value: "Wall 1" },
      IsDefinedBy: [
        {
          Name: { value: "Pset 1.2" },
          HasProperties: [prop("FireRating", "2HR"), prop("Load.Bearing", "yes")],
        },
      ],
    } as never);
    const grouped = groupElementProperties(flat);
    expect(grouped.get("IFC Entity")).toEqual([["Name", "Wall 1"]]);
    expect(grouped.get("Pset 1.2")).toEqual([
      ["FireRating", "2HR"],
      ["Load.Bearing", "yes"],
    ]);
    expect(grouped.has("Pset 1")).toBe(false);
  });

  it("falls back to the first-dot split for plain records", () => {
    const grouped = groupElementProperties({
      Name: "W",
      "Pset_WallCommon.FireRating": "1HR",
    });
    expect(grouped.get("IFC Entity")).toEqual([["Name", "W"]]);
    expect(grouped.get("Pset_WallCommon")).toEqual([["FireRating", "1HR"]]);
  });

  it("returns an empty map for no data", () => {
    expect(groupElementProperties(null).size).toBe(0);
  });
});
