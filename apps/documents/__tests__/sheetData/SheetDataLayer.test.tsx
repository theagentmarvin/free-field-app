// SheetDataLayer: taps pick elements into the shared store (the toolbar panels
// read it), links navigate to the target sheet with a "Back to" breadcrumb, the
// selection is highlighted, and a PDF without the attachment does nothing.
import { createRef, useState, type RefObject } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@ff/data/db/database";
import type { PdfOverlayHandle } from "@ff/viewer-react";

import PropertiesPanelBody from "../../src/sheetData/PropertiesPanelBody";
import SheetDataLayer, { type SheetDataLayerHandle } from "../../src/sheetData/SheetDataLayer";
import { useSheetDataStore } from "../../src/sheetData/sheetDataStore";
import { clearPayloadCache } from "../../src/sheetData/sheetPayload";

const payload = (num: string, extra: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      schema: "freefield.sheet/1",
      sheetId: `id-${num}`,
      sheetNumber: num,
      sheetName: "Sheet",
      viewports: [],
      elements: [],
      elementRecords: {},
      links: [],
      ...extra,
    }),
  );

const A101 = payload("A101", {
  page: { widthPt: 3000, heightPt: 2000 },
  elements: [
    { gid: "W1", bbox: [100, 100, 300, 140] },
    { gid: "D1", bbox: [180, 95, 220, 145] },
  ],
  elementRecords: {
    W1: { gid: "W1", uid: "uid-w1", eid: 7, category: "Walls", family: "Basic Wall", type: "200", level: "Level 1", params: { Mark: { d: "W-1" }, Fire: { d: "2h" } } },
    D1: { gid: "D1", category: "Doors", params: {} },
  },
  links: [
    { kind: "section", bbox: [10, 10, 50, 50], targetSheetNumber: "A201", targetSheetId: "id-A201" },
    { kind: "view", bbox: [60, 10, 100, 50], targetSheetNumber: null },
    { kind: "callout", bbox: [10, 60, 50, 90], targetSheetNumber: "Z999" },
  ],
});

const docs: Record<string, Uint8Array | null> = { v101: A101, v201: payload("A201"), vplain: null };

function makeOverlay(getVersion: () => string): RefObject<PdfOverlayHandle> {
  const handle = {
    getDocument: () => ({
      getAttachments: async () => {
        const c = docs[getVersion()];
        return c ? { "freefield-sheet.json": { content: c } } : null;
      },
    }),
    getCurrentPage: () => 1,
    getAnnotationLayer: () => null,
    onReady: () => undefined,
    setOnScaleChange: () => () => undefined,
  } as unknown as PdfOverlayHandle;
  return { current: handle };
}

async function seedPdf(id: string, name: string, versionId: string, building = "b1") {
  await db.pdfFiles.put({ id, buildingId: building, name, createdAt: 1, updatedAt: 1 });
  await db.pdfVersions.put({
    id: versionId, pdfFileId: id, versionNumber: 1, name, size: 1, contentHash: id, pageCount: 1,
    width: 1000, height: 800, storedAt: 1, blobKey: `k-${id}`, isLatest: true,
  });
}

function Harness({ layerRef, initial }: { layerRef: RefObject<SheetDataLayerHandle>; initial: string }) {
  const [version, setVersion] = useState(initial);
  const overlay = makeOverlay(() => version);
  const fileId = version === "v101" ? "f101" : version === "v201" ? "f201" : "fplain";
  return (
    <>
      <SheetDataLayer
        ref={layerRef}
        overlayRef={overlay}
        pdfVersionId={version}
        pdfFileId={fileId}
        page={{ width: 1000, height: 800 }}
        onNavigate={(v) => setVersion(v)}
      />
      <PropertiesPanelBody />
    </>
  );
}

const ready = () => waitFor(() => expect(useSheetDataStore.getState().payload).toBeTruthy());

beforeEach(async () => {
  clearPayloadCache();
  useSheetDataStore.setState({ payload: undefined, selectedGids: [], selectedCategory: null });
  if (!db.isOpen()) await db.open();
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
  await seedPdf("f101", "A101 - First Floor Plan.pdf", "v101");
  await seedPdf("f201", "A201 - Sections.pdf", "v201");
  await seedPdf("fplain", "Spec book.pdf", "vplain");
});

