// startRendererSampler — poll a renderer `read()` at 1 Hz, snapshot
// the numbers, and breadcrumb when they cross OOM-risk thresholds.
//
// The `read()` is injected by the viewer so this package never
// imports `three`. It returns a sparse object; every field is
// optional and missing fields are treated as 0 (defensive reads).

import { safe } from "./safe";
import { getFrameStats } from "./frameTimer";
import type { Telemetry } from "./telemetry";

export interface RendererRead {
  drawCalls?: number;
  triangles?: number;
  geometries?: number;
  textures?: number;
  frameEmaMs?: number;
  /** Chrome-only `performance.memory` watermarks. Guarded by the
   *  viewer's read(); these drive the OOM-risk breadcrumb. */
  heapUsedB?: number;
  heapLimitB?: number;
}

export interface RendererSamplerOptions {
  /** Injected viewer read. May be called on an interval; must be
   *  cheap and must never throw. */
  read: () => RendererRead;
  /** Poll interval. Default 1000 ms (1 Hz). */
  intervalMs?: number;
  /** Injected persist callback. Called every `persistEveryMs`
   *  (dependency-injected so the sampler stays storage-agnostic). */
  persist?: () => void;
  /** Persist cadence in ms. Default 0 = never (package stays pure
   *  unless the viewer opts in). */
  persistEveryMs?: number;
  /** §5.4: navigator.deviceMemory (GB). When <= 4 the TEXTURE
   *  threshold halves (80 -> 40): low-RAM site tablets die earlier. */
  deviceMemoryGB?: number;
  /** §5.4: notification sink fired ONCE per crossing, with the same
   *  payload as the crumb. The seam wires it to captureTelemetry-
   *  Message("oom-risk", warning); omitted = breadcrumb-only (v1).
   *  A throwing sink is swallowed — it can never break the sampler. */
  onOomRisk?: (data: Record<string, unknown>) => void;
}

/** OOM-risk thresholds. Crossed once per crossing, not every second. */
export const OOM_GEOMETRY_THRESHOLD = 150_000;
export const OOM_TEXTURE_THRESHOLD = 80;
/** §5.4 (wave 18): Chrome heap watermark crossing — heapUsed/heapLimit
 *  at or above this ratio is an OOM risk before the OS kill. */
export const OOM_HEAP_RATIO_THRESHOLD = 0.85;

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Start sampling. Returns a `stop()` function that clears the
 * interval. The sampler snapshots key `"renderer"` at `intervalMs`
 * and breadcrumbs `perf:oom-risk` only on a threshold *crossing*
 * (rising above the limit), not every tick.
 */
