// Wave 14 — shared types for the picking backend seam.
//
// Everything here is plain data. No THREE.Vector3/Vector2 ever
// crosses these boundaries: the drift-clean contract is `{x, y, z}`
// plain objects and `{x, y}` normalized device coordinates. The
// engine objects stay inside IfcViewer / the seam adapters.

/**
 * Which screen→world resolution path is live for the viewer.
 * `"fast"` = FastModelPicker (GPU id/depth readback); `"raycaster"`
 * = the engine's `OBC.Raycasters` fragment-aware sweep.
 */
export type BackendId = "fast" | "raycaster";

/** Normalized device coordinates, in the same space `OBC.Raycasters`
 * and `FastModelPicker` accept (x/y in [-1, 1], y-up). */
export interface NdcPoint {
  x: number;
  y: number;
}

/** Plain world-space point — the drift-clean result of a pick. */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}