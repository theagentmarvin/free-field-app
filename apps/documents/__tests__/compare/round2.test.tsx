import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { useCompareStore } from "../../src/compare/compareStore";
import { AUTO_DPI, MAX_RASTER_PIXELS, computeGeometry } from "../../src/compare/engine/geometry";
import {
  RASTER_CACHE_MAX_ENTRIES,
  RasterCache,
  clearRasterCaches,
  getCachedSize,
  rasterKey,
  setCachedSize,
} from "../../src/compare/engine/rasterCache";
import { runDiff } from "../../src/compare/engine/diffClient";
import { DEFAULT_COMPARE_SETTINGS } from "../../src/compare/types";
import { looksMisaligned } from "../../src/compare/hints";
import { resolveThresholds } from "../../src/compare/engine/presets";
import CompareViewer from "../../src/compare/viewer/CompareViewer";
import ComparePanel from "../../src/compare/ui/ComparePanel";
import { blank, rect } from "./helpers";
import { fakeRunner, installCanvasStub, makeResult, region, sideA, sideB } from "./fixtures";

describe("auto DPI", () => {
  it("is the default setting", () => {
    expect(DEFAULT_COMPARE_SETTINGS.dpi).toBe("auto");
  });

  it("uses 144 DPI when the base raster fits the pixel cap", () => {
    const g = computeGeometry(1224, 792, 1224, 792, "auto");
    expect(g.renderScale).toBeCloseTo(AUTO_DPI / 72, 6);
    expect(g.downscaled).toBe(false);
  });

  it("uses the highest DPI that fits and does not flag it as lowered", () => {
    // 3024 x 2160 pt: 144 DPI would be ~26 MP.
    const g = computeGeometry(3024, 2160, 3024, 2160, "auto");
    expect(g.renderScale).toBeGreaterThan(1);
    expect(g.renderScale).toBeLessThan(2);
    expect(g.baseWidthPx * g.baseHeightPx).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(g.downscaled).toBe(false);
    // An explicit 144 on the same sheet is still reported as lowered.
    expect(computeGeometry(3024, 2160, 3024, 2160, 144).downscaled).toBe(true);
  });

  it("flags auto only when it cannot even reach 72 DPI", () => {
    const g = computeGeometry(5000, 3500, 5000, 3500, "auto");
    expect(g.renderScale).toBeLessThan(1);
    expect(g.downscaled).toBe(true);
  });

  it("keeps 72 and 144 selectable and resolvable", () => {
    expect(computeGeometry(600, 400, 600, 400, 72).renderScale).toBe(1);
    expect(computeGeometry(600, 400, 600, 400, 144).renderScale).toBe(2);
    expect(resolveThresholds({ ...DEFAULT_COMPARE_SETTINGS, dpi: 144 }).gridSize).toBe(16);
  });
});

describe("raster cache", () => {
  const r = (n: number) => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(n) });

  it("hits, misses and returns private clones", () => {
    const c = new RasterCache();
    expect(c.get("a")).toBeUndefined();
    const src = r(7);
    c.set("a", src);
    src.data.fill(0); // the cache kept its own copy
    const hit = c.get("a");
    expect(hit?.data[0]).toBe(7);
    hit?.data.fill(1); // mutating a clone does not touch the cache
    expect(c.get("a")?.data[0]).toBe(7);
  });

  it("evicts the least recently used entry beyond the entry limit", () => {
    const c = new RasterCache();
    for (let i = 0; i < RASTER_CACHE_MAX_ENTRIES; i++) c.set(`k${i}`, r(i));
    c.get("k0"); // k0 is now most recent; k1 is the oldest
    c.set("new", r(9));
    expect(c.size).toBe(RASTER_CACHE_MAX_ENTRIES);
    expect(c.has("k1")).toBe(false);
    expect(c.has("k0")).toBe(true);
    expect(c.has("new")).toBe(true);
  });

  it("evicts by total bytes and refuses a single oversized entry", () => {
    const c = new RasterCache(10, 40);
    c.set("a", r(1)); // 16 B
    c.set("b", r(2)); // 32 B
    c.set("c", r(3)); // 48 B > 40 -> evicts a
    expect(c.has("a")).toBe(false);
    expect(c.totalBytes).toBeLessThanOrEqual(40);
    c.set("big", { width: 10, height: 10, data: new Uint8ClampedArray(400) });
    expect(c.has("big")).toBe(false);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.totalBytes).toBe(0);
  });

  it("keys differ by version, page, scale and frame", () => {
    const k = rasterKey("v1", 1, 2);
    expect(rasterKey("v2", 1, 2)).not.toBe(k);
    expect(rasterKey("v1", 2, 2)).not.toBe(k);
    expect(rasterKey("v1", 1, 1)).not.toBe(k);
    expect(rasterKey("v1", 1, 2, 0, "10x10@1")).not.toBe(k);
    expect(rasterKey("v1", 1, 2)).toBe(k);
  });

  it("caches page sizes per version and page", () => {
    clearRasterCaches();
    expect(getCachedSize("v", 1)).toBeUndefined();
    setCachedSize("v", 1, { w: 10, h: 20 });
    expect(getCachedSize("v", 1)).toEqual({ w: 10, h: 20 });
    expect(getCachedSize("v", 2)).toBeUndefined();
  });

  it("leaves no detached buffers in the cache after a (worker-style) transfer", async () => {
    const c = new RasterCache();
    const base = blank(40, 30);
    const rev = rect(blank(40, 30), 5, 5, 6, 6);
    c.set("b", base);
    c.set("r", rev);
    const gotB = c.get("b")!;
    const gotR = c.get("r")!;
    // A fake worker that detaches the buffers it receives, like a real transfer.
    const worker = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null,
      onmessageerror: null,
      postMessage(msg: { input: { base: typeof base; revision: typeof rev } }, transfer?: Transferable[]) {
        structuredClone(null, { transfer: transfer ?? [] });
        setTimeout(() => {
          this.onmessage?.({ data: { type: "done", output: { ...msg.input, classes: new Uint8Array(1200), regions: [], added: 0, removed: 0, offsetPx: { x: 0, y: 0 }, autoScore: 0 } } } as MessageEvent);
        }, 0);
      },
      terminate() {},
    };
    let boots = 0;
    const factory = () => {
      boots++;
      setTimeout(() => worker.onmessage?.({ data: { type: "started" } } as MessageEvent), 0);
      return worker;
    };
    await runDiff(
      { base: gotB, revision: gotR, thresholds: resolveThresholds(DEFAULT_COMPARE_SETTINGS), scale: 1, autoAlign: false, nudgePx: { x: 0, y: 0 } },
      { createWorker: factory },
    );
    expect(boots).toBe(1);
    expect(gotB.data.buffer.byteLength).toBe(0); // the clone was transferred away
    // The cache still holds intact data.
    expect(c.get("b")?.data.byteLength).toBe(40 * 30 * 4);
    expect(c.get("r")?.data.byteLength).toBe(40 * 30 * 4);
    expect(c.get("r")?.data[(5 * 40 + 5) * 4]).toBe(0);
  });
});

