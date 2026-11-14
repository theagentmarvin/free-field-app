// apps/models/__tests__/flattenItemData.test.ts
//
// Task 22 — focused unit test for the new flattening path in
// IfcViewer's `getElementData`. The flattening turns the nested
// IsDefinedBy array (from `FragmentsModel.getItemsData` with
// `{ relations: { IsDefinedBy: { attributes: true, relations:
// false } } }`) into the flat `Record<string, string>` shape
// `PropertiesDrawer` parses with `key.indexOf(".")`.
//
// We import `flattenItemData` from the STANDALONE module
// (`@ff/viewer-react/src/flattenItemData`) instead of the public
// barrel (`@ff/viewer-react`). The barrel re-exports `IfcViewer`
// from the same package, and IfcViewer.tsx transitively loads
// `three`'s webgpu build at module init, which crashes in jsdom
// (`Cannot read properties of undefined (reading 'VERTEX')`).
// Importing from the standalone module pulls ONLY the pure
// helper, no React/Three/OBC. The barrel still re-exports
// `flattenItemData` for normal consumers.
//
// This matches the "focused unit test" spirit in the spec and
// keeps the test fast (~5ms) and dependency-light.
//
// ── Fixture shape (important) ────────────────────────────────
// `FragmentsModel.getItemsData()` returns IsDefinedBy as an array
// of RELATED-ENTITY objects. Each entry carries the pset's own
// attributes (`Name` = "Pset_Foundation", …) and the property
// VALUES live under `HasProperties` — an array of
// IfcPropertySingleValue entities with `Name` + `NominalValue`.
// That is the shape `flattenItemData` walks (verified empirically
// against TOE on 2026-06-23, see commit 8fdd0a6 "fix(react):
// restore correct IsDefinedBy walker in flattenItemData").
//
// The fixtures below therefore use
// `{ Name: { value: "Pset_X" }, HasProperties: [{ Name: { value:
// "Prop" }, NominalValue: { value: … } }] }` — NOT the older
// `{ Pset_X: { Prop: { value: … } } }` shape, which TOE never
// produces.

import { describe, expect, it } from "vitest";

// Direct module import — bypass the barrel to avoid the
// IfcViewer.tsx → three.webgpu module-load chain.
import {
  flattenItemData,
  type IfcItemData,
} from "../../../packages/ff-viewer-react/src/flattenItemData";

