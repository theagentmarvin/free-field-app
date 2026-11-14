// Wave 63 — regression: the floor-plan PDF overlay looked dim because
// its material had a hard-coded opacity of 0.40.
import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";

import {
  clampFloorPlanOpacity,
  createFloorPlanPlaneMaterial,
} from "../src/floorPlanPlaneMaterial";

describe("createFloorPlanPlaneMaterial (wave 63)", () => {
  it("defaults to fully opaque, unlit, not tone-mapped, sRGB", () => {
    const { texture, material } = createFloorPlanPlaneMaterial(document.createElement("canvas"));
    expect(material.opacity).toBe(1);
    expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(material.toneMapped).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.map).toBe(texture);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("uses the caller's opacity (clamped) and anisotropy", () => {
    const { texture, material } = createFloorPlanPlaneMaterial(document.createElement("canvas"), {
      opacity: 0.85,
      maxAnisotropy: 16,
    });
    expect(material.opacity).toBe(0.85);
    expect(texture.anisotropy).toBe(16);
    expect(createFloorPlanPlaneMaterial(document.createElement("canvas"), { opacity: 7 }).material.opacity).toBe(1);
  });

  it("clampFloorPlanOpacity clamps to 0..1 and maps NaN to 1", () => {
    expect(clampFloorPlanOpacity(-1)).toBe(0);
    expect(clampFloorPlanOpacity(0.5)).toBe(0.5);
    expect(clampFloorPlanOpacity(2)).toBe(1);
    expect(clampFloorPlanOpacity(Number.NaN)).toBe(1);
  });
});
