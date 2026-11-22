// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { getTaskOpenState, requestTaskOpen, resetTaskOpenStore } from "@ff/tasks-react";

import { useLinkviewTaskOpen } from "../src/useLinkviewTaskOpen";

function Probe(props: {
  overlayRef: RefObject<never>;
  viewerRef: RefObject<never>;
  buildingId: string | null;
  activeVersionId: string | null;
  open: (versionId: string) => void;
  settled?: boolean;
}) {
  useLinkviewTaskOpen({
    overlayRef: props.overlayRef as never,
    viewerRef: props.viewerRef as never,
    activeBuildingId: props.buildingId,
    activePdfVersionId: props.activeVersionId,
    openVersion: props.open,
    cameraSettled: props.settled ?? true,
  });
  return null;
}

function overlay() {
  return {
    getAnnotationLayer: () => document.createElement("div"),
    getDocument: () => ({}),
    getCurrentPage: vi.fn(() => 1),
    goToPage: vi.fn(),
    focusUv: vi.fn(),
  };
}
function viewer(loaded: string[] = ["m1"]) {
  return {
    loadedModelIds: new Set(loaded),
    setViewPose: vi.fn(),
    selectElement: vi.fn(),
  };
}

const pose = { pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false };
const intent = {
  kind: "linkview" as const,
  taskId: "t1",
  buildingId: "bA",
  documents: { pdfFileId: "p1", versionId: "p1v2", page: 1, uv: [0.25, 0.5] as [number, number] },
  models: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: pose },
};

describe("useLinkviewTaskOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTaskOpenStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens the sheet, zooms to the pin, highlights it, restores the camera and selects the element", () => {
    const o = overlay();
    const v = viewer();
    const open = vi.fn();
    const oref = { current: o } as unknown as RefObject<never>;
    const vref = { current: v } as unknown as RefObject<never>;
    const { rerender } = render(<Probe overlayRef={oref} viewerRef={vref} buildingId="bA" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(open).toHaveBeenCalledWith("p1v2");
    expect(getTaskOpenState().intent).toBeNull();
    expect(getTaskOpenState().highlightTaskId).toBe("t1");
    rerender(<Probe overlayRef={oref} viewerRef={vref} buildingId="bA" activeVersionId="p1v2" open={open} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(o.focusUv).toHaveBeenCalledWith([0.25, 0.5], expect.any(Number));
    expect(v.setViewPose).toHaveBeenCalledWith(pose, expect.anything());
    expect(v.selectElement).toHaveBeenCalledWith("m1", 7);
  });

  it("waits for the target building before taking the intent", () => {
    const open = vi.fn();
    const refs = { overlayRef: { current: overlay() } as never, viewerRef: { current: viewer() } as never };
    const { rerender } = render(<Probe {...refs} buildingId="other" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(open).not.toHaveBeenCalled();
    rerender(<Probe {...refs} buildingId="bA" activeVersionId={null} open={open} />);
    expect(open).toHaveBeenCalledWith("p1v2");
  });

  it("does not move the camera until LinkView has seeded it for the sheet", () => {
    const v = viewer();
    const refs = { overlayRef: { current: overlay() } as never, viewerRef: { current: v } as never };
    const { rerender } = render(<Probe {...refs} buildingId="bA" activeVersionId="p1v2" open={vi.fn()} settled={false} />);
    act(() => {
      requestTaskOpen(intent);
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(v.setViewPose).not.toHaveBeenCalled();
    rerender(<Probe {...refs} buildingId="bA" activeVersionId="p1v2" open={vi.fn()} settled />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(v.setViewPose).toHaveBeenCalledTimes(1);
  });

  it("waits for the model to load before selecting", () => {
    const v = viewer([]);
    const refs = { overlayRef: { current: overlay() } as never, viewerRef: { current: v } as never };
    render(<Probe {...refs} buildingId="bA" activeVersionId="p1v2" open={vi.fn()} />);
    act(() => {
      requestTaskOpen(intent);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(v.selectElement).not.toHaveBeenCalled();
    v.loadedModelIds.add("m1");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(v.selectElement).toHaveBeenCalledWith("m1", 7);
  });

  it("applies only the 3D half when the sheet is gone", () => {
    const v = viewer();
    const o = overlay();
    const open = vi.fn();
    render(<Probe overlayRef={{ current: o } as never} viewerRef={{ current: v } as never} buildingId="bA" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen({ ...intent, documents: null });
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(open).not.toHaveBeenCalled();
    expect(o.focusUv).not.toHaveBeenCalled();
    expect(v.selectElement).toHaveBeenCalled();
  });

  it("ignores Models / Documents intents", () => {
    const open = vi.fn();
    render(<Probe overlayRef={{ current: overlay() } as never} viewerRef={{ current: viewer() } as never} buildingId="bA" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen({ kind: "documents", taskId: "t", buildingId: "bA", pdfFileId: "p", versionId: "v", page: 1, uv: null });
    });
    expect(open).not.toHaveBeenCalled();
    expect(getTaskOpenState().intent).not.toBeNull();
  });
});