describe("misalignment hint", () => {
  const page = { pageWidthPt: 100, pageHeightPt: 100 };
  it("fires when the changes cover more than 40 % of the page (auto-align off)", () => {
    const regions = [region(1, "added", 0, 0, 50, 50), region(2, "removed", 50, 50, 50, 50)]; // 50 %
    expect(looksMisaligned({ ...page, regions }, false)).toBe(true);
  });
  it("fires when a single region covers more than 50 %", () => {
    expect(looksMisaligned({ ...page, regions: [region(1, "modified", 0, 0, 80, 70)] }, false)).toBe(true);
  });
  it("stays quiet for small changes, with auto-align on, or without regions", () => {
    expect(looksMisaligned({ ...page, regions: [region(1, "added", 0, 0, 20, 20)] }, false)).toBe(false);
    expect(looksMisaligned({ ...page, regions: [region(1, "modified", 0, 0, 100, 100)] }, true)).toBe(false);
    expect(looksMisaligned({ ...page, regions: [] }, false)).toBe(false);
  });
  it("shows the notice in the panel only with auto-align off", () => {
    useCompareStore.getState().close();
    const big = makeResult({ pageWidthPt: 40, pageHeightPt: 30, regions: [region(1, "modified", 0, 0, 40, 30)] });
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        status: "done",
        settings: { ...useCompareStore.getState().settings, autoAlign: false },
        result: big,
      });
    });
    render(<ComparePanel runner={fakeRunner()} />);
    expect(screen.getByTestId("documents-compare-notice-misaligned")).toHaveTextContent(
      "Drawings look misaligned — turn on Auto-align or adjust the nudge",
    );
    act(() => useCompareStore.getState().updateSettings({ autoAlign: true }));
    expect(screen.queryByTestId("documents-compare-notice-misaligned")).toBeNull();
  });
});

describe("viewer prev/next", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installCanvasStub();
    useCompareStore.getState().close();
  });
  afterEach(() => restore());

  const seed = (result = makeResult()) =>
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        resultSides: { base: sideA, revision: sideB },
        result,
        status: "done",
        mode: "side-by-side",
      });
    });

  it("steps through changes with an n / N counter and wraps", () => {
    seed();
    render(<CompareViewer />);
    const counter = screen.getByTestId("documents-compare-viewer-counter");
    expect(counter).toHaveTextContent("– / 3");
    fireEvent.click(screen.getByTestId("documents-compare-viewer-next"));
    expect(useCompareStore.getState().selectedRegionId).toBe(1);
    expect(counter).toHaveTextContent("1 / 3");
    fireEvent.click(screen.getByTestId("documents-compare-viewer-next"));
    fireEvent.click(screen.getByTestId("documents-compare-viewer-next"));
    expect(counter).toHaveTextContent("3 / 3");
    fireEvent.click(screen.getByTestId("documents-compare-viewer-next"));
    expect(counter).toHaveTextContent("1 / 3");
    fireEvent.click(screen.getByTestId("documents-compare-viewer-prev"));
    expect(counter).toHaveTextContent("3 / 3");
  });

  it("is hidden when there are no changes", () => {
    seed(makeResult({ regions: [] }));
    render(<CompareViewer />);
    expect(screen.queryByTestId("documents-compare-viewer-counter")).toBeNull();
    expect(screen.queryByTestId("documents-compare-viewer-next")).toBeNull();
  });

  it("mobile: tapping a change in the list collapses the panel; desktop does not", () => {
    const collapse = vi_fn();
    const setup = (mobile: boolean) => {
      useCompareStore.getState().close();
      act(() => {
        useCompareStore.setState({ active: true, base: sideA, revision: sideB, status: "done", result: makeResult() });
      });
      return render(<ComparePanel runner={fakeRunner()} mobile={mobile} onCollapse={collapse.fn} />);
    };
    const m = setup(true);
    fireEvent.click(screen.getByTestId("documents-compare-row-2"));
    expect(useCompareStore.getState().selectedRegionId).toBe(2);
    expect(collapse.calls()).toBe(1);
    m.unmount();
    setup(false);
    fireEvent.click(screen.getByTestId("documents-compare-row-3"));
    expect(collapse.calls()).toBe(1);
  });
});

function vi_fn() {
  let n = 0;
  return { fn: () => void n++, calls: () => n };
}
