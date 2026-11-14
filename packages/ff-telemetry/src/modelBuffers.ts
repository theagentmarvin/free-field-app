// modelBuffers.ts — RendererDiagnostics clone: a fixed-capacity ring
// buffer per open model, plus the `getRendererReport()` assembly.
//
// `RendererDiagnostics` keeps a small ReportList per open model
// (capacity 2 reports here) and labels the newest entry " (Latest)" on
// read. Buffers die with `closeModelBuffer` — closing removes the ring
// entirely, so an open→close→open of the same modelId starts fresh
// (spec §9 risk 3: no leak, no stale reports bleeding into the new open).
//
// Survivability law: pure structural types (no `three`), every body
// safe()-wrapped, byte-stable string output with deterministic ordering
// and no timestamps beyond what callers already pass in (snapshot `ts`
// is dropped on render).

import { RingBuffer } from "./ringBuffer";
import { safe } from "./safe";
import type { Snapshot } from "./telemetry";

/** Structural renderer-info fields (the §4.3 report shape). Missing
 *  fields are treated as 0 — same defensive-read rule as v1 sampler. */
export interface RendererInfoLike {
  drawCalls?: number;
  triangles?: number;
  geometries?: number;
  textures?: number;
  frameEmaMs?: number;
  frameMaxMs?: number;
  heapUsedB?: number;
  heapLimitB?: number;
}

/** A per-model ring buffer of `RendererInfoLike` report snapshots. */
export interface ModelBuffers {
  /** Open (create) the ring for `modelId`. Idempotent. */
  open(modelId: string): void;
  /** Close (destroy) the ring for `modelId`. */
  close(modelId: string): void;
  /** True when a ring is currently open for `modelId`. */
  has(modelId: string): boolean;
  /** Append a report. No-op when the model is unopened/closed. */
  record(modelId: string, info: RendererInfoLike): void;
  /** The buffered reports, oldest → newest (capacity-capped). */
  get(modelId: string): RendererInfoLike[] | undefined;
  /** Open model ids, sorted (deterministic ordering). */
  openModelIds(): string[];
  /** Number of currently-open model buffers. */
  count(): number;
}

/** Inputs `getRendererReport` needs (deviceLostCount + snapshots come
 *  from the telemetry instance; buffers from this module). */
export interface RendererReportInput {
  deviceLostCount: number;
  buffers: ModelBuffers;
  snapshots: Snapshot[];
}

const DEFAULT_CAPACITY = 2;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Normalize an arbitrary info object to the fixed 8-field shape so the
 *  ring contents and the rendered output are byte-stable. */
function normalize(info: RendererInfoLike): RendererInfoLike {
  return {
    drawCalls: num(info?.drawCalls),
    triangles: num(info?.triangles),
    geometries: num(info?.geometries),
    textures: num(info?.textures),
    frameEmaMs: num(info?.frameEmaMs),
    frameMaxMs: num(info?.frameMaxMs),
    heapUsedB: num(info?.heapUsedB),
    heapLimitB: num(info?.heapLimitB),
  };
}

/** Create a per-model buffer registry. Capacity clamps to ≥ 1. */
export function createModelBuffers(capacity: number = DEFAULT_CAPACITY): ModelBuffers {
  const cap =
    Number.isFinite(capacity) && capacity > 0
      ? Math.floor(capacity)
      : DEFAULT_CAPACITY;
  const rings = new Map<string, RingBuffer<RendererInfoLike>>();

  return {
    open(modelId) {
      safe(() => {
        const id = String(modelId);
        if (!rings.has(id)) rings.set(id, new RingBuffer<RendererInfoLike>(cap));
      }, "openModelBuffer failed");
    },

    close(modelId) {
      safe(() => {
        rings.delete(String(modelId));
      }, "closeModelBuffer failed");
    },

    has(modelId) {
      return (
        safe(() => rings.has(String(modelId)), "hasModelBuffer failed") ?? false
      );
    },

    record(modelId, info) {
      safe(() => {
        const ring = rings.get(String(modelId));
        if (!ring) return; // unopened/closed → drop (no leak)
        ring.push(normalize(info));
      }, "recordModelBuffer failed");
    },

    get(modelId) {
      return safe(() => {
        const ring = rings.get(String(modelId));
        return ring ? ring.toArray() : undefined;
      }, "getModelBuffer failed");
    },

    openModelIds() {
      return (
        safe(() => Array.from(rings.keys()).sort(), "openModelIds failed") ?? []
      );
    },

    count() {
      return safe(() => rings.size, "countModelBuffers failed") ?? 0;
    },
  };
}

/** One report line: fixed field order, floats to 2 dp, ints rounded. */
function formatReportLine(r: RendererInfoLike): string {
  const drawCalls = Math.round(num(r.drawCalls));
  const triangles = Math.round(num(r.triangles));
  const geometries = Math.round(num(r.geometries));
  const textures = Math.round(num(r.textures));
  const frameEmaMs = num(r.frameEmaMs).toFixed(2);
  const frameMaxMs = num(r.frameMaxMs).toFixed(2);
  const heapUsedB = Math.round(num(r.heapUsedB));
  const heapLimitB = Math.round(num(r.heapLimitB));
  return (
    `drawCalls=${drawCalls} triangles=${triangles} geometries=${geometries} ` +
    `textures=${textures} frameEmaMs=${frameEmaMs} frameMaxMs=${frameMaxMs} ` +
    `heapUsed=${heapUsedB}/${heapLimitB}`
  );
}

/**
 * Assemble the renderer report (RendererDiagnostics.GetRendererReport
 * analog). Byte-stable: deterministic ordering (models + snapshots
 * sorted by key), fixed field order, floats pinned to 2 dp, snapshot
 * `ts` dropped, and no other timestamps introduced.
 */
export function getRendererReport(input: RendererReportInput): string {
  return (
    safe(() => {
      const lines: string[] = [];
      lines.push(
        `Lost device: ${Math.round(num(input.deviceLostCount))} times / ` +
          `Active views: ${input.buffers.count()}`,
      );

      for (const id of input.buffers.openModelIds()) {
        lines.push("");
        lines.push(`model:${id}`);
        const reports = input.buffers.get(id) ?? [];
        reports.forEach((report, i) => {
          const marker = i === reports.length - 1 ? " (Latest)" : "";
          lines.push(`[${i}]${marker} ${formatReportLine(report)}`);
        });
      }

      lines.push("");
      lines.push("snapshots:");
      const snaps = (input.snapshots ?? []).map((s) => ({
        key: String(s.key),
        data: (s.data ?? {}) as Record<string, unknown>,
      }));
      snaps.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const s of snaps) {
        lines.push(`  ${s.key}: ${JSON.stringify(s.data)}`);
      }

      return lines.join("\n");
    }, "getRendererReport failed") ?? ""
  );
}