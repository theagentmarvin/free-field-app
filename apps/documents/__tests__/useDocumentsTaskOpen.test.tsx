// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { getTaskOpenState, requestTaskOpen, resetTaskOpenStore } from "@ff/tasks-react";

import { useDocumentsTaskOpen } from "../src/useDocumentsTaskOpen";

function Probe(props: {
  overlayRef: RefObject<never>;
  buildingId: string | null;
  activeVersionId: string | null;
  open: (versionId: string) => void;
}) {
  useDocumentsTaskOpen(props.overlayRef as never, props.buildingId, props.activeVersionId, props.open);
  return null;
}

function overlay(ready = true) {
  return {
    getAnnotationLayer: () => (ready ? document.createElement("div") : null),
    getDocument: () => (ready ? {} : null),
    getCurrentPage: vi.fn(() => 1),
    goToPage: vi.fn(),
    focusUv: vi.fn(),
  };
}

const intent = {
  kind: "documents" as const,
  taskId: "t1",
  buildingId: "bA",
  pdfFileId: "p1",
  versionId: "p1v2",
  page: 2,
  uv: [0.25, 0.5] as [number, number],
};

describe("useDocumentsTaskOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTaskOpenStore();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens the sheet version, then goes to the page, zooms to the pin and highlights it", () => {
    const o = overlay();
    const open = vi.fn();
    const ref = { current: o } as unknown as RefObject<never>;
    const { rerender } = render(<Probe overlayRef={ref} buildingId="bA" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(open).toHaveBeenCalledWith("p1v2");
    expect(getTaskOpenState().intent).toBeNull();
    expect(getTaskOpenState().highlightTaskId).toBe("t1");
    // the viewer opened that version
    rerender(<Probe overlayRef={ref} buildingId="bA" activeVersionId="p1v2" open={open} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(o.goToPage).toHaveBeenCalledWith(2);
    expect(o.focusUv).toHaveBeenCalledWith([0.25, 0.5], expect.any(Number));
  });

  it("does not open until the target building is active", () => {
    const open = vi.fn();
    const ref = { current: overlay() } as unknown as RefObject<never>;
    const { rerender } = render(<Probe overlayRef={ref} buildingId="bOther" activeVersionId={null} open={open} />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(open).not.toHaveBeenCalled();
    rerender(<Probe overlayRef={ref} buildingId="bA" activeVersionId={null} open={open} />);
    expect(open).toHaveBeenCalledWith("p1v2");
  });

  it("waits for the overlay to be ready before focusing", () => {
    const o = overlay(false);
    const ref = { current: o } as unknown as RefObject<never>;
    render(<Probe overlayRef={ref} buildingId="bA" activeVersionId="p1v2" open={vi.fn()} />);
    act(() => {
      requestTaskOpen(intent);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(o.focusUv).not.toHaveBeenCalled();
    o.getAnnotationLayer = () => document.createElement("div");
    o.getDocument = () => ({});
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(o.focusUv).toHaveBeenCalled();
  });

  it("clears the pin highlight after a while", () => {
    const ref = { current: overlay() } as unknown as RefObject<never>;
    render(<Probe overlayRef={ref} buildingId="bA" activeVersionId="p1v2" open={vi.fn()} />);
    act(() => {
      requestTaskOpen(intent);
    });
    expect(getTaskOpenState().highlightTaskId).toBe("t1");
    act(() => {
      vi.advanceTimersByTime(12000);
    });
    expect(getTaskOpenState().highlightTaskId).toBeNull();
  });
});
