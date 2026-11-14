// @vitest-environment jsdom
import type { RefObject } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IfcViewerHandle } from "@ff/viewer-react";

// Wave 47 — right-click selection context toolbar seams. The heavy
// viewer/data/tasks barrels stay stubbed; only the local pure helpers,
// the real <SelectionContextToolbar> markup + the real tool-mode store
// run. The handle mock records `addSectionPlane` calls and captures the
// `onSelectionChange` subscription. Wave 48: hide/isolate/show-all and
// category ops update the manual-visibility overlay store (mocked here),
// NOT `setElementVisibility`. Wave 49: the handle mock also tracks the
// live section-plane count (`getSectionPlaneCount` /
// `clearSectionPlanes`) and the split-button dropdown is asserted to
// render INSIDE its group, absolutely positioned below it.

const viewerToolsMocks = vi.hoisted(() => ({
  editingPresetId: null as string | null,
  propertyIndices: new Map() as Map<string, Map<string, Map<string, Set<number>>>>,
  propertyAllIds: new Map() as Map<string, Set<number>>,
  manualHideCalls: [] as Array<[string, Set<number>]>,
  manualIsolateCalls: [] as Array<Map<string, Set<number>>>,
  manualShowAllCalls: 0,
}));

vi.mock("@ff/tasks-react", () => ({
  tokens: {
    color: {
      surface: "#ffffff",
      surface2: "#fafbfc",
      border: "#e7e9ec",
      borderStrong: "#d6dbe1",
      primary: "#181c22",
      onPrimary: "#ffffff",
      text: "#1b1f24",
      text2: "#5b626b",
      muted: "#8a919c",
      focusRing: "#2f6fe4",
      focusRingTint: "rgba(47,111,228,0.08)",
      focusRingLine: "rgba(47,111,228,0.22)",
      focusRingInk: "#2a5bb8",
      danger: "#d64545",
    },
    radius: { md: 12, pill: 999 },
    space: { s2: 8 },
    fontSize: { sm: 12, md: 13 },
    font: "system-ui, sans-serif",
    shadow: { popup: "0 -10px 30px rgba(16,24,40,0.22)" },
  },
}));

vi.mock("@ff/viewer-tools", () => ({
  useModelsToolStore: (selector: (s: { editingPresetId: string | null }) => unknown) =>
    selector({ editingPresetId: viewerToolsMocks.editingPresetId }),
  usePropertyIndexStore: {
    getState: () => ({
      indices: viewerToolsMocks.propertyIndices,
      allLocalIds: viewerToolsMocks.propertyAllIds,
    }),
  },
  useManualVisibilityStore: {
    getState: () => ({
      hideIds: (modelId: string, ids: ReadonlySet<number>) => {
        viewerToolsMocks.manualHideCalls.push([modelId, new Set(ids)]);
      },
      isolateTo: (map: ReadonlyMap<string, ReadonlySet<number>>) => {
        viewerToolsMocks.manualIsolateCalls.push(
          new Map(Array.from(map, ([k, v]) => [k, new Set(v)])),
        );
      },
      showAll: () => {
        viewerToolsMocks.manualShowAllCalls += 1;
      },
      clearModel: () => undefined,
    }),
  },
}));

import SelectionContextToolbar from "../src/SelectionContextToolbar";
import { useViewerToolModeStore } from "../src/viewerToolModeStore";

function setRect(el: HTMLElement, rect: Partial<DOMRect>): void {
  const full: DOMRect = {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    right: rect.right ?? 0,
    bottom: rect.bottom ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    toJSON: () => ({}),
  };
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => full,
    configurable: true,
  });
}

function makeWrapper(width = 800, height = 600): {
  el: HTMLDivElement;
  ref: RefObject<HTMLDivElement | null>;
} {
  const el = document.createElement("div");
  document.body.appendChild(el);
  setRect(el, { left: 0, top: 0, width, height });
  const ref = { current: el } as RefObject<HTMLDivElement | null>;
  return { el, ref };
}