export function startRendererSampler(
  telemetry: Telemetry,
  options: RendererSamplerOptions,
): () => void {
  const read = options.read;
  const intervalMs =
    typeof options.intervalMs === "number" && options.intervalMs > 0
      ? options.intervalMs
      : 1000;
  const persistEveryMs =
    typeof options.persistEveryMs === "number" && options.persistEveryMs > 0
      ? options.persistEveryMs
      : 0;
  const persistFn = typeof options.persist === "function" ? options.persist : null;
  let lastPersistAt = 0;

  const deviceMemoryGB =
    typeof options.deviceMemoryGB === "number" && Number.isFinite(options.deviceMemoryGB)
      ? options.deviceMemoryGB
      : undefined;
  const textureThreshold =
    deviceMemoryGB !== undefined && deviceMemoryGB <= 4
      ? OOM_TEXTURE_THRESHOLD / 2
      : OOM_TEXTURE_THRESHOLD;
  const onOomRisk = typeof options.onOomRisk === "function" ? options.onOomRisk : null;

  let geometriesOver = false;
  let texturesOver = false;
  let heapOver = false;

  const tick = (): void => {
    safe(() => {
      const sample = safe(() => read(), "sampler read failed") ?? {};
      const drawCalls = asNumber(sample.drawCalls);
      const triangles = asNumber(sample.triangles);
      const geometries = asNumber(sample.geometries);
      const textures = asNumber(sample.textures);
      // Frame-time feed: prefer the real rAF ticker's EMA (the v1
      // "omitted rather than faked" gap is now closed), falling back to
      // an injected read() value only when no timer is running.
      const frameStats = getFrameStats();
      const timerEmaMs =
        frameStats.sampleCount > 0 ? frameStats.frameEmaMs : undefined;
      const timerMaxMs =
        frameStats.sampleCount > 0 ? frameStats.frameMaxMs : undefined;
      const readEmaMs =
        typeof sample.frameEmaMs === "number" && Number.isFinite(sample.frameEmaMs)
          ? sample.frameEmaMs
          : undefined;
      const frameEmaMs = timerEmaMs ?? readEmaMs;
      const frameMaxMs = timerMaxMs;
      const heapUsedB =
        typeof sample.heapUsedB === "number" && Number.isFinite(sample.heapUsedB)
          ? sample.heapUsedB
          : undefined;
      const heapLimitB =
        typeof sample.heapLimitB === "number" && Number.isFinite(sample.heapLimitB)
          ? sample.heapLimitB
          : undefined;

      telemetry.snapshot("renderer", {
        drawCalls,
        triangles,
        geometries,
        textures,
        ...(frameEmaMs !== undefined ? { frameEmaMs } : {}),
        ...(frameMaxMs !== undefined ? { frameMaxMs } : {}),
        ...(heapUsedB !== undefined ? { heapUsedB } : {}),
        ...(heapLimitB !== undefined ? { heapLimitB } : {}),
      });

      const nowGeometriesOver = geometries > OOM_GEOMETRY_THRESHOLD;
      const nowTexturesOver = textures > textureThreshold;
      // §5.4 heap-ratio: only when BOTH Chrome watermarks are present
      // (iOS/Safari lack performance.memory — v1 optional-chain rule).
      const heapRatio =
        heapUsedB !== undefined &&
        heapLimitB !== undefined &&
        heapLimitB > 0
          ? heapUsedB / heapLimitB
          : undefined;
      const nowHeapOver =
        heapRatio !== undefined && heapRatio >= OOM_HEAP_RATIO_THRESHOLD;

      // Breadcrumb at most once per threshold-crossing level: fire
      // only when a level transitions from "under" to "over".
      const crossed =
        (nowGeometriesOver && !geometriesOver) ||
        (nowTexturesOver && !texturesOver) ||
        (nowHeapOver && !heapOver);

      if (crossed) {
        const reasons: string[] = [];
        if (nowGeometriesOver && !geometriesOver) reasons.push("geometries");
        if (nowTexturesOver && !texturesOver) reasons.push("textures");
        if (nowHeapOver && !heapOver) reasons.push("heap");
        const data: Record<string, unknown> = {
          reason: reasons.join("+"),
          drawCalls,
          triangles,
          geometries,
          textures,
          textureThreshold,
          ...(heapUsedB !== undefined ? { heapUsedB } : {}),
          ...(heapLimitB !== undefined ? { heapLimitB } : {}),
          ...(heapRatio !== undefined ? { heapRatio } : {}),
          ...(deviceMemoryGB !== undefined ? { deviceMemoryGB } : {}),
        };
        telemetry.breadcrumb("perf", "oom-risk", data);
        // §5.4: once per crossing, notify the injected sink (the seam
        // turns this into a captureMessage("oom-risk", warning) when
        // Channel A is live). Never allowed to break the sampler.
        if (onOomRisk) {
          safe(() => onOomRisk({ ...data }), "oom-risk sink failed");
        }
      }

      geometriesOver = nowGeometriesOver;
      texturesOver = nowTexturesOver;
      heapOver = nowHeapOver;

      // Persist on the configured cadence. Gated so the package stays
      // pure when the caller doesn't opt in; the injected persist is
      // itself throttled by the boot module's ≥5 s unchanged-skip.
      if (persistEveryMs > 0 && persistFn) {
        const now = Date.now();
        if (now - lastPersistAt >= persistEveryMs) {
          lastPersistAt = now;
          safe(() => persistFn(), "sampler persist failed");
        }
      }
    }, "sampler tick failed");
  };

  // Snapshot once immediately so a caller sees data without waiting a
  // full interval, then settle into the steady 1 Hz cadence.
  tick();
  const id = setInterval(tick, intervalMs);

  return () => {
    safe(() => clearInterval(id), "sampler stop failed");
  };
}