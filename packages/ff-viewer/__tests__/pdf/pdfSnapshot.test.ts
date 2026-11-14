import { describe, it, expect } from "vitest";

import {
  computeSnapshotCrop,
  SNAPSHOT_CROP_FRACTION,
} from "../../src/pdf/pdfSnapshot";

describe("computeSnapshotCrop (uv → crop, edge clamping)", () => {
  const W = 1200;
  const H = 900;

  it("centres a 1/3 crop on a mid-page point and scales to maxWidthPx", () => {
    const c = computeSnapshotCrop([0.5, 0.5], W, H, 400)!;
    expect(c.sw).toBeCloseTo(W * SNAPSHOT_CROP_FRACTION);
    expect(c.sh).toBeCloseTo(H * SNAPSHOT_CROP_FRACTION);
    // centred → the point sits at the centre of the crop
    expect(c.sx).toBeCloseTo(0.5 * W - c.sw / 2);
    expect(c.sy).toBeCloseTo(0.5 * H - c.sh / 2);
    // destination: 400 wide, aspect-preserving height
    expect(c.dw).toBe(400);
    expect(c.dh).toBeCloseTo(400 * (c.sh / c.sw));
  });

  it("clamps the crop to the left/top edge without going negative", () => {
    const c = computeSnapshotCrop([0, 0], W, H, 400)!;
    expect(c.sx).toBe(0);
    expect(c.sy).toBe(0);
    expect(c.sw).toBeLessThanOrEqual(W);
    expect(c.sh).toBeLessThanOrEqual(H);
  });

  it("clamps the crop to the right/bottom edge", () => {
    const c = computeSnapshotCrop([1, 1], W, H, 400)!;
    expect(c.sx + c.sw).toBeCloseTo(W);
    expect(c.sy + c.sh).toBeCloseTo(H);
    expect(c.sx).toBeGreaterThanOrEqual(0);
    expect(c.sy).toBeGreaterThanOrEqual(0);
  });

  it("a small page still yields a 1/3 crop clamped inside the source", () => {
    const c = computeSnapshotCrop([0.5, 0.5], 100, 60, 400)!;
    expect(c.sw).toBeCloseTo(100 / 3);
    expect(c.sh).toBeCloseTo(60 / 3);
    expect(c.sx).toBeGreaterThanOrEqual(0);
    expect(c.sy).toBeGreaterThanOrEqual(0);
    expect(c.sx + c.sw).toBeLessThanOrEqual(100);
    expect(c.sy + c.sh).toBeLessThanOrEqual(60);
  });

  it("returns null for degenerate source dimensions", () => {
    expect(computeSnapshotCrop([0.5, 0.5], 0, 100, 400)).toBeNull();
    expect(computeSnapshotCrop([0.5, 0.5], 100, 0, 400)).toBeNull();
    expect(computeSnapshotCrop([0.5, 0.5], -10, 100, 400)).toBeNull();
  });

  it("clamps out-of-range uv into [0,1] instead of producing a negative crop", () => {
    const c = computeSnapshotCrop([1.5, -0.5], W, H, 400)!;
    expect(c.sx).toBeGreaterThanOrEqual(0);
    expect(c.sy).toBeGreaterThanOrEqual(0);
    expect(c.sx + c.sw).toBeLessThanOrEqual(W);
    expect(c.sy + c.sh).toBeLessThanOrEqual(H);
  });
});