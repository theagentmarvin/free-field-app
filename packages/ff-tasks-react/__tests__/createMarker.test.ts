import { describe, expect, it } from "vitest";

import {
  bboxCenter,
  isTapClick,
  tapMarkerReducer,
  TAP_MOVE_THRESHOLD_PX,
  TAP_MAX_DURATION_MS,
  type PointerStamp,
} from "../src/createMarker";

describe("bboxCenter (screen-anchor math: selection bbox → world point)", () => {
  it("averages min and max per axis", () => {
    const center = bboxCenter({
      min: [0, 0, 0],
      max: [10, 20, 30],
    });
    expect(center).toEqual([5, 10, 15]);
  });

  it("handles negative and non-origin boxes", () => {
    const center = bboxCenter({
      min: [-4, -2, 3],
      max: [4, 2, 9],
    });
    expect(center).toEqual([0, 0, 6]);
  });

  it("is the box corner for a degenerate box", () => {
    expect(bboxCenter({ min: [7, 7, 7], max: [7, 7, 7] })).toEqual([7, 7, 7]);
  });
});

describe("isTapClick (click-vs-drag discriminator)", () => {
  const stamp = (x: number, y: number, t: number): PointerStamp => ({ clientX: x, clientY: y, t });

  it("accepts a stationary, quick press", () => {
    expect(isTapClick(stamp(50, 80, 1000), stamp(50, 80, 1050))).toBe(true);
  });

  it("accepts movement up to the threshold, inclusive", () => {
    // 6px diagonal
    const move = TAP_MOVE_THRESHOLD_PX / Math.SQRT2;
    expect(isTapClick(stamp(0, 0, 0), stamp(move, move, 100))).toBe(true);
  });

  it("rejects movement beyond the threshold (drag / pan)", () => {
    expect(isTapClick(stamp(0, 0, 0), stamp(TAP_MOVE_THRESHOLD_PX + 1, 0, 100))).toBe(false);
  });

  it("rejects a slow press (duration beyond the cap)", () => {
    expect(
      isTapClick(stamp(0, 0, 0), stamp(0, 0, TAP_MAX_DURATION_MS + 1)),
    ).toBe(false);
  });
});

describe("tapMarkerReducer (marker state machine: shown / moved / cleared)", () => {
  it("shows on tap", () => {
    expect(tapMarkerReducer({ kind: "hidden" }, { type: "tap", uv: [0.5, 0.5] })).toEqual({
      kind: "shown",
      uv: [0.5, 0.5],
    });
  });

  it("moves (re-anchors) when tapped at a new uv", () => {
    const shown = tapMarkerReducer({ kind: "hidden" }, { type: "tap", uv: [0.2, 0.2] });
    const moved = tapMarkerReducer(shown, { type: "tap", uv: [0.8, 0.9] });
    expect(moved).toEqual({ kind: "shown", uv: [0.8, 0.9] });
  });

  it("clears to hidden", () => {
    const shown = tapMarkerReducer({ kind: "hidden" }, { type: "tap", uv: [0.3, 0.4] });
    expect(tapMarkerReducer(shown, { type: "clear" })).toEqual({ kind: "hidden" });
  });
});