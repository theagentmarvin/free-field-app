// Viewer telemetry seam — wires @ff/telemetry into the FreeField
// viewer without any `three` import (structural types only, so the
// drift linter stays green). Owns the module singleton; the IfcViewer
// calls `ensureViewerTelemetry()` + `attachViewerTelemetry(...)` once
// after the renderer exists and detaches in cleanup.
//
// Wave 18 (U7, Architect-owned integration): the seam is now the
// single cleanup owner for everything device-bound —
//   - registers the module singleton (§4.3 `getGlobalTelemetry()`) so
//     route crumbs, the Channel-A report attachment, escalation sinks
//     and the post-mortem all resolve the same instance;
//   - context loss/restore goes through U3's `attachContextEvents`
//     (first-class crumbs + >2-losses escalation → Channel-A
//     captureMessage; inline listeners replaced to avoid
//     double-counting);
//   - U2's rAF `startFrameTimer` runs per attached world (the sampler
//     consumes its EMA/percentiles);
//   - §5.3 persist adapter: v1 localStorage path stays the default
//     (`config.storage` unset/'local'); 'indexeddb' mirrors
//     bundle+watermarks into the `ff-forensics` DB with the
//     quota-exceeded localStorage fallback baked into U4;
//   - `pagehide` → final `persist(force)` so a tab close leaves the
//     freshest ring on disk (spec §6 row `pagehide`).
// The app shell (not the viewer) fires `initTelemetry(cfg)` — see
// apps/settings/src/telemetry/boot.ts (spec §6 row Mount).

import {
  createTelemetry,
  installBootFlag,
  installErrorListeners,
  attachWindowHooks,
  attachSentryBreadcrumbBridge,
  deviceTags,
  startRendererSampler,
  startFrameTimer,
  attachContextEvents,
  captureTelemetryMessage,
  setGlobalTelemetry,
  getTelemetryStorageKind,
  persist,
  persistBundleToStorage,
  createBundleIdbStorage,
  openForensicsStore,
  safe,
  type BundleStorage,
  type Telemetry,
} from "@ff/telemetry";

/** Minimal renderer surface the sampler reads from. `renderer.info`
 *  is a stable Three.js shape; we only declare the fields we read so
 *  this module never imports `three`. */
export interface RendererInfoLike {
  info?: {
    render?: { calls?: number; triangles?: number };
    memory?: { geometries?: number; textures?: number };
  };
}

