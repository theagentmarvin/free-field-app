// Orchestrates a compare: load + rasterise both sides, align, diff.

import { DEFAULT_COMPARE_SETTINGS } from "../types";
import type { CompareProgress, CompareStage, RunCompare } from "../types";
import { createTimer, nextRunId, noteRunDone } from "./debugTiming";
import { runDiff } from "./diffClient";
import { resolveThresholds } from "./presets";
import { rasterizePair } from "./rasterize";
import { yieldFrame } from "./yieldFrame";

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export const runCompare: RunCompare = async (base, revision, settings, opts = {}) => {
  const { signal, onProgress } = opts;
  const started = performance.now();
  const cfg = { ...DEFAULT_COMPARE_SETTINGS, ...settings };
  const timer = createTimer(`run #${nextRunId()}`);
  let last: CompareStage | null = null;
  const emit = (stage: CompareStage, fraction: number) => {
    if (stage === last) return;
    last = stage;
    const p: CompareProgress = { stage, fraction };
    onProgress?.(p);
  };
  const check = () => {
    if (signal?.aborted) throw abortError();
  };

  check();
  emit("loading", 0.02);
  const pair = await rasterizePair(base, revision, {
    dpi: cfg.dpi,
    signal,
    timer,
    onStage: (s) => emit(s, s === "loading" ? 0.02 : 0.15),
  });
  check();

  const { scale } = pair;
  // Let the browser paint the stage change (spinner) before the next heavy step.
  await yieldFrame();
  timer.mark("yield");
  const out = await runDiff(
    {
      base: pair.base,
      revision: pair.revision,
      thresholds: resolveThresholds(cfg),
      scale,
      autoAlign: cfg.autoAlign,
      nudgePx: { x: cfg.nudgePt.x * scale, y: cfg.nudgePt.y * scale },
    },
    {
      signal,
      onStage: (s) => {
        emit(s, s === "aligning" ? 0.6 : 0.8);
      },
    },
  );
  check();
  timer.mark("diff(worker+transfer)");
  emit("done", 1);
  timer.end({
    cacheHits: pair.cacheHits,
    px: out.base.width * out.base.height,
    ...Object.fromEntries(Object.entries(out.timings ?? {}).map(([k, v]) => [`job.${k}`, v])),
  });
  noteRunDone();

  return {
    width: out.base.width,
    height: out.base.height,
    scale,
    dpiUsed: Math.round(scale * 72),
    pageWidthPt: pair.pageWidthPt,
    pageHeightPt: pair.pageHeightPt,
    offsetPt: { x: out.offsetPx.x / scale, y: out.offsetPx.y / scale },
    revisionScale: pair.revisionScale,
    downscaled: pair.downscaled,
    aspectMismatch: pair.aspectMismatch,
    regions: out.regions,
    diffPixels: out.added + out.removed,
    classes: out.classes,
    base: out.base,
    revision: out.revision,
    durationMs: performance.now() - started,
  };
};
