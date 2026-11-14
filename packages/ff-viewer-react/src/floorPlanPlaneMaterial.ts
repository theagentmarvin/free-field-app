// packages/ff-viewer-react/src/floorPlanPlaneMaterial.ts
//
// Wave 63 — texture + material for the calibrated floor-plan PDF plane
// (IfcViewer.addFloorPlanPlane). Split out so the look of the overlay
// is unit-testable without mounting a viewer.
//
// The overlay used to look dim because the material had a hard-coded
// `opacity: 0.40`: 60 % of the model showed through the white paper,
// so the sheet read as a grey wash. The PDF is now drawn at the
// caller's opacity (default 1), unlit and not tone-mapped, with an
// sRGB texture and anisotropic filtering (the plane is mostly seen at
// grazing angles, where plain mipmapping blurs thin linework).

// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";

/** Clamp a floor-plan plane opacity to 0..1 (non-finite → 1). */
export function clampFloorPlanOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

export function createFloorPlanPlaneMaterial(
  canvas: HTMLCanvasElement,
  options: { opacity?: number; maxAnisotropy?: number } = {},
): { texture: THREE.CanvasTexture; material: THREE.MeshBasicMaterial } {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (options.maxAnisotropy && options.maxAnisotropy > 1) {
    texture.anisotropy = options.maxAnisotropy;
  }
  const material = new THREE.MeshBasicMaterial({ // toe-drift:allow -- PDF floor-plan overlay material; no TOE equivalent (reviewed 2026-11-04).
    map: texture,
    // Always in the transparent pass (renderOrder 999, after the
    // model) so a live opacity change never needs a recompile.
    transparent: true,
    opacity: clampFloorPlanOpacity(options.opacity ?? 1),
    // Unlit + not tone-mapped: the PDF's sRGB pixels reach the screen
    // untouched (white paper stays white, black ink stays black).
    toneMapped: false,
    depthWrite: false,
    // At grazing camera angles the depth buffer precision collapses —
    // floor-level model geometry and the PDF plane produce
    // near-identical depth values, causing fragments to intermittently
    // fail depth testing. The PDF sits above all model geometry
    // (floorZ+0.04) and the clip plane kills everything above
    // floorZ+0.05, so disabling depthTest is safe: nothing should
    // occlude the PDF overlay at this level.
    depthTest: false,
    side: THREE.DoubleSide,
  });
  return { texture, material };
}
