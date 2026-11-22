// Wave 63 — regression: the floor-plan PDF overlay looked dim because
// its material had a hard-coded opacity of 0.40.
import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";

import {
  clampFloorPlanOpacity,
  createFloorPlanPlaneMaterial,
  computeFloorPlanPlacement,
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

describe("computeFloorPlanPlacement (rotated calibrations)", () => {
  /** Calibration forward map: world = scale * R(rot) * pdf + t on (X, Z). */
  const world = (p: { x: number; y: number }, s: number, rot: number, t: { x: number; z: number }) => ({
    x: s * (Math.cos(rot) * p.x - Math.sin(rot) * p.y) + t.x,
    z: s * (Math.sin(rot) * p.x + Math.cos(rot) * p.y) + t.z,
  });

  it("matches the axis-aligned placement when rotation is 0", () => {
    const p = computeFloorPlanPlacement({ minX: 2, maxX: 12, minZ: -4, maxZ: 6 }, 3, 0);
    expect(p).toEqual({ width: 10, depth: 10, position: { x: 7, y: 3, z: 1 }, rotationY: 0 });
  });

  it.each([30, 90, -45, 180, 200])("places every page corner on its calibrated world point (%i deg)", (deg) => {
    const rot = (deg * Math.PI) / 180;
    const s = 0.0353;
    const t = { x: 14.29, z: -7.2 };
    const W = 1000;
    const H = 800;
    const c = world({ x: W / 2, y: H / 2 }, s, rot, t);
    const bounds = {
      minX: c.x - (s * W) / 2,
      maxX: c.x + (s * W) / 2,
      minZ: c.z - (s * H) / 2,
      maxZ: c.z + (s * H) / 2,
    };
    const pl = computeFloorPlanPlacement(bounds, 0.04, rot);
    // Same construction as IfcViewer.addFloorPlanPlane.
    const geom = new THREE.PlaneGeometry(pl.width, pl.depth);
    geom.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geom);
    mesh.position.set(pl.position.x, pl.position.y, pl.position.z);
    mesh.rotation.y = pl.rotationY;
    mesh.updateMatrixWorld(true);
    // Plane after rotateX(-90deg): uv(0,1) (texture top-left) is at local (-w/2, 0, -d/2).
    const corners: Array<[number, number, THREE.Vector3]> = [
      [0, 0, new THREE.Vector3(-pl.width / 2, 0, -pl.depth / 2)],
      [W, 0, new THREE.Vector3(pl.width / 2, 0, -pl.depth / 2)],
      [W, H, new THREE.Vector3(pl.width / 2, 0, pl.depth / 2)],
      [0, H, new THREE.Vector3(-pl.width / 2, 0, pl.depth / 2)],
    ];
    for (const [px, py, local] of corners) {
      const expected = world({ x: px, y: py }, s, rot, t);
      const got = local.applyMatrix4(mesh.matrixWorld);
      expect(got.x).toBeCloseTo(expected.x, 6);
      expect(got.z).toBeCloseTo(expected.z, 6);
      expect(got.y).toBeCloseTo(0.04, 9);
    }
  });
});

describe("floor-plan plane registers the texture (UV-aware)", () => {
  const world = (p: { x: number; y: number }, s: number, rot: number, t: { x: number; z: number }) => ({
    x: s * (Math.cos(rot) * p.x - Math.sin(rot) * p.y) + t.x,
    z: s * (Math.sin(rot) * p.x + Math.cos(rot) * p.y) + t.z,
  });

  /** Mesh-local position of a UV, interpolated from the REAL geometry's vertices. */
  function localAtUv(geom: THREE.BufferGeometry, u: number, v: number): THREE.Vector3 {
    const pos = geom.getAttribute("position");
    const uv = geom.getAttribute("uv");
    const vs = Array.from({ length: pos.count }, (_, i) => ({
      p: new THREE.Vector3().fromBufferAttribute(pos, i),
      u: uv.getX(i),
      v: uv.getY(i),
    }));
    const at = (uu: number, vv: number) => vs.find((q) => q.u === uu && q.v === vv)!.p;
    const p00 = at(0, 0), p10 = at(1, 0), p01 = at(0, 1), p11 = at(1, 1);
    return new THREE.Vector3()
      .addScaledVector(p00, (1 - u) * (1 - v))
      .addScaledVector(p10, u * (1 - v))
      .addScaledVector(p01, (1 - u) * v)
      .addScaledVector(p11, u * v);
  }

  it.each([0, 25, 90, -45, 180])("PDF points land on the calibration forward map (%i deg, b != 0)", (deg) => {
    const rot = (deg * Math.PI) / 180;
    const s = 0.0338667;
    const t = { x: -23.9 + 8.66, z: -1.58 + 7.05 }; // translation includes a non-zero base shift
    const W = 1190.52;
    const H = 841.8;
    const c = world({ x: W / 2, y: H / 2 }, s, rot, t);
    const bounds = { minX: c.x - (s * W) / 2, maxX: c.x + (s * W) / 2, minZ: c.z - (s * H) / 2, maxZ: c.z + (s * H) / 2 };
    const pl = computeFloorPlanPlacement(bounds, 0.04, rot);
    // Exactly what IfcViewer.addFloorPlanPlane builds.
    const geom = new THREE.PlaneGeometry(pl.width, pl.depth);
    geom.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geom);
    mesh.position.set(pl.position.x, pl.position.y, pl.position.z);
    mesh.rotation.y = pl.rotationY;
    mesh.updateMatrixWorld(true);
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H], [310.5, 200.25]] as Array<[number, number]>) {
      // canvas texture: flipY, so PDF row 0 is v = 1
      const local = localAtUv(geom, px / W, 1 - py / H);
      const got = local.applyMatrix4(mesh.matrixWorld);
      const want = world({ x: px, y: py }, s, rot, t);
      // geometry is float32: 1e-4 m on a 40 m page
      expect(got.x).toBeCloseTo(want.x, 4);
      expect(got.z).toBeCloseTo(want.z, 4);
    }
  });
});
