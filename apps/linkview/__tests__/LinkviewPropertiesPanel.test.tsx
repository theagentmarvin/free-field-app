// Regression (w68): clicking an element in the LinkView right pane must
// open the Models-style properties panel; empty-space click / Escape / ✕
// close it. Previously only a collapsed one-line bar rendered.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { useModelsToolStore, ViewerToolsProvider } from "@ff/viewer-tools";
import type { IfcViewerHandle } from "@ff/viewer-react";

// The workspace setup stubs @ff/viewer-react; the properties body needs
// this one helper.
vi.mock("@ff/viewer-react", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPropertyGroups: () => [],
}));

import { linkviewDataSource } from "../src/linkviewDataSource";
import LinkviewPropertiesPanel from "../src/LinkviewPropertiesPanel";

const renderPanel = (ref: RefObject<IfcViewerHandle>) =>
  render(
    <ViewerToolsProvider dataSource={linkviewDataSource}>
      <LinkviewPropertiesPanel viewerRef={ref} />
    </ViewerToolsProvider>,
  );

type PickCb = (e: { modelId: string; expressId: number } | null) => void;

function makeViewer() {
  let cb: PickCb | null = null;
  const handle = {
    setOnElementPick: vi.fn((c: PickCb | null) => {
      cb = c;
    }),
    getElementData: vi.fn(async () => ({
      "Pset_WallCommon.FireRating": "2HR",
      Name: "Wall A",
    })),
  };
  const ref = { current: handle } as unknown as RefObject<IfcViewerHandle>;
  return { ref, handle, pick: (e: Parameters<PickCb>[0]) => cb?.(e) };
}

describe("LinkviewPropertiesPanel", () => {
  beforeEach(() => {
    useModelsToolStore.getState().clearSelection();
  });

  it("is closed with no selection, subscribes to picks once", () => {
    const v = makeViewer();
    renderPanel(v.ref);
    expect(
      screen.getByTestId("linkview-properties-panel").getAttribute("data-open"),
    ).toBe("false");
    expect(v.handle.setOnElementPick).toHaveBeenCalledTimes(1);
  });

  it("a pick opens the panel with the properties body", async () => {
    const v = makeViewer();
    renderPanel(v.ref);
    await act(async () => {
      v.pick({ modelId: "m1", expressId: 42 });
    });
    expect(
      screen.getByTestId("linkview-properties-panel").getAttribute("data-open"),
    ).toBe("true");
    expect(await screen.findByTestId("properties-body")).toBeInTheDocument();
    expect(v.handle.getElementData).toHaveBeenCalledWith("m1", 42);
  });

  it("an empty-space pick (null) closes it", async () => {
    const v = makeViewer();
    renderPanel(v.ref);
    await act(async () => {
      v.pick({ modelId: "m1", expressId: 1 });
    });
    await act(async () => {
      v.pick(null);
    });
    expect(useModelsToolStore.getState().selection).toBeNull();
    expect(
      screen.getByTestId("linkview-properties-panel").getAttribute("data-open"),
    ).toBe("false");
  });

  it("Escape and the close button clear the selection", async () => {
    const v = makeViewer();
    renderPanel(v.ref);
    await act(async () => {
      v.pick({ modelId: "m1", expressId: 1 });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useModelsToolStore.getState().selection).toBeNull();
    await act(async () => {
      v.pick({ modelId: "m1", expressId: 2 });
    });
    fireEvent.click(screen.getByTestId("linkview-properties-panel-close"));
    expect(useModelsToolStore.getState().selection).toBeNull();
  });
});
