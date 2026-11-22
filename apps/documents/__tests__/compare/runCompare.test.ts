import { describe, expect, it, vi } from "vitest";
import type { CompareProgress, CompareSide } from "../../src/compare/types";
import { DEFAULT_COMPARE_SETTINGS } from "../../src/compare/types";
import { blank, rect } from "./helpers";

vi.mock("../../src/compare/engine/rasterize", () => ({
  rasterizePair: vi.fn(async (_b: unknown, _r: unknown, opts: { onStage?: (s: string) => void }) => {
    opts.onStage?.("loading");
    opts.onStage?.("rendering");
    const base = rect(blank(300, 200), 50, 50, 60, 4);
    const revision = rect(rect(blank(300, 200), 50, 50, 60, 4), 200, 120, 30, 30);
    return {
      base,
      revision,
      scale: 2,
      pageWidthPt: 150,
      pageHeightPt: 100,
      revisionScale: 1,
      downscaled: false,
    };
  }),
}));

import { runCompare } from "../../src/compare/engine/runCompare";

const side = (id: string): CompareSide => ({ pdfFileId: "f", pdfVersionId: id, page: 1 });

describe("runCompare", () => {
  it("returns a full result and reports progress in order", async () => {
    const stages: string[] = [];
    const res = await runCompare(side("a"), side("b"), { ...DEFAULT_COMPARE_SETTINGS, autoAlign: true }, {
      onProgress: (p: CompareProgress) => stages.push(p.stage),
    });
    expect(stages).toEqual(["loading", "rendering", "aligning", "comparing", "done"]);
    expect(res.width).toBe(300);
    expect(res.regions).toHaveLength(1);
    expect(res.regions[0].kind).toBe("added");
    expect(res.regions[0].bbox.x).toBeLessThanOrEqual(100);
    expect(res.diffPixels).toBe(900);
    expect(res.classes.length).toBe(300 * 200);
    expect(res.offsetPt).toEqual({ x: 0, y: 0 });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("applies the nudge in points", async () => {
    const res = await runCompare(
      side("a"),
      side("b"),
      { ...DEFAULT_COMPARE_SETTINGS, autoAlign: false, nudgePt: { x: 5, y: 0 } },
    );
    expect(res.offsetPt).toEqual({ x: 5, y: 0 });
  });

  it("rejects with AbortError when already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runCompare(side("a"), side("b"), DEFAULT_COMPARE_SETTINGS, { signal: ctl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with AbortError when aborted mid-run", async () => {
    const ctl = new AbortController();
    const p = runCompare(side("a"), side("b"), DEFAULT_COMPARE_SETTINGS, {
      signal: ctl.signal,
      onProgress: (pr) => {
        if (pr.stage === "rendering") ctl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
