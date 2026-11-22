import { describe, expect, it } from "vitest";
import { classifyPixels, findRegions } from "../../src/compare/engine/diff";
import { estimateOffset, shiftRaster } from "../../src/compare/engine/align";
import { resolveThresholds } from "../../src/compare/engine/presets";
import { DEFAULT_COMPARE_SETTINGS, type DiffThresholds } from "../../src/compare/types";
import { blank, rect, rectRGB } from "./helpers";
import { runDiffJob } from "../../src/compare/engine/diffJob";
import { computeGeometry, placeInFrame } from "../../src/compare/engine/geometry";

const T: DiffThresholds = {
  colorThreshold: 48,
  proximityPx: 1,
  gridSize: 16,
  minPixelsPerCell: 6,
  mergeDistance: 1,
  marginPx: 0,
};

function diff(a: ReturnType<typeof blank>, b: ReturnType<typeof blank>, t = T, scale = 1) {
  const c = classifyPixels(a, b, t);
  return { ...c, regions: findRegions(c.classes, a.width, a.height, t, scale) };
}

describe("resolveThresholds", () => {
  it("maps presets", () => {
    const s = DEFAULT_COMPARE_SETTINGS;
    expect(resolveThresholds(s)).toEqual({ ...T, marginPx: 0 });
    expect(resolveThresholds({ ...s, preset: "scanned" })).toMatchObject({
      colorThreshold: 80, proximityPx: 2, gridSize: 24, minPixelsPerCell: 20,
    });
    expect(resolveThresholds({ ...s, preset: "fine", marginPx: 5 })).toMatchObject({
      colorThreshold: 32, proximityPx: 0, gridSize: 8, minPixelsPerCell: 3, marginPx: 5,
    });
  });
  it("applies overrides", () => {
    const t = resolveThresholds({
      ...DEFAULT_COMPARE_SETTINGS,
      thresholds: { gridSize: 4, mergeDistance: 3 },
    });
    expect(t.gridSize).toBe(4);
    expect(t.mergeDistance).toBe(3);
    expect(t.colorThreshold).toBe(48);
  });
});