function makeHandle() {
  let selection = new Map<string, Set<number>>();
  let allIds = new Map<string, number[]>();
  let activeTool: "navigation" | "measure" | null = null;
  let worldPoint: { x: number; y: number; z: number } | null = null;
  let worldCenter: { x: number; y: number; z: number } | null = null;
  let worldNormal: { x: number; y: number; z: number } | null = null;
  let elementData: Record<string, string> | null = null;
  let sectionPlaneCount = 0;
  let pose: {
    pos: [number, number, number];
    target: [number, number, number];
    fov: number;
    isOrtho: boolean;
  } = { pos: [0, 0, 10], target: [0, 0, 0], fov: 45, isOrtho: false };
  let selectionCb: ((sel: ReadonlyMap<string, ReadonlySet<number>>) => void) | null = null;

  const setElementVisibility = vi.fn();
  const getSelection = vi.fn(() => selection);
  const getAllModelExpressIds = vi.fn(async () => allIds);
  const getElementData = vi.fn(async () => elementData);
  const getSelectionWorldPoint = vi.fn(() => worldPoint);
  const getSelectionWorldCenter = vi.fn(async () => worldCenter);
  const getSelectionWorldNormal = vi.fn(() => worldNormal);
  const addSectionPlane = vi.fn(() => true);
  const getSectionPlaneCount = vi.fn(() => sectionPlaneCount);
  const clearSectionPlanes = vi.fn(() => {
    sectionPlaneCount = 0;
  });
  const onSelectionChange = vi.fn(
    (cb: ((sel: ReadonlyMap<string, ReadonlySet<number>>) => void) | null) => {
      selectionCb = cb;
    },
  );
  const getPose = vi.fn(() => pose);

  const asHandle = (): IfcViewerHandle =>
    ({
      activeTool,
      getSelection,
      getAllModelExpressIds,
      getElementData,
      getSelectionWorldPoint,
      getSelectionWorldCenter,
      getSelectionWorldNormal,
      addSectionPlane,
      getSectionPlaneCount,
      clearSectionPlanes,
      onSelectionChange,
      setElementVisibility,
      getPose,
    }) as unknown as IfcViewerHandle;

  return {
    asHandle,
    setSelection: (next: Map<string, Set<number>>) => {
      selection = next;
    },
    setAllIds: (next: Map<string, number[]>) => {
      allIds = next;
    },
    setActiveTool: (t: "navigation" | "measure" | null) => {
      activeTool = t;
    },
    setWorldPoint: (p: { x: number; y: number; z: number } | null) => {
      worldPoint = p;
    },
    setWorldCenter: (c: { x: number; y: number; z: number } | null) => {
      worldCenter = c;
    },
    setWorldNormal: (n: { x: number; y: number; z: number } | null) => {
      worldNormal = n;
    },
    setPose: (
      p: {
        pos: [number, number, number];
        target: [number, number, number];
        fov: number;
        isOrtho: boolean;
      },
    ) => {
      pose = p;
    },
    setElementData: (d: Record<string, string> | null) => {
      elementData = d;
    },
    setSectionPlaneCount: (n: number) => {
      sectionPlaneCount = n;
    },
    getSelectionCb: () => selectionCb,
    setElementVisibility,
    getSelection,
    getAllModelExpressIds,
    getElementData,
    getSelectionWorldPoint,
    getSelectionWorldCenter,
    getSelectionWorldNormal,
    addSectionPlane,
    getSectionPlaneCount,
    clearSectionPlanes,
    getPose,
  };
}

function renderToolbar() {
  const h = makeHandle();
  const wrapper = makeWrapper();
  const view = render(
    <SelectionContextToolbar
      getHandle={() => h.asHandle()}
      wrapperRef={wrapper.ref}
    />,
  );
  return { h, ...wrapper, ...view };
}

