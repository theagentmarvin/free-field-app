import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import PdfMeasureLayer from "../../src/pdfMeasure/PdfMeasureLayer";
import { usePdfMeasureStore } from "../../src/pdfMeasure/store";

// jsdom has no PointerEvent: a MouseEvent subclass keeps clientX/button.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {};
}

let layer: HTMLDivElement;
let page = 1;
const handle = {
  getAnnotationLayer: () => layer,
  getCurrentPage: () => page,
  getTotalScale: () => 1,
  getDocument: () => null,
  setOnScaleChange: () => () => {},
};
const ref = { current: handle } as unknown as RefObject<never>;

function mount(cal: number | null = 0.01) {
  return render(
    <PdfMeasureLayer
      overlayRef={ref}
      pdfVersionId="v1"
      calibrationMetresPerUnit={cal}
      fallbackPageSize={{ width: 600, height: 400 }}
    />,
  );
}

// page 600x400 shown at 1:1 at the origin
function tap(x: number, y: number) {
  const svg = screen.getByTestId("pdf-measure-svg");
  fireEvent.pointerDown(svg, { clientX: x, clientY: y, button: 0 });
  fireEvent.pointerUp(svg, { clientX: x, clientY: y, button: 0 });
}

beforeEach(() => {
  page = 1;
  layer = document.createElement("div");
  document.body.appendChild(layer);
  usePdfMeasureStore.setState({ tool: "none", draft: [], measurements: {}, manualScales: {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  layer.remove();
  vi.restoreAllMocks();
});

describe("PdfMeasureLayer", () => {
  it("measures a polyline with per-segment and total labels in metres", async () => {
    mount();
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    tap(0, 0);
    tap(300, 0);
    tap(300, 400);
    fireEvent.keyDown(window, { key: "Enter" });
    const labels = screen.getAllByTestId("pdf-measure-label").map((l) => l.textContent);
    expect(labels).toContain("3.00 m");
    expect(labels).toContain("4.00 m");
    expect(labels).toContain("Total 7.00 m");
    expect(screen.getAllByTestId("pdf-measure-item")).toHaveLength(1);
  });

  it("area shows area and perimeter; delete removes one", async () => {
    mount();
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-area"));
    tap(0, 0);
    tap(500, 0);
    tap(500, 200);
    tap(0, 200);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("pdf-measure-item").textContent).toContain("Area 10.00 m² · P 14.00 m");
    fireEvent.click(screen.getByTestId("pdf-measure-delete"));
    expect(screen.queryAllByTestId("pdf-measure-item")).toHaveLength(0);
  });

  it("Escape cancels the draft, then deactivates the tool", async () => {
    mount();
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    tap(10, 10);
    tap(100, 10);
    expect(usePdfMeasureStore.getState().draft).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(usePdfMeasureStore.getState().draft).toHaveLength(0);
    expect(usePdfMeasureStore.getState().tool).toBe("length");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(usePdfMeasureStore.getState().tool).toBe("none");
    expect(usePdfMeasureStore.getState().measurements["v1#1"] ?? []).toHaveLength(0);
  });

  it("a drag does not add a point", async () => {
    mount();
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    const svg = screen.getByTestId("pdf-measure-svg");
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerUp(svg, { clientX: 80, clientY: 10, button: 0 });
    expect(usePdfMeasureStore.getState().draft).toHaveLength(0);
  });

  it("uncalibrated page shows warning badge and page units, never metres", async () => {
    mount(null);
    await screen.findByTestId("pdf-measure-svg");
    expect(screen.getByTestId("pdf-measure-scale-badge").getAttribute("data-scale-source")).toBe("none");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    tap(0, 0);
    tap(100, 0);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("pdf-measure-item").textContent).toBe("Length 100.0 pt×");
  });

  it("set scale: two points + known length makes values metric, and re-labels existing shapes", async () => {
    mount(null);
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-scale"));
    tap(0, 0);
    tap(200, 0);
    fireEvent.change(screen.getByTestId("pdf-measure-scale-input"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("pdf-measure-scale-apply"));
    expect(screen.getByTestId("pdf-measure-scale-badge").getAttribute("data-scale-source")).toBe("manual");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    tap(0, 50);
    tap(100, 50);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("pdf-measure-item").textContent).toBe("Length 5.00 m×");
  });

  it("measurements are kept per page and survive remount (session)", async () => {
    const { unmount } = mount();
    await screen.findByTestId("pdf-measure-svg");
    fireEvent.click(screen.getByTestId("pdf-measure-tool-length"));
    tap(0, 0);
    tap(100, 0);
    fireEvent.keyDown(window, { key: "Enter" });
    unmount();
    mount();
    await screen.findByTestId("pdf-measure-svg");
    expect(screen.getAllByTestId("pdf-measure-item")).toHaveLength(1);
    // page 2 has none and (calibration is page-1 only) is uncalibrated
    page = 2;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(screen.queryAllByTestId("pdf-measure-item")).toHaveLength(0);
    expect(screen.getByTestId("pdf-measure-scale-badge").getAttribute("data-scale-source")).toBe("none");
  });
});