describe("flattenItemData (Task 22 — getElementData IsDefinedBy path)", () => {
  it("flattens a single IsDefinedBy pset into Pset.Prop = value keys", () => {
    const input: IfcItemData = {
      Name: { value: "Foo", type: "IfcLabel" },
      GlobalId: { value: "abc-123", type: "IfcGloballyUniqueId" },
      IsDefinedBy: [
        {
          Name: { value: "Pset_Foundation" },
          HasProperties: [
            {
              Name: { value: "01-nivel constructivo" },
              NominalValue: { value: "Subterráneo", type: "IfcLabel" },
            },
          ],
        },
      ],
    };
    const out = flattenItemData(input);
    // The user's reported pset property surfaces.
    expect(out["Pset_Foundation.01-nivel constructivo"]).toBe(
      "Subterráneo",
    );
    // Top-level attributes still surface.
    expect(out["Name"]).toBe("Foo");
    expect(out["GlobalId"]).toBe("abc-123");
  });

  it("flattens multiple IsDefinedBy psets", () => {
    const input: IfcItemData = {
      Name: { value: "Wall-1" },
      IsDefinedBy: [
        {
          Name: { value: "Pset_WallCommon" },
          HasProperties: [
            {
              Name: { value: "IsExternal" },
              NominalValue: { value: true, type: "IfcBoolean" },
            },
            {
              Name: { value: "ThermalTransmittance" },
              NominalValue: { value: 0.35, type: "IfcReal" },
            },
          ],
        },
        {
          Name: { value: "Pset_Manufacturer" },
          HasProperties: [
            {
              Name: { value: "Manufacturer" },
              NominalValue: { value: "ACME Corp" },
            },
          ],
        },
      ],
    };
    const out = flattenItemData(input);
    expect(out["Pset_WallCommon.IsExternal"]).toBe("true");
    expect(out["Pset_WallCommon.ThermalTransmittance"]).toBe("0.35");
    expect(out["Pset_Manufacturer.Manufacturer"]).toBe("ACME Corp");
  });

  it("coerces null/undefined values to empty string", () => {
    const input: IfcItemData = {
      Name: { value: null },
      IsDefinedBy: [
        {
          Name: { value: "Pset_X" },
          HasProperties: [
            {
              Name: { value: "EmptyProp" },
              NominalValue: { value: null },
            },
            {
              Name: { value: "UndefProp" },
              NominalValue: { value: undefined },
            },
            {
              Name: { value: "RealProp" },
              NominalValue: { value: "value-here" },
            },
          ],
        },
      ],
    };
    const out = flattenItemData(input);
    expect(out["Name"]).toBe("");
    expect(out["Pset_X.EmptyProp"]).toBe("");
    expect(out["Pset_X.UndefProp"]).toBe("");
    expect(out["Pset_X.RealProp"]).toBe("value-here");
  });

  it("handles elements with no IsDefinedBy (regression — original behavior)", () => {
    const input: IfcItemData = {
      Name: { value: "PlainWall" },
      GlobalId: { value: "xyz" },
      Tag: { value: "W-1" },
    };
    const out = flattenItemData(input);
    expect(out).toEqual({
      Name: "PlainWall",
      GlobalId: "xyz",
      Tag: "W-1",
    });
  });

  it("handles empty IsDefinedBy array", () => {
    const input: IfcItemData = {
      Name: { value: "NoPsets" },
      IsDefinedBy: [],
    };
    const out = flattenItemData(input);
    expect(out).toEqual({ Name: "NoPsets" });
  });

  it("stringifies non-IsDefinedBy nested arrays (materials etc.)", () => {
    const input: IfcItemData = {
      Name: { value: "Slab-1" },
      Materials: [
        { value: { name: "Concrete" } },
        { value: { name: "Steel" } },
      ] as unknown as IfcItemData[string],
    };
    const out = flattenItemData(input);
    expect(out["Name"]).toBe("Slab-1");
    expect(out["Materials"]).toContain("Concrete");
    expect(out["Materials"]).toContain("Steel");
  });

  it("skips malformed IsDefinedBy entries (non-object) without throwing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badEntries = [null, undefined, "string-not-object", 42] as any;
    const input: IfcItemData = {
      Name: { value: "X" },
      IsDefinedBy: [
        ...badEntries,
        {
          Name: { value: "Pset_Valid" },
          HasProperties: [
            {
              Name: { value: "GoodProp" },
              NominalValue: { value: "good" },
            },
          ],
        },
      ],
    };
    const out = flattenItemData(input);
    expect(out["Name"]).toBe("X");
    expect(out["Pset_Valid.GoodProp"]).toBe("good");
  });

  it("mirrors the TOE `_category` key into the synthetic `_IfcClass` key (Wave 48)", () => {
    // `FragmentsModel.getItemData()` returns the IFC entity class under
    // `_category` (uppercase), NOT `_IfcClass`. The context toolbar and the
    // custom-filter evaluator read `_IfcClass`, so flattenItemData emits it.
    const input: IfcItemData = {
      Name: { value: "Wall-1" },
      _category: { value: "IFCWALL" },
      _localId: { value: 465474 },
      _guid: { value: "abc-123" },
      IsDefinedBy: [
        {
          Name: { value: "Pset_WallCommon" },
          HasProperties: [
            { Name: { value: "FireRating" }, NominalValue: { value: "2HR" } },
          ],
        },
      ],
    };
    const out = flattenItemData(input);
    expect(out["_category"]).toBe("IFCWALL");
    expect(out["_IfcClass"]).toBe("IFCWALL");
    expect(out["Pset_WallCommon.FireRating"]).toBe("2HR");
  });

  it("does not emit `_IfcClass` when there is no `_category`", () => {
    const input: IfcItemData = { Name: { value: "PlainWall" } };
    const out = flattenItemData(input);
    expect(out["_IfcClass"]).toBeUndefined();
    expect(out["_category"]).toBeUndefined();
  });
});
