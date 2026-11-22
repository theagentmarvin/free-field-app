import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import CompareViewer from "../../src/compare/viewer/CompareViewer";
import { useCompareStore } from "../../src/compare/compareStore";
import { installCanvasStub, makeResult, sideA, sideB } from "./fixtures";

let restore: () => void;
beforeEach(() => {
  restore = installCanvasStub();
  useCompareStore.getState().close();
});
afterEach(() => restore());

function seed(mode: "side-by-side" | "overlay" | "changes") {
  act(() => {
    useCompareStore.setState({
      active: true,
      base: sideA,
      revision: sideB,
      resultSides: { base: sideA, revision: sideB },
      result: makeResult(),
      status: "done",
      mode,
    });
  });
}

describe("CompareViewer", () => {
  it("shows the empty prompt without sides", () => {
    act(() => useCompareStore.setState({ active: true }));
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-empty")).toHaveTextContent(
      "Pick a Base and a Revision to compare",
    );
  });

  it("side-by-side renders two labelled panes with region outlines on both", () => {
    seed("side-by-side");
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-pane-base-label")).toHaveTextContent(/^Base · v.* · p1$/);
    expect(screen.getByTestId("documents-compare-pane-revision-label")).toHaveTextContent(/^Revision · v.* · p1$/);
    expect(screen.getAllByTestId("documents-compare-regions")).toHaveLength(2);
    expect(screen.getByTestId("documents-compare-sync")).toBeInTheDocument();
  });

  it("overlay renders a single composite pane with layer controls", () => {
    seed("overlay");
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-pane-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-compare-pane-base")).toBeNull();
    expect(screen.getByTestId("documents-compare-layer-base")).toBeInTheDocument();
    expect(screen.queryByTestId("documents-compare-sync")).toBeNull();
    fireEvent.click(screen.getByTestId("documents-compare-layer-base"));
    expect(useCompareStore.getState().layerVisibility.base).toBe(false);
  });

  it("changes mode renders the dimmed revision with clickable regions", () => {
    seed("changes");
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-pane-changes")).toBeInTheDocument();
    expect(screen.getByTestId("documents-compare-canvas-changes").style.opacity).toBe("0.35");
    fireEvent.click(screen.getByTestId("documents-compare-region-2"));
    expect(useCompareStore.getState().selectedRegionId).toBe(2);
    expect(screen.getByTestId("documents-compare-region-2")).toHaveAttribute("data-selected", "true");
  });

  it("box style draws rects instead of cloud paths", () => {
    seed("changes");
    act(() => useCompareStore.getState().updateSettings({ highlightStyle: "box" }));
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-region-1").tagName.toLowerCase()).toBe("rect");
  });

  it("panning one pane moves both while synced, and only one when unlocked", () => {
    seed("side-by-side");
    render(<CompareViewer />);
    const base = screen.getByTestId("documents-compare-pane-base");
    const rev = screen.getByTestId("documents-compare-pane-revision");
    // jsdom has no PointerEvent: dispatch mouse events under the pointer names.
    const ptr = (el: HTMLElement, type: string, x: number, y: number) =>
      fireEvent(el, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    const drag = (el: HTMLElement) => {
      ptr(el, "pointerdown", 10, 10);
      ptr(el, "pointermove", 30, 25);
      ptr(el, "pointerup", 30, 25);
    };
    drag(base);
    expect(base.dataset.tx).toBe(rev.dataset.tx);
    expect(base.dataset.tx).toBe("20.00");

    fireEvent.click(screen.getByTestId("documents-compare-sync"));
    expect(useCompareStore.getState().syncViews).toBe(false);
    drag(rev);
    expect(rev.dataset.tx).toBe("40.00");
    expect(base.dataset.tx).toBe("20.00");
  });

  it("wheel zooms; [ and ] step regions; keys are ignored in inputs", () => {
    seed("changes");
    render(<CompareViewer />);
    const pane = screen.getByTestId("documents-compare-pane-changes");
    fireEvent.wheel(pane, { deltaY: -200, clientX: 0, clientY: 0 });
    expect(Number(pane.dataset.scale)).toBeGreaterThan(1);

    fireEvent.keyDown(document.body, { key: "]" });
    expect(useCompareStore.getState().selectedRegionId).toBe(1);
    fireEvent.keyDown(document.body, { key: "[" });
    expect(useCompareStore.getState().selectedRegionId).toBe(3);

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "]" });
    expect(useCompareStore.getState().selectedRegionId).toBe(3);
    input.remove();

    fireEvent.keyDown(screen.getByTestId("documents-compare-viewer"), { key: "Escape" });
    expect(useCompareStore.getState().selectedRegionId).toBeNull();
  });

  it("shows loading and error states", () => {
    seed("changes");
    act(() => useCompareStore.setState({ status: "running", progress: { stage: "rendering", fraction: 0.4 } }));
    const { unmount } = render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-loading")).toHaveTextContent("Rendering… 40%");
    unmount();
    act(() => useCompareStore.setState({ status: "error", error: "bad pdf" }));
    render(<CompareViewer />);
    expect(screen.getByTestId("documents-compare-viewer-error")).toHaveTextContent("bad pdf");
  });
});
