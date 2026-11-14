// packages/ff-viewer-react/src/perf/motionBudget.ts
//
// Motion draw budget: WHILE THE CAMERA MOVES, draw only the N fragment
// tiles that matter most on screen (largest projected size), hide the
// rest for that one render, and put them back right after it.
//
// Why: a federated scene of several large IFC models is ~800-1500 draw
// calls at rest. On an integrated GPU that is 30-60 ms of render CPU per
// frame, so orbit/pan/zoom run at ~14 fps. Small, far tiles contribute
// almost nothing to a moving image, so capping the moving frame at a few
// hundred of the largest tiles gives ~5-8x the frame rate while the
// silhouette of the building stays intact. At rest everything is drawn.
//
// Contract:
//   - `apply()` hides tiles by flipping `mesh.visible = false` and
//     remembers exactly which ones; `restore()` flips back exactly those.
//     The caller brackets ONE render with apply/restore, so no other code
//     (picking passes, snapshots, the engine's tile updates) ever sees a
//     budget-hidden tile.
//   - Only meshes under the given roots (the fragments model objects) are
//     considered. Subtrees with `visible === false` (Hider / model toggles)
//     are skipped and never touched.
//   - Highlighted tiles (selection tint) are always drawn and do not count
//     against the budget.
//   - Tiles outside the frustum, or entirely on the clipped side of a
//     clipping plane, are not drawn anyway and do not count either.
//   - Perspective: score = bounding radius / distance to its centre
//     (projected size; > 1 when the camera is inside the sphere).
//     Orthographic: the projected size is radius * constant, so the score
//     is the radius.
//   - Adaptive N: `recordFrame(ms)` feeds the measured render CPU time of
//     a budgeted frame; N moves inside [min, max] towards `targetMs`.

// Raw three is confined to small, drift-clean viewer modules (same rule as
// IfcViewer / idPassInterop); math types only, no scene objects created.
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";

export interface MotionBudgetOptions {
  /** Lower bound for the adaptive tile budget. */
  min?: number;
  /** Upper bound for the adaptive tile budget. */
  max?: number;
  /** Budget used until the first measurements arrive. */
  initial?: number;
  /** Render CPU time per moving frame the budget aims for (ms). */
  targetMs?: number;
}

export const MOTION_BUDGET_DEFAULTS: Required<MotionBudgetOptions> = {
  min: 150,
  max: 400,
  initial: 250,
  targetMs: 10,
};

/** Minimal mesh surface the budget reads (a three.js Mesh satisfies it). */
type BudgetNode = THREE.Object3D & {
  isMesh?: boolean;
  isInstancedMesh?: boolean;
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
  boundingSphere?: THREE.Sphere | null;
  computeBoundingSphere?: () => void;
};

/**
 * A fragments tile is created with a one-element material array
 * (`new Mesh(geometry, [material])`); a highlight (selection tint) adds
 * one material per highlight style (MeshManager `createHighlights`).
 */
export function isHighlightedTile(mesh: { material?: unknown }): boolean {
  const m = mesh.material;
  return Array.isArray(m) && m.length > 1;
}

export class MotionBudget {
  readonly min: number;
  readonly max: number;
  readonly targetMs: number;
  private _budget: number;
  private _ema: number | null = null;
  /** True when the last apply() had more candidates than the budget. */
  private _binding = false;

  private readonly hidden: THREE.Object3D[] = [];
  private cand: BudgetNode[] = [];
  private scores = new Float64Array(1024);
  private sorted = new Float64Array(1024);
  private readonly stack: THREE.Object3D[] = [];

  private readonly pm = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly ws = new THREE.Sphere();
  private readonly camPos = new THREE.Vector3();

  constructor(opts: MotionBudgetOptions = {}) {
    const o = { ...MOTION_BUDGET_DEFAULTS, ...opts };
    this.min = Math.max(1, Math.floor(o.min));
    this.max = Math.max(this.min, Math.floor(o.max));
    this.targetMs = o.targetMs;
    this._budget = clamp(Math.round(o.initial), this.min, this.max);
  }

  /** Current tile budget N. */
  get budget(): number {
    return this._budget;
  }

  /** Number of tiles hidden by the last apply() (0 after restore()). */
  get hiddenCount(): number {
    return this.hidden.length;
  }