/** Minimal canvas surface for the context-lost/restored listeners. */
export interface CanvasEventTargetLike {
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

function isDev(): boolean {
  try {
    return (
      (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
    );
  } catch {
    return false;
  }
}

// Module singleton. Lazily created; the local path is always on (v1
// behaviour: console/localStorage, negligible cost). Wave 18 network
// channels only activate once the app shell ran initTelemetry with a
// DSN — the seam itself never touches the SDK.
let telemetry: Telemetry | null = null;

/** The IDB bundle storage adapter, created once on first indexeddb
 *  persist (private-mode/quota failures degrade inside U4). */
let idbBundle: BundleStorage | null = null;

function bundleStorage(): BundleStorage {
  if (idbBundle === null) {
    idbBundle = createBundleIdbStorage(openForensicsStore());
  }
  return idbBundle;
}

/**
 * Get (or lazily create) the singleton Telemetry + install boot flag,
 * error listeners, and (DEV only) the `window.__ffTelemetry` hooks.
 * Registers the instance in the package singleton registry (§4.3).
 */
export function ensureViewerTelemetry(): Telemetry {
  if (telemetry === null) {
    telemetry = createTelemetry();
    setGlobalTelemetry(telemetry);
    // §4.2 bridge: mirror every viewer crumb (model/section/viewpoint/
    // context/…) into Sentry. The sink resolves LAZILY at breadcrumb
    // time, so this works whether initTelemetry ran before or after
    // the viewer mounted — inert no-op while Channel A is off.
    attachSentryBreadcrumbBridge(telemetry);
    installBootFlag(telemetry);
    installErrorListeners(telemetry);
    if (isDev()) attachWindowHooks(telemetry);
  }
  return telemetry;
}

/**
 * Wire the live renderer/canvas into the telemetry layer:
 *  - U3 context events (first-class crumbs, deviceLostCount,
 *    flapping escalation → Channel-A warning message) — the detach
 *    fn is the SINGLE cleanup owner (spec §9 risk 3);
 *  - U2 rAF frame timer (EMA + percentiles — feeds the sampler);
 *  - the 1 Hz sampler reading `renderer.info.render.*` /
 *    `renderer.info.memory.*` defensively (missing fields → 0);
 *  - §5.3 persist cadence ≥5 s, localStorage by default, mirrored to
 *    IndexedDB when `config.storage === "indexeddb"`;
 *  - pagehide → final forced persist.
 *
 * Returns a detach fn to call on viewer unmount.
 */
export function attachViewerTelemetry(
  rendererThree: RendererInfoLike | null | undefined,
  canvas: CanvasEventTargetLike | null | undefined,
): () => void {
  const t = ensureViewerTelemetry();

  const detachContext = attachContextEvents(canvas, {
    telemetry: t,
    onEscalation: (message, extra) => {
      // Channel-A warning upload (no-op when the DSN is unset).
      captureTelemetryMessage(message, "warning", { ...extra });
    },
  });

  const stopFrameTimer = startFrameTimer();

  const doPersist = (force: boolean): void => {
    safe(() => {
      persist(t, undefined, force);
      if (getTelemetryStorageKind() === "indexeddb") {
        persistBundleToStorage(t, bundleStorage(), force);
      }
    }, "seam persist failed");
  };

  const onPageHide = (): void => {
    doPersist(true);
  };
  let pageHideAttached = false;
  safe(() => {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", onPageHide);
      pageHideAttached = true;
    }
  }, "seam pagehide attach failed");

  const stopSampler = startRendererSampler(t, {
    read: () => {
      // Chrome-only heap watermarks (guarded — other browsers / jsdom
      // have no `performance.memory`). Surfaced so an OOM kill on a
      // site tablet leaves its memory watermark on disk.
      const perfMemory = (
        performance as unknown as {
          memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
        }
      ).memory;
      return {
        drawCalls: rendererThree?.info?.render?.calls ?? 0,
        triangles: rendererThree?.info?.render?.triangles ?? 0,
        geometries: rendererThree?.info?.memory?.geometries ?? 0,
        textures: rendererThree?.info?.memory?.textures ?? 0,
        // Frame-time is now REAL: U2's sampler prefers the rAF
        // frameTimer EMA (started above) over this legacy injected
        // field — the v1 "omitted rather than faked" gap is closed.
        heapUsedB: perfMemory?.usedJSHeapSize,
        heapLimitB: perfMemory?.jsHeapSizeLimit,
      };
    },
    // Persist every 5 s so a hard kill (OOM / tab / OS) leaves the
    // ring-buffer state + memory watermark on disk for next-launch
    // forensics. persist() throttles to ≥ 5 s and skips unchanged.
    persistEveryMs: 5_000,
    persist: () => doPersist(false),
    // §5.4 OOM prediction: low-RAM tablets halve the texture
    // threshold; every crossing also becomes a Channel-A warning
    // captureMessage ("oom-risk") — inert no-op while DSN is unset.
    deviceMemoryGB: (() => {
      const tags = deviceTags() as Record<string, unknown> | null;
      const dm = tags?.deviceMemory;
      return typeof dm === "number" && Number.isFinite(dm) ? dm : undefined;
    })(),
    onOomRisk: (data) => {
      captureTelemetryMessage("oom-risk", "warning", data);
    },
  });

  return () => {
    safe(() => {
      if (pageHideAttached && typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
    }, "seam pagehide detach failed");
    detachContext();
    stopFrameTimer();
    stopSampler();
  };
}

/**
 * Per-model renderer ring buffer (§4.3/§5.2): open on load-complete,
 * close on dispose. Idempotent; safe(); IfcViewer call sites only.
 */
export function openViewerModelBuffer(modelId: string): void {
  safe(() => ensureViewerTelemetry().openModelBuffer(modelId), "openViewerModelBuffer failed");
}

export function closeViewerModelBuffer(modelId: string): void {
  safe(() => ensureViewerTelemetry().closeModelBuffer(modelId), "closeViewerModelBuffer failed");
}

/**
 * Wave 26: ship one `debug-perf-chain` Channel-A info event. Gating is
 * entirely the caller's — only the `?ffdebug=1` DEV arming block in
 * IfcViewer starts the emitter. Kept in the seam so this file stays the
 * single owner of the @ff/telemetry import. No-ops while Channel A is
 * off (survivability law: safe() wraps the capture).
 */
export function shipDebugPerf(payload: Record<string, unknown>): void {
  safe(
    () => captureTelemetryMessage("debug-perf-chain", "info", payload),
    "shipDebugPerf failed",
  );
}
