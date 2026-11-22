import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { useCompareStore } from "../../src/compare/compareStore";
import { paintRaster, releaseCanvas, compositeOverlay } from "../../src/compare/viewer/composite";
import CompareViewer from "../../src/compare/viewer/CompareViewer";
import { installCanvasStub, makeResult, sideA, sideB } from "./fixtures";

describe("canvas memory (round 3)", () => {
  let restore: () => void;
  let puts: number;
  beforeEach(() => {
    restore = installCanvasStub();
    puts = 0;
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: () => {
        puts += 1;
      },
      drawImage: () => {},
      fillRect: () => {},
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    useCompareStore.getState().close();
  });
  afterEach(() => restore());

  const seed = (mode: "side-by-side" | "overlay" | "changes", result = makeResult()) =>
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        resultSides: { base: sideA, revision: sideB },
        result,
        status: "done",
        mode,
      });
    });

  it("releaseCanvas zeroes the backing store", () => {
    const c = document.createElement("canvas");
    c.width = 50;
    c.height = 40;
    releaseCanvas(c);
    expect(c.width).toBe(0);
    expect(c.height).toBe(0);
    expect(() => releaseCanvas(null)).not.toThrow();
  });

  it("paintRaster does not reassign the size when it already matches", () => {
    const c = document.createElement("canvas");
    c.width = 2;
    c.height = 2;
    const setter = vi.spyOn(c, "width", "set");
    paintRaster(c, 2, 2, new Uint8ClampedArray(16));
    expect(setter).not.toHaveBeenCalled();
  });

  it("releases every viewer canvas on unmount", () => {
    seed("side-by-side");
    const { unmount } = render(<CompareViewer />);
    const canvases = [...document.querySelectorAll("canvas")] as HTMLCanvasElement[];
    expect(canvases.length).toBe(2);
    expect(canvases.every((c) => c.width > 0)).toBe(true);
    unmount();
    expect(canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  });

  it("releases the old canvases when the mode switches (overlay too)", () => {
    seed("side-by-side");
    render(<CompareViewer />);
    const first = [...document.querySelectorAll("canvas")] as HTMLCanvasElement[];
    act(() => useCompareStore.getState().setMode("overlay"));
    expect(first.every((c) => c.width === 0)).toBe(true);
    const overlay = document.querySelector("canvas") as HTMLCanvasElement;
    expect(overlay.width).toBeGreaterThan(0);
    act(() => useCompareStore.getState().setMode("changes"));
    expect(overlay.width).toBe(0);
  });

  it("paints each raster once per result; selection and pan/zoom do not repaint", () => {
    seed("side-by-side");
    render(<CompareViewer />);
    expect(puts).toBe(2);
    act(() => useCompareStore.getState().selectRegion(1));
    fireEvent.click(screen.getByTestId("documents-compare-zoom-in"));
    fireEvent.wheel(screen.getByTestId("documents-compare-pane-base"), { deltaY: -100 });
    act(() => useCompareStore.getState().setSyncViews(false));
    expect(puts).toBe(2);
    // A new result repaints (once per pane).
    seed("side-by-side", makeResult());
    expect(puts).toBe(4);
  });

  it("overlay paints once, repaints only on layer changes and reuses its buffer", () => {
    seed("overlay");
    render(<CompareViewer />);
    expect(puts).toBe(1);
    act(() => useCompareStore.getState().selectRegion(1));
    expect(puts).toBe(1);
    act(() => useCompareStore.getState().setLayerOpacity({ base: 0.5 }));
    expect(puts).toBe(2);
  });

  it("compositeOverlay reuses a buffer of the right size and allocates otherwise", () => {
    const o = {
      showBase: true,
      showRevision: true,
      baseOpacity: 1,
      revisionOpacity: 1,
      colors: { base: "#ff0000", revision: "#0000ff", shared: "#000000" },
    };
    const classes = new Uint8Array([0, 1, 2, 3]);
    const a = compositeOverlay(classes, 2, 2, o);
    expect(compositeOverlay(classes, 2, 2, o, a)).toBe(a);
    expect(compositeOverlay(classes, 2, 2, o, new Uint8ClampedArray(4))).not.toBe(a);
  });
});
