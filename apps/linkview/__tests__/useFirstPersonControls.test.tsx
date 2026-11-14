// Regression (w68): click-vs-drag discrimination in the LinkView
// first-person pane. A press that moves <= DRAG_THRESHOLD_PX must NOT
// look around (so the viewer's own 5 px pick guard lets the click
// select); a longer drag looks around.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DRAG_THRESHOLD_PX,
  useFirstPersonControls,
} from "../src/hooks/useFirstPersonControls";

function ptr(type: string, x: number, y: number): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  return Object.assign(e, { pointerId: 1, isPrimary: true });
}

function setup() {
  const navigateTo = vi.fn();
  const handle = {
    getPose: vi.fn(() => ({ pos: [0, 1.65, 0], target: [0, 1.65, -1] })),
    setRestrictedThirdPerson: vi.fn(),
    releaseRestrictedCamera: vi.fn(),
    navigateTo,
  };
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.appendChild(canvas);
  document.body.appendChild(host);
  renderHook(() =>
    useFirstPersonControls({
      viewerRef: { current: handle } as never,
      hostEl: host,
      active: true,
      floorZ: 0,
      bearingRef: { current: 0 },
    }),
  );
  return { canvas, navigateTo };
}

describe("first-person click vs drag", () => {
  it("shares the viewer's 5 px pick guard threshold", () => {
    expect(DRAG_THRESHOLD_PX).toBe(5);
  });

  it("a click (tiny movement) does not look around", () => {
    const { canvas, navigateTo } = setup();
    canvas.dispatchEvent(ptr("pointerdown", 100, 100));
    window.dispatchEvent(ptr("pointermove", 102, 101));
    window.dispatchEvent(ptr("pointerup", 102, 101));
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("a drag beyond the threshold looks around", () => {
    const { canvas, navigateTo } = setup();
    canvas.dispatchEvent(ptr("pointerdown", 100, 100));
    window.dispatchEvent(ptr("pointermove", 120, 100));
    window.dispatchEvent(ptr("pointerup", 120, 100));
    expect(navigateTo).toHaveBeenCalled();
  });
});