describe("SheetDataLayer", () => {
  it("publishes no payload for a PDF without sheet data and ignores taps", async () => {
    const ref = createRef<SheetDataLayerHandle>();
    render(<Harness layerRef={ref} initial="vplain" />);
    await waitFor(() => expect(useSheetDataStore.getState().payload).toBeNull());
    act(() => ref.current!.handleTap({ x: 120, y: 120 }));
    expect(useSheetDataStore.getState().selectedGids).toEqual([]);
  });

  it("selects the tapped element (smallest box) and tells the host", async () => {
    const onElementTapped = vi.fn();
    const ref = createRef<SheetDataLayerHandle>();
    render(
      <SheetDataLayer ref={ref} overlayRef={makeOverlay(() => "v101")} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={() => undefined} onElementTapped={onElementTapped} />,
    );
    await ready();
    act(() => ref.current!.handleTap({ x: 120, y: 120 }));
    expect(useSheetDataStore.getState().selectedGids).toEqual(["W1"]);
    expect(onElementTapped).toHaveBeenCalledTimes(1);
    act(() => ref.current!.handleTap({ x: 200, y: 120 })); // door inside the wall box
    expect(useSheetDataStore.getState().selectedGids).toEqual(["D1"]);
    act(() => ref.current!.handleTap({ x: 900, y: 700 })); // empty space clears
    expect(useSheetDataStore.getState().selectedGids).toEqual([]);
  });

  it("the Properties panel shows the tapped element and searches parameters", async () => {
    const ref = createRef<SheetDataLayerHandle>();
    render(<Harness layerRef={ref} initial="v101" />);
    await ready();
    expect(screen.getByTestId("properties-empty")).toBeTruthy();
    act(() => ref.current!.handleTap({ x: 120, y: 120 }));
    const props = await screen.findByTestId("element-properties");
    expect(props.textContent).toContain("Walls");
    expect(props.textContent).toContain("Basic Wall : 200");
    expect(props.textContent).toContain("uid-w1 (7)");
    fireEvent.change(screen.getByTestId("element-param-search"), { target: { value: "mark" } });
    expect(screen.getByTestId("element-param-list").textContent).toContain("W-1");
    expect(screen.getByTestId("element-param-list").textContent).not.toContain("2h");
  });

  it("highlights every selected element (one outline each) in the annotation layer", async () => {
    const layer = document.createElement("div");
    layer.style.width = "2000px";
    document.body.appendChild(layer);
    const overlay = makeOverlay(() => "v101");
    (overlay.current as unknown as { getAnnotationLayer: () => HTMLElement }).getAnnotationLayer = () => layer;
    (overlay.current as unknown as { onReady: (cb: () => void) => void }).onReady = (cb) => cb();
    const ref = createRef<SheetDataLayerHandle>();
    render(<SheetDataLayer ref={ref} overlayRef={overlay} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={() => undefined} />);
    await ready();
    act(() => ref.current!.handleTap({ x: 120, y: 120 }));
    const rect = await waitFor(() => {
      const r = layer.querySelector('[data-testid="sheet-highlight-bbox"]');
      expect(r).not.toBeNull();
      return r!;
    }, { timeout: 2000 });
    expect(rect.getAttribute("x")).toBe("100");
    expect(rect.getAttribute("width")).toBe("200");
    act(() => useSheetDataStore.getState().selectCategory("Doors"));
    await waitFor(() => expect(layer.querySelectorAll('[data-testid="sheet-highlight-bbox"]')).toHaveLength(1));
    act(() => useSheetDataStore.getState().setPayload(useSheetDataStore.getState().payload));
    act(() => useSheetDataStore.setState({ selectedGids: ["W1", "D1"], selectedCategory: "all" }));
    await waitFor(() => expect(layer.querySelectorAll('[data-testid="sheet-highlight-bbox"]')).toHaveLength(2));
    act(() => ref.current!.handleTap({ x: 900, y: 700 })); // empty space clears it
    await waitFor(() => expect(layer.querySelector('[data-testid="sheet-highlight-bbox"]')).toBeNull());
    layer.remove();
  });

  it("follows a link to the target sheet and offers a Back breadcrumb", async () => {
    const ref = createRef<SheetDataLayerHandle>();
    render(<Harness layerRef={ref} initial="v101" />);
    await ready();
    expect(screen.queryByTestId("sheet-back")).toBeNull();
    act(() => ref.current!.handleTap({ x: 20, y: 20 }));
    const back = await screen.findByTestId("sheet-back");
    expect(back.textContent).toContain("Back to A101");
    await waitFor(() => expect(useSheetDataStore.getState().payload?.sheetNumber).toBe("A201"));
    fireEvent.click(back);
    await waitFor(() => expect(useSheetDataStore.getState().payload?.sheetNumber).toBe("A101"));
    expect(screen.queryByTestId("sheet-back")).toBeNull();
  });

  it("does not navigate for view links without a sheet; warns for an unknown sheet", async () => {
    const onNavigate = vi.fn();
    const ref = createRef<SheetDataLayerHandle>();
    render(
      <SheetDataLayer ref={ref} overlayRef={makeOverlay(() => "v101")} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={onNavigate} />,
    );
    await ready();
    act(() => ref.current!.handleTap({ x: 80, y: 30 }));
    act(() => ref.current!.handleTap({ x: 20, y: 70 }));
    await screen.findByText(/Sheet Z999 is not in this building/);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
