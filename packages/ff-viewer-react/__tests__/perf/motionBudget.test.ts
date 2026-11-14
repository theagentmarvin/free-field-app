import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";
import { MotionBudget, isHighlightedTile } from "../../src/perf/motionBudget";

const box = new THREE.BoxGeometry(1, 1, 1);
const mat = new THREE.MeshBasicMaterial();

/** A tile at (x, 0, z) with a uniform scale. */
function tile(x: number, z: number, scale = 1): THREE.Mesh {
  const m = new THREE.Mesh(box, mat);
  m.position.set(x, 0, z);
  m.scale.setScalar(scale);
  m.updateMatrixWorld(true);
  return m;
}

function perspCam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}

function root(...meshes: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  for (const m of meshes) g.add(m);
  g.updateMatrixWorld(true);
  return g;
}

describe("MotionBudget", () => {
  it("keeps the N tiles with the largest projected size and hides the rest", () => {
    const near = tile(0, 5); // distance 5
    const mid = tile(0, 0); // distance 10
    const far = tile(0, -20); // distance 30
    const big = tile(0, -20, 10); // far but large
    const b = new MotionBudget({ min: 2, max: 2, initial: 2 });
    const hidden = b.apply([root(near, mid, far, big)], perspCam());
    expect(hidden).toBe(2);
    expect(near.visible).toBe(true);
    expect(big.visible).toBe(true);
    expect(mid.visible).toBe(false);
    expect(far.visible).toBe(false);
    b.restore();
    expect([near, mid, far, big].every((m) => m.visible)).toBe(true);
    expect(b.hiddenCount).toBe(0);
  });

  it("does nothing when the in-view tiles fit the budget", () => {
    const tiles = [tile(0, 0), tile(1, 0), tile(-1, 0)];
    const b = new MotionBudget({ min: 5, max: 5, initial: 5 });
    expect(b.apply([root(...tiles)], perspCam())).toBe(0);
    expect(tiles.every((m) => m.visible)).toBe(true);
  });

  it("does not count or touch tiles outside the frustum", () => {
    const inView = [tile(0, 0), tile(0.5, 0)];
    const behind = tile(0, 50); // behind the camera
    const b = new MotionBudget({ min: 2, max: 2, initial: 2 });
    expect(b.apply([root(...inView, behind)], perspCam())).toBe(0);
    expect(behind.visible).toBe(true);
  });

  it("never touches hidden subtrees or already-hidden meshes", () => {
    const hiddenModel = root(tile(0, 4), tile(0, 3));
    hiddenModel.visible = false;
    const userHidden = tile(0, 6);
    userHidden.visible = false;
    const a = tile(0, 0);
    const c = tile(0, -5);
    const b = new MotionBudget({ min: 1, max: 1, initial: 1 });
    b.apply([hiddenModel, root(userHidden, a, c)], perspCam());
    expect(a.visible).toBe(true);
    expect(c.visible).toBe(false);
    b.restore();
    // restore only flips back what the budget hid
    expect(userHidden.visible).toBe(false);
    expect(hiddenModel.visible).toBe(false);
    expect(c.visible).toBe(true);
  });

  it("always draws highlighted tiles without spending budget on them", () => {
    const hl = tile(0, -30); // far, would lose
    hl.material = [mat, mat, new THREE.MeshBasicMaterial({ color: 0xff0000 })];
    expect(isHighlightedTile(hl)).toBe(true);
    expect(isHighlightedTile(tile(0, 0))).toBe(false);
    const a = tile(0, 0);
    const c = tile(0, -5);
    const b = new MotionBudget({ min: 1, max: 1, initial: 1 });
    b.apply([root(hl, a, c)], perspCam());
    expect(hl.visible).toBe(true);
    expect(a.visible).toBe(true);
    expect(c.visible).toBe(false);
  });

  it("ignores tiles entirely on the clipped side of a clipping plane", () => {
    // plane keeps z <= 2 (normal -z, constant 2): the near tile at z=5 is clipped
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 2);
    const clipped = tile(0, 5);
    const a = tile(0, 0);
    const c = tile(0, -5);
    const b = new MotionBudget({ min: 2, max: 2, initial: 2 });
    expect(b.apply([root(clipped, a, c)], perspCam(), [plane])).toBe(0);
    expect([clipped, a, c].every((m) => m.visible)).toBe(true);
  });

  it("ranks by size under an orthographic camera", () => {
    const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    cam.position.set(0, 0, 100);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const nearSmall = tile(0, 40, 1);
    const farLarge = tile(10, -40, 4);
    const b = new MotionBudget({ min: 1, max: 1, initial: 1 });
    b.apply([root(nearSmall, farLarge)], cam);
    expect(farLarge.visible).toBe(true);
    expect(nearSmall.visible).toBe(false);
  });

  it("treats a tile the camera is inside of as top priority", () => {
    const around = tile(0, 10, 4); // camera at z=10 is inside it
    const others = [tile(0, 0, 3), tile(0, -2, 3)];
    const b = new MotionBudget({ min: 1, max: 1, initial: 1 });
    b.apply([root(around, ...others)], perspCam());
    expect(around.visible).toBe(true);
    expect(others.every((m) => !m.visible)).toBe(true);
  });

  it("adapts N to the measured frame time within [min, max]", () => {
    const b = new MotionBudget({ min: 150, max: 400, initial: 250, targetMs: 10 });
    for (let i = 0; i < 200; i++) b.recordFrame(30);
    expect(b.budget).toBe(150);
    // growing only happens while the budget is actually binding
    for (let i = 0; i < 200; i++) b.recordFrame(2);
    expect(b.budget).toBe(150);
    const many = Array.from({ length: 500 }, (_, i) => tile((i % 20) * 0.2 - 2, -(i / 20)));
    b.apply([root(...many)], perspCam());
    b.restore();
    for (let i = 0; i < 400; i++) b.recordFrame(2);
    expect(b.budget).toBe(400);
  });

  it("apply() undoes the previous apply() first", () => {
    const tiles = [tile(0, 0), tile(0, -5), tile(0, -10)];
    const b = new MotionBudget({ min: 1, max: 1, initial: 1 });
    b.apply([root(...tiles)], perspCam());
    expect(b.hiddenCount).toBe(2);
    b.apply([tiles[0].parent!], perspCam());
    expect(b.hiddenCount).toBe(2);
    b.restore();
    expect(tiles.every((m) => m.visible)).toBe(true);
  });
});
