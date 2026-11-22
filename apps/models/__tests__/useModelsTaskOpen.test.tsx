// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { createObservableRef } from "@ff/viewer-tools";

// The package barrel pulls in the full viewer (WebGL stack); the hook only
// needs the tiny handle hooks, so load just those.
vi.mock("@ff/viewer-tools", async () => await import("../../../packages/ff-viewer-tools/src/hooks/useViewerHandle"));
import { getTaskOpenState, requestTaskOpen, resetTaskOpenStore } from "@ff/tasks-react";

import { useModelsTaskOpen } from "../src/useModelsTaskOpen";

const pose = { pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false };

function Probe({ viewerRef, buildingId }: { viewerRef: RefObject<never>; buildingId: string | null }) {
  useModelsTaskOpen(viewerRef as never, buildingId);
  return null;
}

function handleWith(loaded: string[]) {
  return {
    loadedModelIds: new Set(loaded),
    setViewPose: vi.fn(),
    selectElement: vi.fn(),
  };
}

const intent = {
  kind: "models" as const,
  taskId: "t1",
  buildingId: "bA",
  elements: [{ modelId: "m1", expressId: 7 }],
  worldPoint: [1, 2, 3] as [number, number, number],
  cameraPose: pose,
};

describe("useModelsTaskOpen", () => {
  beforeEach(() => {
    resetTaskOpenStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("restores the saved camera and selects the element once the model is loaded, without remounting", () => {
    const ref = createObservableRef<ReturnType<typeof handleWith>>();
    const h = handleWith(["m1"]);
    (ref as unknown as { current: unknown }).current = h;
    render(<Probe viewerRef={ref as never} buildingId="bA" />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(h.setViewPose).toHaveBeenCalledWith(pose, { animate: true });
    expect(h.selectElement).toHaveBeenCalledWith("m1", 7);
    expect(getTaskOpenState().intent).toBeNull();
  });

  it("old task without a camera only selects the element", () => {
    const ref = createObservableRef<ReturnType<typeof handleWith>>();
    const h = handleWith(["m1"]);
    (ref as unknown as { current: unknown }).current = h;
    render(<Probe viewerRef={ref as never} buildingId="bA" />);
    act(() => {
      requestTaskOpen({ ...intent, cameraPose: null });
    });
    expect(h.setViewPose).not.toHaveBeenCalled();
    expect(h.selectElement).toHaveBeenCalledWith("m1", 7);
  });

  it("waits for the target building to be active", () => {
    const ref = createObservableRef<ReturnType<typeof handleWith>>();
    const h = handleWith(["m1"]);
    (ref as unknown as { current: unknown }).current = h;
    const { rerender } = render(<Probe viewerRef={ref as never} buildingId="bOther" />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(h.selectElement).not.toHaveBeenCalled();
    expect(getTaskOpenState().intent).not.toBeNull();
    rerender(<Probe viewerRef={ref as never} buildingId="bA" />);
    expect(h.selectElement).toHaveBeenCalledWith("m1", 7);
  });

  it("waits until the model is loaded", () => {
    vi.useFakeTimers();
    const ref = createObservableRef<ReturnType<typeof handleWith>>();
    const h = handleWith([]);
    (ref as unknown as { current: unknown }).current = h;
    render(<Probe viewerRef={ref as never} buildingId="bA" />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(h.selectElement).not.toHaveBeenCalled();
    h.loadedModelIds.add("m1");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(h.selectElement).toHaveBeenCalledWith("m1", 7);
  });

  it("ignores documents intents", () => {
    const ref = createObservableRef<ReturnType<typeof handleWith>>();
    const h = handleWith(["m1"]);
    (ref as unknown as { current: unknown }).current = h;
    render(<Probe viewerRef={ref as never} buildingId="bA" />);
    act(() => {
      requestTaskOpen({ kind: "documents", taskId: "t", buildingId: "bA", pdfFileId: "p", versionId: "v", page: 1, uv: null });
    });
    expect(h.selectElement).not.toHaveBeenCalled();
    expect(getTaskOpenState().intent?.kind).toBe("documents");
  });
});