  /**
   * Hide every in-view tile under `roots` except the `budget` ones with
   * the largest projected size. Always undoes a previous apply first.
   * Returns the number of tiles hidden.
   */
  apply(
    roots: Iterable<THREE.Object3D>,
    camera: THREE.Camera,
    clippingPlanes: readonly THREE.Plane[] = [],
  ): number {
    this.restore();
    camera.updateMatrixWorld();
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const perspective =
      (camera as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true;

    const cand = this.cand;
    cand.length = 0;
    let n = 0;
    const stack = this.stack;
    stack.length = 0;
    for (const root of roots) {
      if (root && root.visible) stack.push(root);
    }
    while (stack.length > 0) {
      const node = stack.pop() as BudgetNode;
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].visible) stack.push(kids[i]);
      }
      if (!node.isMesh) continue;
      if (isHighlightedTile(node)) continue; // always drawn, free
      const sphere = localSphere(node);
      if (!sphere) continue;
      const ws = this.ws.copy(sphere).applyMatrix4(node.matrixWorld);
      if (!this.frustum.intersectsSphere(ws)) continue;
      if (fullyClipped(ws, clippingPlanes)) continue;
      let score: number;
      if (perspective) {
        // No "inside the sphere = infinite" shortcut: fragments tiles
        // group items by material, so in an interior the camera sits
        // inside hundreds of building-sized tile spheres and they would
        // all tie at the top, defeating the budget. r/d keeps ranking
        // them (a tile the camera is inside of still scores > 1).
        const d = Math.max(ws.center.distanceTo(this.camPos), 1e-6);
        score = ws.radius / d;
      } else {
        score = ws.radius;
      }
      if (n >= this.scores.length) this.grow(n * 2);
      this.scores[n] = score;
      cand.push(node);
      n++;
    }

    const budget = this._budget;
    this._binding = n > budget;
    if (!this._binding) {
      cand.length = 0;
      return 0;
    }
    // k-th largest score = threshold; strictly smaller ones are hidden
    // (ties at the threshold stay drawn — at most a few extra tiles).
    const sorted = this.sorted.subarray(0, n);
    sorted.set(this.scores.subarray(0, n));
    sorted.sort();
    const threshold = sorted[n - budget];
    for (let i = 0; i < n; i++) {
      if (this.scores[i] < threshold) {
        const m = cand[i];
        m.visible = false;
        this.hidden.push(m);
      }
    }
    cand.length = 0; // drop references between frames
    return this.hidden.length;
  }

  /** Put back exactly the tiles the last apply() hid. */
  restore(): void {
    const hidden = this.hidden;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
    this.cand.length = 0;
  }

  /**
   * Feed the render CPU time (ms) of a budgeted moving frame. The budget
   * shrinks when frames are over target and grows (only while it is
   * actually limiting what is drawn) when they are comfortably under.
   */
  recordFrame(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this._ema = this._ema === null ? ms : this._ema * 0.8 + ms * 0.2;
    const ema = this._ema;
    if (ema > this.targetMs * 1.1) {
      this._budget = clamp(Math.floor(this._budget * 0.95), this.min, this.max);
    } else if (ema < this.targetMs * 0.75 && this._binding) {
      this._budget = clamp(Math.ceil(this._budget * 1.04), this.min, this.max);
    }
  }

  /** Forget the frame-time history (keeps the learned budget). */
  resetTiming(): void {
    this._ema = null;
  }

  private grow(size: number): void {
    const s = new Float64Array(size);
    s.set(this.scores);
    this.scores = s;
    this.sorted = new Float64Array(size);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function localSphere(node: BudgetNode): THREE.Sphere | null {
  if (node.isInstancedMesh) {
    if (!node.boundingSphere && node.computeBoundingSphere) node.computeBoundingSphere();
    return node.boundingSphere ?? null;
  }
  const g = node.geometry;
  if (!g) return null;
  if (!g.boundingSphere) {
    if (!g.attributes?.position) return null;
    g.computeBoundingSphere();
  }
  const s = g.boundingSphere;
  return s && Number.isFinite(s.radius) && s.radius >= 0 ? s : null;
}

/** Sphere entirely on the clipped (negative) side of any plane. */
function fullyClipped(ws: THREE.Sphere, planes: readonly THREE.Plane[]): boolean {
  for (let i = 0; i < planes.length; i++) {
    if (planes[i].distanceToPoint(ws.center) < -ws.radius) return true;
  }
  return false;
}
