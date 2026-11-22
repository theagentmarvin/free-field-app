import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { cloudPath } from "../../src/compare/cloudPath";
import { CSV_HEADER, regionsToCsv } from "../../src/compare/csv";
import { compositeOverlay } from "../../src/compare/viewer/composite";
import { DEFAULT_OVERLAY_COLORS } from "../../src/compare/compareStore";
import {
  applyPaneUpdate,
  applySyncFlag,
  clampScale,
  fitView,
  focusBox,
  panBy,
  useSyncedView,
  zoomAt,
  IDENTITY_VIEW,
} from "../../src/compare/viewer/useSyncedView";
import { region } from "./fixtures";

describe("cloudPath", () => {
  it("starts at the corner, closes, and scallops every edge outward", () => {
    const d = cloudPath(10, 20, 40, 20, 10);
    expect(d.startsWith("M10 20")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // 4 arcs on each long edge, 2 on each short edge.
    expect((d.match(/A/g) ?? []).length).toBe(4 + 2 + 4 + 2);
    expect(d).toContain("50 20");
    expect(d).toContain("50 40");
    expect(d).toContain("10 40");
    expect(d).toContain("10 20");
  });
  it("uses at least one arc per edge for tiny boxes", () => {
    expect((cloudPath(0, 0, 2, 2, 20).match(/A/g) ?? []).length).toBe(4);
  });
});

describe("regionsToCsv", () => {
  it("writes header and one row per region with reviewed flags", () => {
    const csv = regionsToCsv([region(1, "added", 1.234, 2, 3, 4), region(2, "removed")], [2]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines[0]).toBe("id,kind,x_pt,y_pt,w_pt,h_pt,diff_pixels,reviewed");
    expect(lines[1]).toBe("1,added,1.23,2,3,4,10,false");
    expect(lines[2]).toBe("2,removed,8,6,12,8,20,true");
  });
});

describe("compositeOverlay", () => {
  const classes = new Uint8Array([0, 1, 2, 3]);
  const base = {
    showBase: true,
    showRevision: true,
    baseOpacity: 1,
    revisionOpacity: 1,
    colors: DEFAULT_OVERLAY_COLORS,
  };
  const px = (a: Uint8ClampedArray, i: number) => [...a.slice(i * 4, i * 4 + 4)];
  it("paints white / shared / red / blue", () => {
    const out = compositeOverlay(classes, 4, 1, base);
    expect(px(out, 0)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1)).toEqual([0x1f, 0x23, 0x28, 255]);
    expect(px(out, 2)).toEqual([0xe5, 0x48, 0x4d, 255]);
    expect(px(out, 3)).toEqual([0x3b, 0x82, 0xf6, 255]);
  });
  it("hides a layer and honours opacity", () => {
    const out = compositeOverlay(classes, 4, 1, { ...base, showBase: false, revisionOpacity: 0.5 });
    expect(px(out, 2)).toEqual([255, 255, 255, 255]);
    expect(px(out, 3)[0]).toBeGreaterThan(0x3b);
    expect(px(out, 3)[0]).toBeLessThan(255);
  });
});

describe("view math", () => {
  it("clamps scale 0.1..16", () => {
    expect(clampScale(0.01)).toBe(0.1);
    expect(clampScale(100)).toBe(16);
  });
  it("zooms anchored at the cursor", () => {
    const v = zoomAt({ scale: 1, tx: 0, ty: 0 }, 2, 100, 50);
    expect(v).toEqual({ scale: 2, tx: -100, ty: -50 });
    // content point under the cursor stays put
    expect((100 - v.tx) / v.scale).toBe(100);
  });
  it("fits and centres", () => {
    const v = fitView({ width: 100, height: 50 }, { width: 232, height: 200 }, 16);
    expect(v.scale).toBe(2);
    expect(v.tx).toBe(16);
  });
  it("focusBox centres the box and fills ~60%", () => {
    const v = focusBox({ x: 100, y: 100, w: 50, h: 20 }, { width: 500, height: 400 });
    expect(v.scale).toBeCloseTo(6);
    expect(125 * v.scale + v.tx).toBeCloseTo(250);
    expect(110 * v.scale + v.ty).toBeCloseTo(200);
  });
});

describe("useSyncedView logic", () => {
  const moved = panBy(IDENTITY_VIEW, 10, 5);
  it("synced: updating one pane moves both", () => {
    const s = applyPaneUpdate({ views: [IDENTITY_VIEW, IDENTITY_VIEW], sync: true }, 0, moved);
    expect(s.views[0]).toEqual(s.views[1]);
  });
  it("unsynced: panes are independent", () => {
    const s = applyPaneUpdate({ views: [IDENTITY_VIEW, IDENTITY_VIEW], sync: false }, 1, moved);
    expect(s.views[0]).toEqual(IDENTITY_VIEW);
    expect(s.views[1]).toEqual(moved);
  });
  it("re-syncing snaps pane 1 to pane 0", () => {
    const s = applySyncFlag({ views: [moved, IDENTITY_VIEW], sync: false }, true);
    expect(s.views[1]).toEqual(moved);
  });
  it("hook: pan one pane updates both while synced, then independently", () => {
    const { result } = renderHook(() => useSyncedView(true));
    act(() => result.current.update(0, (v) => panBy(v, 20, 0)));
    expect(result.current.views[0]).toEqual(result.current.views[1]);
    expect(result.current.views[1].tx).toBe(20);
    act(() => result.current.setSync(false));
    act(() => result.current.update(1, (v) => panBy(v, 5, 0)));
    expect(result.current.views[0].tx).toBe(20);
    expect(result.current.views[1].tx).toBe(25);
  });
});
