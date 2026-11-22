// Link navigation resolves asynchronously: a result for a sheet the user has
// already left must be ignored; the embedded sheet number decides ties.
import { createRef, type RefObject } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@ff/data/db/database";
import type { PdfOverlayHandle } from "@ff/viewer-react";

import SheetDataLayer, { type SheetDataLayerHandle } from "../../src/sheetData/SheetDataLayer";
import { clearPayloadCache } from "../../src/sheetData/sheetPayload";
import { useSheetDataStore } from "../../src/sheetData/sheetDataStore";

const payload = (links: unknown[]) =>
  new TextEncoder().encode(JSON.stringify({
    schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A101", sheetName: "P",
    viewports: [], elements: [], elementRecords: {}, links,
  }));

function overlay(content: Uint8Array): RefObject<PdfOverlayHandle> {
  return {
    current: {
      getDocument: () => ({ getAttachments: async () => ({ "freefield-sheet.json": { content } }) }),
      getCurrentPage: () => 1,
      getAnnotationLayer: () => null,
      onReady: () => undefined,
      setOnScaleChange: () => () => undefined,
    } as unknown as PdfOverlayHandle,
  };
}

async function seed(id: string, name: string, v: string) {
  await db.pdfFiles.put({ id, buildingId: "b", name, createdAt: 1, updatedAt: 1 });
  await db.pdfVersions.put({ id: v, pdfFileId: id, versionNumber: 1, name, size: 1, contentHash: id, pageCount: 1, width: 1000, height: 800, storedAt: 1, blobKey: "k" + id, isLatest: true });
}

beforeEach(async () => {
  clearPayloadCache();
  useSheetDataStore.setState({ payload: undefined, selectedGids: [], selectedCategory: null });
  if (!db.isOpen()) await db.open();
  await db.transaction("rw", db.tables, async () => { await Promise.all(db.tables.map((t) => t.clear())); });
  await seed("f101", "A101 - Plan.pdf", "v101");
  await seed("fa", "A - Plan.pdf", "va");
  await seed("fa101", "A - 101 - Plan.pdf", "va101");
});

const linkTo = (n: string) => ({ kind: "section", bbox: [10, 10, 50, 50], targetSheetNumber: n });

describe("SheetDataLayer link navigation", () => {
  it("ignores a late resolution after the user changed sheet", async () => {
    let release!: (v: string | null) => void;
    const slow = () => new Promise<string | null>((r) => { release = r; });
    const onNavigate = vi.fn();
    const ref = createRef<SheetDataLayerHandle>();
    const ov = overlay(payload([linkTo("A")]));
    const { rerender } = render(
      <SheetDataLayer ref={ref} overlayRef={ov} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={onNavigate} readSheetNumber={slow} />,
    );
    await waitFor(() => expect(useSheetDataStore.getState().payload).toBeTruthy());
    act(() => ref.current!.handleTap({ x: 20, y: 20 }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // user opens another sheet before the target resolves
    rerender(
      <SheetDataLayer ref={ref} overlayRef={ov} pdfVersionId="va" pdfFileId="fa" page={{ width: 1000, height: 800 }} onNavigate={onNavigate} readSheetNumber={slow} />,
    );
    await act(async () => { release("A"); await new Promise((r) => setTimeout(r, 30)); });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("picks the PDF whose embedded number matches when names are ambiguous", async () => {
    const onNavigate = vi.fn();
    const ref = createRef<SheetDataLayerHandle>();
    const embedded: Record<string, string> = { va: "A", va101: "A - 101" };
    render(
      <SheetDataLayer ref={ref} overlayRef={overlay(payload([linkTo("A - 101")]))} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={onNavigate} readSheetNumber={async (v) => embedded[v] ?? null} />,
    );
    await waitFor(() => expect(useSheetDataStore.getState().payload).toBeTruthy());
    act(() => ref.current!.handleTap({ x: 20, y: 20 }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("va101"));
  });
});

describe("SheetDataLayer: link to a sheet that is not in the bundle", () => {
  it("shows a clear hint, does not navigate, and element taps still work under a page-sized link", async () => {
    const onNavigate = vi.fn();
    const ref = createRef<SheetDataLayerHandle>();
    const content = new TextEncoder().encode(JSON.stringify({
      schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A101", sheetName: "P", page: { widthPt: 1000, heightPt: 800 },
      viewports: [], elementRecords: { D1: { gid: "D1", category: "Puertas", params: {} } },
      elements: [{ gid: "D1", bbox: [300, 300, 340, 340] }],
      links: [
        { kind: "view", bbox: [5, 5, 990, 790], targetSheetNumber: "A901", targetIncluded: false },
        { kind: "section", bbox: [10, 10, 50, 50], targetSheetNumber: "A902", targetIncluded: false },
      ],
    }));
    render(<SheetDataLayer ref={ref} overlayRef={overlay(content)} pdfVersionId="v101" pdfFileId="f101" page={{ width: 1000, height: 800 }} onNavigate={onNavigate} />);
    await waitFor(() => expect(useSheetDataStore.getState().payload).toBeTruthy());
    act(() => ref.current!.handleTap({ x: 30, y: 30 }));
    expect(await screen.findByText("Sheet A902 is not in the bundle.")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    act(() => ref.current!.handleTap({ x: 320, y: 320 }));
    await waitFor(() => expect(useSheetDataStore.getState().selectedGids).toEqual(["D1"]));
    expect(screen.queryByText(/is not in the bundle/)).toBeNull();
  });
});
