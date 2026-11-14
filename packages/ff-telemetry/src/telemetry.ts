// createTelemetry — the core breadcrumb / snapshot / device-lost
// state machine. Zero deps, no DOM at module load (device tags are
// collected lazily and guardedly). Never throws into callers.

import { RingBuffer } from "./ringBuffer";
import { safe } from "./safe";
import { deviceTags } from "./deviceTags";
import {
  createModelBuffers,
  getRendererReport as buildRendererReport,
  type ModelBuffers,
  type RendererInfoLike,
} from "./modelBuffers";

export interface Breadcrumb {
  /** Epoch millis when the breadcrumb was recorded. */
  ts: number;
  category: string;
  action: string;
  data?: Record<string, unknown>;
}

export interface Snapshot {
  /** Epoch millis when the snapshot was taken. */
  ts: number;
  key: string;
  data: Record<string, unknown>;
}

/** The serializable bundle that flies off the tablet (localStorage
 *  or clipboard, never the network in v1). */
export interface TelemetryBundle {
  startedAt: number;
  breadcrumbs: Breadcrumb[];
  snapshots: Snapshot[];
  deviceLostCount: number;
  tags: Record<string, unknown>;
}

export interface TelemetryOptions {
  /** Breadcrumb ring capacity. Default 100. */
  maxBreadcrumbs?: number;
  /** Snapshot-history ring capacity. Default 60. */
  maxSnapshots?: number;
}

export interface Telemetry {
  /** Record a timestamped breadcrumb into the ring buffer. */
  breadcrumb(
    category: string,
    action: string,
    data?: Record<string, unknown>,
  ): void;

  /** Record a latest-per-key snapshot (" (Latest)" idea). The
   *  history of snapshots is ring-buffered (capped at maxSnapshots)
   *  but the *latest* value for each key is always reachable. */
  snapshot(key: string, data: Record<string, unknown>): void;

  /** Count a WebGL context loss + emit an auto breadcrumb. */
  noteDeviceLost(): void;

  /** Emit a restored breadcrumb (loss counter is NOT decremented —
   *  it's a lifetime counter for forensics). */
  noteDeviceRestored(): void;

  /** The number of context-lost events so far (lifetime, "at least"). */
  readonly deviceLostCount: number;

  /** Assemble the current bundle. Never throws. */
  getBundle(): TelemetryBundle;

  /** Open a per-model renderer ring buffer (capacity 2, capacity
   *  reports; `" (Latest)"` marker on render). Idempotent. */
  openModelBuffer(modelId: string): void;

  /** Close (destroy) a per-model ring buffer. Removed on close; a
   *  later reopen of the same id starts fresh. */
  closeModelBuffer(modelId: string): void;

  /** Append a renderer-info report into a model's ring buffer. No-op
   *  when the model is unopened/closed. */
  recordModelBuffer(modelId: string, info: RendererInfoLike): void;

  /** RendererDiagnostics.GetRendererReport analog — `"Lost device: N
   *  times / Active views: M"` header + all model ring buffers +
   *  latest snapshots, byte-stable. Never throws. */
  getRendererReport(): string;
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const maxBreadcrumbs = options.maxBreadcrumbs ?? 100;
  const maxSnapshots = options.maxSnapshots ?? 60;

  const startedAt = Date.now();

  const breadcrumbs = new RingBuffer<Breadcrumb>(
    Number.isFinite(maxBreadcrumbs) && maxBreadcrumbs > 0 ? maxBreadcrumbs : 100,
  );
  const snapshots = new RingBuffer<Snapshot>(
    Number.isFinite(maxSnapshots) && maxSnapshots > 0 ? maxSnapshots : 60,
  );
  // Latest-per-key map (the " (Latest)" idea). The ring above
  // is the bounded history; this map is the O(1) latest lookup.
  const latestSnapshots = new Map<string, Snapshot>();

  let deviceLostCount = 0;

  // Tags collected once, lazily, guarded. If collection throws
  // (never should — deviceTags catches per-field), we fall back to
  // an empty object rather than failing the instance.
  let tags: Record<string, unknown> | null = null;

  const modelBuffers: ModelBuffers = createModelBuffers();

  const telemetry: Telemetry = {
    breadcrumb(category, action, data) {
      safe(() => {
        breadcrumbs.push({
          ts: Date.now(),
          category: String(category),
          action: String(action),
          data,
        });
      }, "breadcrumb failed");
    },

    snapshot(key, data) {
      safe(() => {
        const snap: Snapshot = {
          ts: Date.now(),
          key: String(key),
          data: data ?? {},
        };
        snapshots.push(snap);
        latestSnapshots.set(snap.key, snap);
      }, "snapshot failed");
    },

    noteDeviceLost() {
      safe(() => {
        deviceLostCount += 1;
        breadcrumbs.push({
          ts: Date.now(),
          category: "renderer",
          action: "device-lost",
        });
      }, "noteDeviceLost failed");
    },

    noteDeviceRestored() {
      safe(() => {
        breadcrumbs.push({
          ts: Date.now(),
          category: "renderer",
          action: "device-restored",
        });
      }, "noteDeviceRestored failed");
    },

    get deviceLostCount() {
      return deviceLostCount;
    },

    getBundle() {
      return safe(
        () => {
          if (tags === null) {
            tags = deviceTags();
          }
          return {
            startedAt,
            breadcrumbs: breadcrumbs.toArray(),
            snapshots: snapshots.toArray(),
            deviceLostCount,
            tags: tags as Record<string, unknown>,
          };
        },
        "getBundle failed",
      ) as TelemetryBundle;
    },

    openModelBuffer(modelId) {
      safe(() => modelBuffers.open(String(modelId)), "openModelBuffer failed");
    },

    closeModelBuffer(modelId) {
      safe(() => modelBuffers.close(String(modelId)), "closeModelBuffer failed");
    },

    recordModelBuffer(modelId, info) {
      safe(
        () => modelBuffers.record(String(modelId), info ?? {}),
        "recordModelBuffer failed",
      );
    },

    getRendererReport() {
      return (
        safe(
          () =>
            buildRendererReport({
              deviceLostCount,
              buffers: modelBuffers,
              snapshots: Array.from(latestSnapshots.values()),
            }),
          "getRendererReport failed",
        ) ?? ""
      );
    },
  };

  return telemetry;
}