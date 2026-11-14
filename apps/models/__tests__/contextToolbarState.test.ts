// apps/models/__tests__/contextToolbarState.test.ts
//
// Wave 48 — pure helpers for the right-click context toolbar, tested
// against REALISTIC index fixtures built the way `useModelPropertyIndex`
// builds them (`flattenItemData` → `buildInvertedIndex`), so the `_IfcClass`
// key shape is NOT hand-waved this time. Also pins the section-plane
// normal chain (face → bbox-snap → camera direction).

import { describe, expect, it } from "vitest";

import {
  findClassInIndex,
  classIdsForModel,
  computeCategoryClassMap,
  resolveCategoryClass,
  snapBboxFaceNormal,
  resolveSectionPlaneNormal,
} from "../src/contextToolbarState";
import {
  flattenItemData,
  type IfcItemData,
} from "../../../packages/ff-viewer-react/src/flattenItemData";
import {
  buildInvertedIndex,
  type InvertedIndex,
} from "../../../packages/ff-viewer-react/src/indexPropertyData";

/**
 * Build a REALISTIC inverted index the production way: TOE
 * `FragmentsModel.getItemData()` shape (`_category` carries the IFC
 * class, not `_IfcClass`) → `flattenItemData` → `buildInvertedIndex`.
 */
function realisticIndex(): InvertedIndex {
  const item = (localId: number, category: string): IfcItemData => ({
    Name: { value: `Elt-${localId}` },
    _category: { value: category },
    _localId: { value: localId },
    IsDefinedBy: [
      {
        Name: { value: "Pset_Common" },
        HasProperties: [
          { Name: { value: "FireRating" }, NominalValue: { value: "2HR" } },
        ],
      },
    ],
  });
  return buildInvertedIndex([
    { localId: 1, properties: flattenItemData(item(1, "IFCWALL")) },
    { localId: 2, properties: flattenItemData(item(2, "IFCWALL")) },
    { localId: 3, properties: flattenItemData(item(3, "IFCSLAB")) },
  ]);
}

describe("category resolution against a realistic index", () => {
  it("flattenItemData emits `_IfcClass` so the index exposes the class key", () => {
    const index = realisticIndex();
    // The whole point of the Wave-48 fix: `_IfcClass` (not just the raw
    // `_category` key) is present in the index.
    expect(index.has("_IfcClass")).toBe(true);
    expect(findClassInIndex(index, 1)).toBe("IFCWALL");
    expect(classIdsForModel(index, "IFCWALL")).toEqual(new Set([1, 2]));
  });

  it("computeCategoryClassMap returns per-model class id sets", () => {
    const map = computeCategoryClassMap(
      "IFCWALL",
      new Map([["m1", realisticIndex()]]),
    );
    expect(map).toEqual(new Map([["m1", new Set([1, 2])]]));
  });

  it("resolveCategoryClass prefers the index (path: index)", async () => {
    const res = await resolveCategoryClass(
      new Map([["m1", new Set([2])]]),
      new Map([["m1", realisticIndex()]]),
      async () => null,
    );
    expect(res).toEqual({ cls: "IFCWALL", path: "index" });
  });

  it("empty index falls back to getElementData (path: getElementData)", async () => {
    const res = await resolveCategoryClass(
      new Map([["m1", new Set([99])]]),
      new Map(),
      async () => ({ _category: "IFCDOOR" }),
    );
    expect(res).toEqual({ cls: "IFCDOOR", path: "getElementData" });
  });

  it("registry: empty index + `_IfcClass`-only return still resolves via fallback", async () => {
    // Maintainer's exact failure (H2): the index may be empty (still building)
    // AND getElementData returns the class — the fallback must resolve it
    // and the class map must then drive a real op.
    const res = await resolveCategoryClass(
      new Map([["m1", new Set([7])]]),
      new Map(),
      async () => ({ _IfcClass: "IFCWALL" }),
    );
    expect(res).toEqual({ cls: "IFCWALL", path: "getElementData" });
  });

  it("failed path when selection empty or no class anywhere", async () => {
    expect(
      await resolveCategoryClass(new Map(), new Map(), async () => null),
    ).toEqual({ cls: null, path: "failed" });
    expect(
      await resolveCategoryClass(
        new Map([["m1", new Set([7])]]),
        new Map(),
        async () => ({}),
      ),
    ).toEqual({ cls: null, path: "failed" });
  });
});

describe("section-plane normal chain", () => {
  it("face normal present → flipped to cut toward the camera", () => {
    expect(
      resolveSectionPlaneNormal({
        faceNormal: { x: 1, y: 0, z: 0 },
        cameraDirection: { x: 0, y: 0, z: -1 },
      }),
    ).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("no face normal + non-axis camera → bbox-face snap (axis-aligned)", () => {
    expect(
      resolveSectionPlaneNormal({
        faceNormal: null,
        cameraDirection: { x: 0.8, y: 0.6, z: 0 },
      }),
    ).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("no face normal + axis camera → camera direction (last resort)", () => {
    expect(
      resolveSectionPlaneNormal({
        faceNormal: null,
        cameraDirection: { x: 0, y: 0, z: -1 },
      }),
    ).toEqual({ x: 0, y: 0, z: -1 });
  });

  it("degenerate camera direction → snap returns null, chain returns the direction", () => {
    expect(snapBboxFaceNormal({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(
      resolveSectionPlaneNormal({
        faceNormal: null,
        cameraDirection: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual({ x: 0, y: 0, z: 0 });
  });
});