describe("diff", () => {
  it("identical pages give no regions", () => {
    const a = rect(blank(200, 150), 20, 20, 50, 30);
    const r = diff(a, rect(blank(200, 150), 20, 20, 50, 30));
    expect(r.regions).toHaveLength(0);
    expect(r.added + r.removed).toBe(0);
    expect(r.classes[25 * 200 + 30]).toBe(1);
  });

  it("an added rectangle is one added region containing it", () => {
    const a = blank(300, 200);
    const b = rect(blank(300, 200), 100, 60, 40, 30);
    const { regions } = diff(a, b);
    expect(regions).toHaveLength(1);
    const r = regions[0];
    expect(r.kind).toBe("added");
    expect(r.id).toBe(1);
    expect(r.bbox.x).toBeLessThanOrEqual(100);
    expect(r.bbox.y).toBeLessThanOrEqual(60);
    expect(r.bbox.x + r.bbox.w).toBeGreaterThanOrEqual(140);
    expect(r.bbox.y + r.bbox.h).toBeGreaterThanOrEqual(90);
    expect(r.addedPixels).toBe(40 * 30);
  });

  it("a removed rectangle is a removed region", () => {
    const a = rect(blank(300, 200), 100, 60, 40, 30);
    const { regions } = diff(a, blank(300, 200));
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("removed");
  });

  it("a moved element yields added and removed pixels", () => {
    const a = rect(blank(300, 200), 20, 20, 30, 30);
    const b = rect(blank(300, 200), 200, 120, 30, 30);
    const { regions, added, removed } = diff(a, b);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    expect(regions.map((r) => r.kind).sort()).toEqual(["added", "removed"]);
    const { classes } = classifyPixels(a, b, T);
    expect(classes[30 * 300 + 30]).toBe(2); // inside the old position
    expect(classes[130 * 300 + 210]).toBe(3); // inside the new position
    expect(classes[100 * 300 + 100]).toBe(0);
    expect(removed).toBe(900);
    expect(added).toBe(900);
  });

  it("converts bbox to page pt using scale", () => {
    const b = rect(blank(400, 400), 200, 200, 40, 40);
    const { regions } = diff(blank(400, 400), b, T, 2);
    const bb = regions[0].bbox;
    const tol = T.gridSize / 2; // one padding cell, in pt
    // the rect spans 100..120 pt on both axes
    expect(bb.x).toBeLessThanOrEqual(100);
    expect(bb.y).toBeLessThanOrEqual(100);
    expect(bb.x + bb.w).toBeGreaterThanOrEqual(120);
    expect(bb.y + bb.h).toBeGreaterThanOrEqual(120);
    expect(bb.x).toBeGreaterThanOrEqual(100 - 2 * tol);
    expect(bb.x + bb.w).toBeLessThanOrEqual(120 + 2 * tol);
  });

  it("proximity suppresses a 1 px shift, proximity 0 detects it", () => {
    const a = rect(blank(200, 100), 30, 40, 1, 100 - 40 - 10); // vertical 1px line
    const b = rect(blank(200, 100), 31, 40, 1, 100 - 40 - 10);
    expect(diff(a, b, { ...T, proximityPx: 1 }).regions).toHaveLength(0);
    expect(diff(a, b, { ...T, proximityPx: 0 }).regions).toHaveLength(1);
  });

  it("ignores faint anti-aliasing noise", () => {
    const a = rect(blank(200, 100), 30, 30, 60, 20);
    const b = rect(blank(200, 100), 30, 30, 60, 20);
    // soft fringe: light grey ring around the rectangle (above ink threshold)
    rect(b, 28, 28, 64, 2, 230);
    rect(b, 28, 50, 64, 2, 230);
    expect(diff(a, b, { ...T, proximityPx: 0 }).regions).toHaveLength(0);
  });

  it("ignores the margin band", () => {
    const b = rect(blank(200, 200), 2, 2, 10, 10);
    expect(diff(blank(200, 200), b, { ...T, marginPx: 0 }).regions.length).toBe(1);
    expect(diff(blank(200, 200), b, { ...T, marginPx: 20 }).regions).toHaveLength(0);
  });

  it("merges blobs one empty cell apart (padded boxes overlap)", () => {
    const b = rect(rect(blank(400, 200), 32, 32, 16, 16), 64, 32, 16, 16);
    expect(diff(blank(400, 200), b).regions).toHaveLength(1);
    expect(diff(blank(400, 200), b, { ...T, mergeDistance: 0 }).regions).toHaveLength(1);
  });

  it("mergeDistance 0 merges only overlapping padded boxes", () => {
    const b = rect(rect(blank(400, 200), 32, 32, 16, 16), 96, 32, 16, 16);
    expect(diff(blank(400, 200), b, { ...T, mergeDistance: 0 }).regions).toHaveLength(2);
    expect(diff(blank(400, 200), b, { ...T, mergeDistance: 1 }).regions).toHaveLength(1);
  });

  it("keeps far-apart blobs separate and sums merged counts", () => {
    const far = rect(rect(blank(400, 200), 10, 10, 20, 20), 350, 150, 20, 20);
    expect(diff(blank(400, 200), far, { ...T, mergeDistance: 2 }).regions).toHaveLength(2);
    const near = rect(rect(blank(400, 200), 32, 32, 16, 16), 64, 32, 16, 16);
    const r = diff(blank(400, 200), near).regions[0];
    expect(r.addedPixels).toBe(512);
    expect(r.diffPixels).toBe(512);
  });

  it("sorts top-to-bottom, then left-to-right", () => {
    const b = blank(500, 300);
    rect(b, 400, 20, 20, 20); // top right
    rect(b, 20, 20, 20, 20); // top left, same row as the top right
    rect(b, 100, 200, 20, 20); // bottom
    const { regions } = diff(blank(500, 300), b);
    expect(regions.map((r) => [r.id, Math.round(r.bbox.x), Math.round(r.bbox.y)])).toEqual([
      [1, 0, 0],
      [2, 384, 0],
      [3, 80, 176],
    ]);
  });

  it("detects an added coloured (yellow) highlight as ink", () => {
    const b = rectRGB(blank(300, 200), 100, 60, 40, 30, [255, 230, 0]);
    const { regions, added } = diff(blank(300, 200), b);
    expect(added).toBe(1200);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("added");
  });

  it("treats transparent pixels as white", () => {
    const a = blank(50, 50);
    const b = blank(50, 50);
    b.data.fill(0); // fully transparent black
    expect(classifyPixels(a, b, T).added).toBe(0);
  });
});

