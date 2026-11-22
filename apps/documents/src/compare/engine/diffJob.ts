// The diff job shared by the worker and the in-thread fallback:
// nudge -> (optional) auto-align on the nudged Revision -> shift -> classify -> regions.

import type { ChangeRegion, DiffThresholds, RasterPage } from "../types";
import { estimateOffsetFromMaps, shiftMap, shiftRaster } from "./align";
import { classifyMaps, findRegions, toInkMap } from "./diff";

export interface DiffJobInput {
  base: RasterPage;
  revision: RasterPage;
  thresholds: DiffThresholds;
  /** raster px per page pt. */
  scale: number;
  autoAlign: boolean;
  /** Manual nudge in raster px (applied first; auto-align then refines). */
  nudgePx: { x: number; y: number };
}

export interface DiffJobOutput {
  base: RasterPage;
  /** Revision with the total offset applied. */
  revision: RasterPage;
  classes: Uint8Array;
  regions: ChangeRegion[];
  added: number;
  removed: number;
  /** Total applied offset (nudge + auto) in raster px. */
  offsetPx: { x: number; y: number };
  autoScore: number;
  /** Stage durations in ms (ink maps, align, shift, classify, regions). */
  timings?: Record<string, number>;
}

export type DiffJobStage = "aligning" | "comparing";

export function runDiffJob(
  input: DiffJobInput,
  onStage?: (s: DiffJobStage) => void,
): DiffJobOutput {
  const { base, thresholds, scale } = input;
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const n = performance.now();
    timings[name] = Math.round(n - t);
    t = n;
  };
  const { width: w, height: h } = base;
  const nx = Math.round(input.nudgePx.x);
  const ny = Math.round(input.nudgePx.y);
  const baseMap = toInkMap(base);
  const revMap0 = toInkMap(input.revision);
  lap("ink");
  let ox = nx;
  let oy = ny;
  let autoScore = 0;
  if (input.autoAlign) {
    onStage?.("aligning");
    const nudged = nx || ny ? shiftMap(revMap0, w, h, nx, ny) : revMap0;
    const est = estimateOffsetFromMaps(baseMap, nudged, w, h);
    ox += est.dx;
    oy += est.dy;
    autoScore = est.score;
    lap("align");
  }
  onStage?.("comparing");
  const moved = ox !== 0 || oy !== 0;
  const revMap = moved ? shiftMap(revMap0, w, h, ox, oy) : revMap0;
  const revision = moved ? shiftRaster(input.revision, ox, oy) : input.revision;
  lap("shift");
  const { classes, added, removed } = classifyMaps(baseMap, revMap, w, h, thresholds);
  lap("classify");
  const regions = findRegions(classes, w, h, thresholds, scale);
  lap("regions");
  return { base, revision, classes, regions, added, removed, offsetPx: { x: ox, y: oy }, autoScore, timings };
}