describe("<SelectionContextToolbar>", () => {
  beforeEach(() => {
    useViewerToolModeStore.setState({ mode: "navigation", sectionRev: 0 });
    viewerToolsMocks.editingPresetId = null;
    viewerToolsMocks.propertyIndices = new Map();
    viewerToolsMocks.propertyAllIds = new Map();
    viewerToolsMocks.manualHideCalls = [];
    viewerToolsMocks.manualIsolateCalls = [];
    viewerToolsMocks.manualShowAllCalls = 0;
  });

  it("opens at the clamped cursor position and suppresses the native menu", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());

    const ctxEvents: MouseEvent[] = [];
    el.addEventListener("contextmenu", (e) => {
      ctxEvents.push(e);
    });

    fireEvent.contextMenu(el, { clientX: 900, clientY: 700 });

    expect(ctxEvents[0]?.defaultPrevented).toBe(true);
    const toolbar = screen.getByTestId("selection-context-toolbar");
    // width 800, toolbar 250 (wave-51 width: the standalone clear-section
    // button is gone, the section control is a split group) → maxX 544;
    // height 600, toolbar 48 → maxY 546.
    expect(toolbar.style.left).toBe("544px");
    expect(toolbar.style.top).toBe("546px");
  });

  it("clamps near the top-left edge to the inset margin", () => {
    const { el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 0, clientY: 0 });
    const toolbar = screen.getByTestId("selection-context-toolbar");
    expect(toolbar.style.left).toBe("6px");
    expect(toolbar.style.top).toBe("6px");
  });

  it("empty selection → only show-all enabled; other buttons disabled", () => {
    const { el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    expect(
      screen.getByTestId("sct-show-all").getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("sct-element-split").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByTestId("sct-category-split").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByTestId("sct-section-plane").getAttribute("aria-disabled"),
    ).toBe("true");
    // Wave 51 — the clear-section action moved INTO the section split
    // button's dropdown; it is disabled while there are no section
    // planes (independent of the selection).
    fireEvent.click(screen.getByTestId("sct-section-caret"));
    expect(
      screen.getByTestId("sct-clear-section").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("non-empty selection → all groups enabled; caret opens both actions", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1, 2])]]));
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    expect(
      screen.getByTestId("sct-element-split").getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      screen.getByTestId("sct-section-plane").getAttribute("aria-disabled"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("sct-element-caret"));
    expect(screen.getByTestId("sct-isolate-selected")).toBeInTheDocument();
    expect(screen.getByTestId("sct-hide-selected")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sct-category-caret"));
    expect(screen.getByTestId("sct-isolate-category")).toBeInTheDocument();
    expect(screen.getByTestId("sct-hide-category")).toBeInTheDocument();

    // Wave 51 — the section group is a split button too: the caret
    // opens the create/remove dropdown.
    fireEvent.click(screen.getByTestId("sct-section-caret"));
    expect(screen.getByTestId("sct-create-section")).toBeInTheDocument();
    expect(screen.getByTestId("sct-clear-section")).toBeInTheDocument();
  });

  it("hide selected → overlay hideIds (not setElementVisibility)", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1, 2])]]));
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-element-caret"));
    fireEvent.click(screen.getByTestId("sct-hide-selected"));

    expect(viewerToolsMocks.manualHideCalls).toEqual([
      ["m1", new Set([1, 2])],
    ]);
    expect(h.setElementVisibility).not.toHaveBeenCalled();
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("isolate selected → overlay isolateTo(selection snapshot)", () => {
    const { h, el } = renderToolbar();
    h.setSelection(
      new Map([
        ["m1", new Set([2])],
        ["m2", new Set([9])],
      ]),
    );
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-element-split"));

    expect(viewerToolsMocks.manualIsolateCalls).toEqual([
      new Map([
        ["m1", new Set([2])],
        ["m2", new Set([9])],
      ]),
    ]);
    expect(h.getAllModelExpressIds).not.toHaveBeenCalled();
    expect(h.setElementVisibility).not.toHaveBeenCalled();
  });

  it("hide category → resolves class from index and hideIds per model", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([5])]]));
    viewerToolsMocks.propertyIndices = new Map([
      ["m1", new Map([["_IfcClass", new Map([["IFCWALL", new Set([5, 6])]])]])],
      ["m2", new Map([["_IfcClass", new Map([["IFCWALL", new Set([20])]])]])],
    ]);
    viewerToolsMocks.propertyAllIds = new Map([
      ["m1", new Set([5, 6, 7])],
      ["m2", new Set([20, 21])],
    ]);
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-category-caret"));
    fireEvent.click(screen.getByTestId("sct-hide-category"));

    await waitFor(() => {
      expect(viewerToolsMocks.manualHideCalls.length).toBeGreaterThan(0);
    });
    expect(viewerToolsMocks.manualHideCalls).toEqual([
      ["m1", new Set([5, 6])],
      ["m2", new Set([20])],
    ]);
  });

  it("isolate category → isolateTo(class map) across models", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([5])]]));
    viewerToolsMocks.propertyIndices = new Map([
      ["m1", new Map([["_IfcClass", new Map([["IFCWALL", new Set([5, 6])]])]])],
      ["m2", new Map([["_IfcClass", new Map([["IFCWALL", new Set([20])]])]])],
    ]);
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-category-caret"));
    fireEvent.click(screen.getByTestId("sct-isolate-category"));

    await waitFor(() => {
      expect(viewerToolsMocks.manualIsolateCalls.length).toBeGreaterThan(0);
    });
    expect(viewerToolsMocks.manualIsolateCalls[0]).toEqual(
      new Map([
        ["m1", new Set([5, 6])],
        ["m2", new Set([20])],
      ]),
    );
  });

  it("category fallback: empty index → resolves class via getElementData and applies", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([9])]]));
    h.setElementData({ _category: "IFCWALL" });
    viewerToolsMocks.propertyIndices = new Map();
    viewerToolsMocks.propertyAllIds = new Map([
      ["m1", new Set([9, 10])],
    ]);
    // A second model has an index for the same class so we can assert a real op.
    viewerToolsMocks.propertyIndices = new Map([
      ["m2", new Map([["_IfcClass", new Map([["IFCWALL", new Set([30])]])]])],
    ]);
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-category-caret"));
    fireEvent.click(screen.getByTestId("sct-hide-category"));

    await waitFor(() => expect(h.getElementData).toHaveBeenCalledWith("m1", 9));
    await waitFor(() => {
      expect(viewerToolsMocks.manualHideCalls.length).toBeGreaterThan(0);
    });
    // m1 has no class index → no op for m1; m2 hides its class ids.
    expect(viewerToolsMocks.manualHideCalls).toEqual([["m2", new Set([30])]]);
  });

  it("show all → overlay showAll()", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-show-all"));

    expect(viewerToolsMocks.manualShowAllCalls).toBe(1);
    expect(h.setElementVisibility).not.toHaveBeenCalled();
  });

  it("section plane → face normal present → flipped normal passed", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    h.setWorldPoint({ x: 1, y: 2, z: 3 });
    h.setWorldNormal({ x: 1, y: 0, z: 0 });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-plane"));

    await waitFor(() => expect(h.addSectionPlane).toHaveBeenCalled());
    // Face normal (1,0,0) flipped to cut toward the camera.
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 1, y: 2, z: 3 },
      { x: -1, y: 0, z: 0 },
    );
    expect(useViewerToolModeStore.getState().sectionRev).toBe(1);
  });

  it("section plane → no face normal → bbox-face snap (axis-aligned)", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    h.setWorldPoint({ x: 1, y: 2, z: 3 });
    // Non-axis-aligned camera direction (0.8, 0.6, 0).
    h.setPose({ pos: [-0.8, -0.6, 0], target: [0, 0, 0], fov: 45, isOrtho: false });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-plane"));

    await waitFor(() => expect(h.addSectionPlane).toHaveBeenCalled());
    // Snaps to the nearest axis-aligned bbox face (x-dominant).
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 1, y: 2, z: 3 },
      { x: 1, y: 0, z: 0 },
    );
  });

  it("section plane → axis-aligned camera direction fallback", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    h.setWorldPoint({ x: 1, y: 2, z: 3 });
    // cameraDirectionFromPose = (target - eye) = (0,0,-1).
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-plane"));

    await waitFor(() => expect(h.addSectionPlane).toHaveBeenCalled());
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 1, y: 2, z: 3 },
      { x: 0, y: 0, z: -1 },
    );
  });

  it("section plane → falls back to getSelectionWorldCenter when point null", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    h.setWorldPoint(null);
    h.setWorldCenter({ x: 4, y: 5, z: 6 });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-plane"));

    await waitFor(() => expect(h.addSectionPlane).toHaveBeenCalled());
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 4, y: 5, z: 6 },
      { x: 0, y: 0, z: -1 },
    );
  });

  it("clear section planes → disabled with 0 planes, enabled with cuts", () => {
    const { h, el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    // Wave 51 — the clear action lives inside the section dropdown.
    fireEvent.click(screen.getByTestId("sct-section-caret"));
    const btn = screen.getByTestId("sct-clear-section");
    expect(btn.getAttribute("aria-label")).toBe("Remove section planes");
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    // Re-open with live cuts → the open-time snapshot enables it.
    h.setSectionPlaneCount(2);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-caret"));
    expect(
      screen.getByTestId("sct-clear-section").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("clear section planes → disabled button is a no-op", () => {
    const { h, el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByTestId("sct-section-caret"));
    fireEvent.click(screen.getByTestId("sct-clear-section"));

    expect(h.clearSectionPlanes).not.toHaveBeenCalled();
    expect(useViewerToolModeStore.getState().sectionRev).toBe(0);
    // Still open (no dismissal, no state change).
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();
  });

  it("clear section planes → click clears the planes, bumps sectionRev and dismisses", () => {
    const { h, el } = renderToolbar();
    h.setSectionPlaneCount(3);
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByTestId("sct-section-caret"));
    fireEvent.click(screen.getByTestId("sct-clear-section"));

    expect(h.clearSectionPlanes).toHaveBeenCalledTimes(1);
    expect(useViewerToolModeStore.getState().sectionRev).toBe(1);
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("clear section planes → enabled state refreshes when sectionRev bumps while open", () => {
    const { h, el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-section-caret"));
    expect(
      screen.getByTestId("sct-clear-section").getAttribute("aria-disabled"),
    ).toBe("true");

    h.setSectionPlaneCount(1);
    act(() => {
      useViewerToolModeStore.getState().bumpSectionRev();
    });

    expect(
      screen.getByTestId("sct-clear-section").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("wave 51: section control is ONE split button — create primary + caret dropdown", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    const group = screen.getByRole("group", { name: "Section tools" });
    const primary = screen.getByTestId("sct-section-plane");
    const caret = screen.getByTestId("sct-section-caret");

    // Both halves live in the SAME group pill (like element/category).
    expect(group).toContainElement(primary);
    expect(group).toContainElement(caret);
    expect(group.style.borderRadius).toBe("10px");
    expect(group.style.position).toBe("relative");
    expect(primary.getAttribute("aria-label")).toBe("Create section plane");
    expect(caret.getAttribute("aria-label")).toBe("More section tools");
    expect(caret.getAttribute("aria-haspopup")).toBe("menu");
    expect(caret.getAttribute("aria-expanded")).toBe("false");

    // The standalone remove button is gone from the row.
    expect(screen.queryAllByTestId("sct-clear-section")).toHaveLength(0);

    // The dropdown opens from the caret and renders INSIDE the group.
    fireEvent.click(caret);
    const menu = screen.getByTestId("selection-context-toolbar-menu");
    expect(menu.parentElement).toBe(group);
    expect(menu.getAttribute("aria-label")).toBe("Section tools");
    expect(screen.getByTestId("sct-create-section")).toBeInTheDocument();
    expect(screen.getByTestId("sct-clear-section")).toBeInTheDocument();
    expect(caret.getAttribute("aria-expanded")).toBe("true");
  });

  it("wave 51: create section plane is reachable from the dropdown item too", async () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    h.setWorldPoint({ x: 1, y: 2, z: 3 });
    h.setWorldNormal({ x: 1, y: 0, z: 0 });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByTestId("sct-section-caret"));
    const item = screen.getByTestId("sct-create-section");
    expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item);

    await waitFor(() => expect(h.addSectionPlane).toHaveBeenCalled());
    expect(h.addSectionPlane).toHaveBeenCalledWith(
      { x: 1, y: 2, z: 3 },
      { x: -1, y: 0, z: 0 },
    );
    expect(useViewerToolModeStore.getState().sectionRev).toBe(1);
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("wave 51: the dropdown create item is a no-op without a selection", () => {
    const { h, el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByTestId("sct-section-caret"));
    const item = screen.getByTestId("sct-create-section");
    expect(item.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(item);
    expect(h.addSectionPlane).not.toHaveBeenCalled();
    expect(useViewerToolModeStore.getState().sectionRev).toBe(0);
  });

  it("split dropdown renders inside its group, below it, aligned to the group's right edge", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    fireEvent.click(screen.getByTestId("sct-element-caret"));

    const menu = screen.getByTestId("selection-context-toolbar-menu");
    const group = screen.getByRole("group", { name: "Element tools" });

    // The dropdown lives INSIDE the group container (the anchor).
    expect(menu.parentElement).toBe(group);
    expect(group.style.position).toBe("relative");
    expect(menu.style.position).toBe("absolute");
    expect(menu.style.top).toBe("calc(100% + 6px)");
    expect(menu.style.right).toBe("0px");
    // The toolbar shell must not clip the dropdown.
    expect(
      screen.getByTestId("selection-context-toolbar").style.overflow,
    ).toBe("visible");
  });

  it("split group paints the shared gray pill on hover and while its menu is open", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map([["m1", new Set([1])]]));
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });

    const group = screen.getByRole("group", { name: "Element tools" });
    expect(group.style.background).toBe("transparent");
    expect(group.style.borderRadius).toBe("10px");

    fireEvent.mouseOver(group);
    expect(group.style.background).toBe("rgba(47, 111, 228, 0.08)");

    fireEvent.mouseOut(group);
    expect(group.style.background).toBe("transparent");

    // Open menu → the pill stays painted.
    fireEvent.click(screen.getByTestId("sct-element-caret"));
    expect(group.style.background).toBe("rgba(47, 111, 228, 0.08)");

    // No vertical divider line on the caret anymore.
    const caret = screen.getByTestId("sct-element-caret");
    expect(caret.style.borderLeft).toBe("");
    expect(caret.style.background).toBe("transparent");
  });

  it("Esc dismisses the toolbar", () => {
    const { el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("outside pointerdown dismisses the toolbar", () => {
    const { el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("canvas/wrapper pointerdown dismisses the toolbar", () => {
    const { el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();

    fireEvent.pointerDown(el);
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("selection change dismisses the toolbar", () => {
    const { h, el } = renderToolbar();
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();

    act(() => {
      h.getSelectionCb()?.(new Map());
    });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("suppressed while measure or section mode is active", () => {
    const { h, el } = renderToolbar();

    act(() => {
      useViewerToolModeStore.getState().setMode("measure");
    });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();

    act(() => {
      useViewerToolModeStore.getState().setMode("section");
    });
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();

    // handle.activeTool === "measure" also suppresses.
    act(() => {
      useViewerToolModeStore.getState().setMode("navigation");
    });
    h.setActiveTool("measure");
    fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });
});
// ── Wave 54 — mobile long-press (touch-only 500ms hold) ────────────────
// jsdom has no PointerEvent constructor, so fireEvent.pointerDown would
// produce a bare Event without pointerType/clientX. Dispatch a MouseEvent
// named "pointerdown|pointermove|pointerup" and define pointerType on it —
// the component's listeners only read type, pointerType, and client coords.
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { pointerType: string; clientX?: number; clientY?: number; button?: number },
): void {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(ev, "pointerType", { value: init.pointerType });
  el.dispatchEvent(ev);
}

describe("<SelectionContextToolbar> wave 54 — mobile long-press", () => {
  beforeEach(() => {
    useViewerToolModeStore.setState({ mode: "navigation", sectionRev: 0 });
    viewerToolsMocks.editingPresetId = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stationary 500ms touch hold opens the toolbar at the hold point", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(500);
    });
    const toolbar = screen.getByTestId("selection-context-toolbar");
    expect(toolbar.style.left).toBe("100px");
    expect(toolbar.style.top).toBe("100px");
  });

  it("lifting the finger before 500ms does not open", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(300);
      firePointer(el, "pointerup", { pointerType: "touch", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("moving beyond the 10px slop cancels the hold (orbit/pan gesture)", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
      firePointer(el, "pointermove", { pointerType: "touch", clientX: 125, clientY: 100 });
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("mouse pointerdown never arms the long-press", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "mouse", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("is suppressed while the measure tool is armed", () => {
    const { h, el } = renderToolbar();
    h.setActiveTool("measure");
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("selection-context-toolbar")).toBeNull();
  });

  it("the synthetic click after a long-press open is swallowed", () => {
    const { h, el } = renderToolbar();
    h.setSelection(new Map());
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("selection-context-toolbar")).toBeInTheDocument();
    const spy = vi.fn();
    document.addEventListener("click", spy);
    fireEvent.click(el);
    expect(spy).not.toHaveBeenCalled();
    document.removeEventListener("click", spy);
  });
});

describe("<SelectionContextToolbar> right click vs right-drag navigation", () => {
  beforeEach(() => {
    useViewerToolModeStore.setState({ mode: "navigation", sectionRev: 0 });
    viewerToolsMocks.editingPresetId = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mouse = { pointerType: "mouse", button: 2 } as const;
  const toolbar = () => screen.queryByTestId("selection-context-toolbar");

  it("Windows order: a quick right click (press, release, contextmenu) opens", () => {
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 200, clientY: 200 });
      firePointer(el, "pointerup", { ...mouse, clientX: 201, clientY: 200 });
      fireEvent.contextMenu(el, { clientX: 201, clientY: 200 });
    });
    expect(toolbar()).not.toBeNull();
  });

  it("Windows order: a right-DRAG (pan) does not open on release", () => {
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 200, clientY: 200 });
      firePointer(el, "pointermove", { ...mouse, clientX: 260, clientY: 230 });
      firePointer(el, "pointerup", { ...mouse, clientX: 260, clientY: 230 });
      fireEvent.contextMenu(el, { clientX: 260, clientY: 230 });
    });
    expect(toolbar()).toBeNull();
  });

  it("a press-and-hold without moving is navigation, not a click", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 200, clientY: 200 });
      now.mockReturnValue(1800);
      firePointer(el, "pointerup", { ...mouse, clientX: 200, clientY: 200 });
      fireEvent.contextMenu(el, { clientX: 200, clientY: 200 });
    });
    expect(toolbar()).toBeNull();
  });

  it("macOS/Linux order: contextmenu on press waits; a click opens on release", () => {
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 300, clientY: 150 });
      fireEvent.contextMenu(el, { clientX: 300, clientY: 150, buttons: 2 });
    });
    expect(toolbar()).toBeNull();
    act(() => {
      firePointer(el, "pointerup", { ...mouse, clientX: 300, clientY: 150 });
    });
    const tb = screen.getByTestId("selection-context-toolbar");
    expect(tb.style.left).toBe("300px");
  });

  it("macOS/Linux order: a right-drag after the early contextmenu never opens", () => {
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 300, clientY: 150 });
      fireEvent.contextMenu(el, { clientX: 300, clientY: 150, buttons: 2 });
      firePointer(el, "pointermove", { ...mouse, clientX: 380, clientY: 150 });
      firePointer(el, "pointerup", { ...mouse, clientX: 380, clientY: 150 });
    });
    expect(toolbar()).toBeNull();
  });

  it("the native browser menu stays suppressed even after a drag", () => {
    const { el } = renderToolbar();
    let prevented = false;
    el.addEventListener("contextmenu", (e) => {
      prevented = e.defaultPrevented;
    });
    act(() => {
      firePointer(el, "pointerdown", { ...mouse, clientX: 200, clientY: 200 });
      firePointer(el, "pointermove", { ...mouse, clientX: 260, clientY: 230 });
      firePointer(el, "pointerup", { ...mouse, clientX: 260, clientY: 230 });
      fireEvent.contextMenu(el, { clientX: 260, clientY: 230 });
    });
    expect(prevented).toBe(true);
  });

  it("left-button drags never open it", () => {
    const { el } = renderToolbar();
    act(() => {
      firePointer(el, "pointerdown", { pointerType: "mouse", button: 0, clientX: 200, clientY: 200 });
      firePointer(el, "pointermove", { pointerType: "mouse", button: 0, clientX: 300, clientY: 260 });
      firePointer(el, "pointerup", { pointerType: "mouse", button: 0, clientX: 300, clientY: 260 });
    });
    expect(toolbar()).toBeNull();
  });
});

describe("isRightClick", () => {
  it("accepts small, quick presses and rejects drags and holds", async () => {
    const { isRightClick } = await import("../src/contextToolbarState");
    expect(isRightClick({ dx: 2, dy: 3, durationMs: 120 })).toBe(true);
    expect(isRightClick({ dx: 6, dy: 0, durationMs: 120 })).toBe(false);
    expect(isRightClick({ dx: 0, dy: 0, durationMs: 700 })).toBe(false);
  });
});