describe("align", () => {
  function sheet() {
    const p = blank(800, 600);
    rect(p, 100, 100, 200, 4);
    rect(p, 100, 100, 4, 150);
    rect(p, 400, 300, 120, 90);
    rect(p, 600, 80, 60, 3);
    rect(p, 250, 450, 3, 100);
    return p;
  }
  it("recovers a known shift within 1 px", () => {
    const base = sheet();
    const rev = shiftRaster(base, -7, 4);
    const r = estimateOffset(base, rev);
    expect(Math.abs(r.dx - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.dy + 4)).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThan(0.9);
  });
  it("recovers the opposite-sign shift (+9,-6)", () => {
    const base = sheet();
    const r = estimateOffset(base, shiftRaster(base, -9, 6));
    expect(Math.abs(r.dx - 9)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.dy + 6)).toBeLessThanOrEqual(1);
  });
  it("keeps 0,0 on a repetitive grid with a small real change", () => {
    const mk = () => {
      const p = blank(800, 600);
      for (let x = 20; x < 800; x += 40) rect(p, x, 0, 2, 600);
      for (let y = 20; y < 600; y += 40) rect(p, 0, y, 800, 2);
      return p;
    };
    const rev = rect(mk(), 300, 300, 24, 12);
    expect(estimateOffset(mk(), rev)).toMatchObject({ dx: 0, dy: 0 });
  });
  it("returns zero for identical or blank pages", () => {
    const base = sheet();
    expect(estimateOffset(base, sheet())).toMatchObject({ dx: 0, dy: 0 });
    expect(estimateOffset(blank(300, 300), blank(300, 300))).toEqual({ dx: 0, dy: 0, score: 0 });
  });
  it("shiftRaster moves content and fills white", () => {
    const p = rect(blank(10, 10), 0, 0, 2, 2);
    const s = shiftRaster(p, 3, 1);
    expect(s.data[(1 * 10 + 3) * 4]).toBe(0);
    expect(s.data[0]).toBe(255);
    expect(s.data[(1 * 10 + 2) * 4]).toBe(255);
  });
});

describe("diff job", () => {
  it("nudges first, auto-aligns the residual, reports the total", () => {
    const base = blank(800, 600);
    rect(base, 100, 100, 200, 4);
    rect(base, 100, 100, 4, 150);
    rect(base, 400, 300, 120, 90);
    rect(base, 250, 450, 3, 100);
    const rev = shiftRaster(base, -10, 0);
    const out = runDiffJob({
      base, revision: rev, thresholds: T, scale: 1, autoAlign: true, nudgePx: { x: 4, y: 0 },
    });
    expect(Math.abs(out.offsetPx.x - 10)).toBeLessThanOrEqual(1);
    expect(out.offsetPx.y).toBe(0);
    expect(out.regions).toHaveLength(0);
  });
  it("applies just the nudge when auto-align is off", () => {
    const base = rect(blank(200, 100), 50, 40, 30, 10);
    const out = runDiffJob({
      base, revision: shiftRaster(base, -5, 0), thresholds: T, scale: 1, autoAlign: false, nudgePx: { x: 5, y: 0 },
    });
    expect(out.offsetPx).toEqual({ x: 5, y: 0 });
    expect(out.regions).toHaveLength(0);
  });
});

describe("geometry", () => {
  it("never exceeds the pixel budget and flags downscaling", () => {
    const g = computeGeometry(5000, 3500, 5000, 3500, 144);
    expect(g.downscaled).toBe(true);
    expect(g.baseWidthPx * g.baseHeightPx).toBeLessThanOrEqual(12_000_000);
    expect(g.scale).toBeCloseTo(g.baseWidthPx / 5000, 10);
  });
  it("scales a mismatched Revision by width and flags a different aspect", () => {
    const g = computeGeometry(600, 400, 1200, 1200, 72);
    expect(g.revisionScale).toBeCloseTo(0.5);
    expect(g.aspectMismatch).toBe(true);
    expect(computeGeometry(600, 400, 1200, 800, 72).aspectMismatch).toBe(false);
    expect(computeGeometry(600, 400, 603, 402, 72).revisionScale).toBe(1);
  });
  it("resamples when the Revision render is capped", () => {
    const g = computeGeometry(600, 400, 6000, 4000, 72); // large revision -> shrunk to base width
    expect(g.resampleFactor).toBeCloseTo(1);
    const h = computeGeometry(600, 400, 30, 30, 144 * 50);
    expect(h.resampleFactor).toBeGreaterThan(1);
  });
  it("placeInFrame is top-left aligned, white-filled and clipped", () => {
    const src = rect(blank(4, 4), 0, 0, 4, 4);
    const out = placeInFrame(src, 6, 3);
    expect(out.width).toBe(6);
    expect(out.data[0]).toBe(0);
    expect(out.data[(0 * 6 + 3) * 4]).toBe(0);
    expect(out.data[(0 * 6 + 4) * 4]).toBe(255);
    expect(out.data.length).toBe(6 * 3 * 4);
    expect(placeInFrame(src, 4, 4)).toBe(src);
  });
});

describe("perf", () => {
  it("2000x1400 classify + regions stays fast", () => {
    const a = blank(2000, 1400);
    const b = blank(2000, 1400);
    for (let i = 0; i < 40; i++) {
      rect(a, 20 + i * 45, 50 + (i % 7) * 150, 30, 3);
      rect(b, 20 + i * 45, 50 + (i % 7) * 150, 30, 3);
    }
    rect(b, 900, 700, 80, 60);
    const t0 = performance.now();
    const c = classifyPixels(a, b, T);
    const regions = findRegions(c.classes, 2000, 1400, T, 1);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[perf] classify+regions 2000x1400: ${ms.toFixed(0)} ms`);
    expect(regions).toHaveLength(1);
    expect(ms).toBeLessThan(1500);
  });
});
