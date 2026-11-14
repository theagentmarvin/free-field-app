// Wave 19d — opt-in dev debug tools (activated, never always-on).
//
// The wave-19b/19c bug hunt needed live access to the picker
// internals (raw id/depth pass reads at a specific pixel) to find
// the scene.background wipe. Those probes now ship as an explicit
// opt-in surface: nothing is exposed unless the flag is on, so the
// app stays clean by default and the tools are one URL param away
// when the next field report lands.
//
// Activation (the mount site ALSO requires a DEV build — production
// bundles never install the surface):
//   ?ffdebug=1  → enable, and persist for the tab (sessionStorage)
//   ?ffdebug=0  → disable, clear the persisted flag
//   (no param)  → follow the sessionStorage flag
//
// When enabled the viewer installs `window.__ffDebug` with:
//   backend()          → "fast" | "raycaster" | "none"
//   pickAt(x, y)       → runs every GPU pass at a CLIENT pixel and
//                        returns { ndc, item, point, full } — the
//                        exact archaeology that proved the wipe
//   raw                → { picker, world, fragments } live refs for
//                        deeper console spelunking (private TOE
//                        methods included — use with care)

import type { FastElementPicker } from "./pickSeam";

export const DEBUG_TOOLS_STORAGE_KEY = "ff.debug";
export const DEBUG_TOOLS_PARAM = "ffdebug";

/**
 * Pure resolver: given the URL param value and the stored tab flag,
 * is debug mode on? Param wins; `1`/`0` are explicit; anything else
 * falls through to the stored value. Exported for unit tests.
 */
export function resolveDebugToolsEnabled(
  paramValue: string | null,
  storedValue: string | null,
): boolean {
  if (paramValue === "1") return true;
  if (paramValue === "0") return false;
  return storedValue === "1";
}

/**
 * Read the activation state from window (URL param + sessionStorage)
 * and persist a param decision for the rest of the tab. Every access
 * is try/catch — jsdom, privacy modes and worker contexts must never
 * throw from a debug gate.
 */
export function isDebugToolsEnabled(): boolean {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const param = new URLSearchParams(window.location.search).get(
      DEBUG_TOOLS_PARAM,
    );
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(DEBUG_TOOLS_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const enabled = resolveDebugToolsEnabled(param, stored);
    if (param === "1") {
      try {
        window.sessionStorage.setItem(DEBUG_TOOLS_STORAGE_KEY, "1");
      } catch {
        /* private mode — param still applies for this load */
      }
    } else if (param === "0") {
      try {
        window.sessionStorage.removeItem(DEBUG_TOOLS_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    return enabled;
  } catch {
    return false;
  }
}

/**
 * Wave 28 W1 — is the scissored id render allowed? Pure so it is unit
 * testable: the query param wins, `0`/`1` are explicit, anything else
 * (including no param) leaves the optimization ON. The flag exists only
 * to A/B the render on real hardware, where the cost actually being cut
 * (full-frame rasterization) cannot be measured in jsdom.
 */
export function resolveScissorOverride(paramValue: string | null): boolean {
  return paramValue !== "0";
}

/** Read the override from the live URL. Never throws (worker/privacy safe). */
export function isRenderScissorEnabled(): boolean {
  try {
    if (typeof window === "undefined" || !window.location) return true;
    return resolveScissorOverride(
      new URLSearchParams(window.location.search).get("ffscissor"),
    );
  } catch {
    return true;
  }
}

/** Everything the mount site can hand the debug surface. */
export interface DebugToolsContext {
  picker: FastElementPicker | null;
  world: unknown;
  fragments: unknown;
  backend: "fast" | "raycaster" | "none";
  /** The live canvas, resolved lazily (postproduction domElement). */
  getCanvas: () => HTMLCanvasElement | null;
  /**
   * Wave 22: lazy getters for the degradation-hunt stats. The
   * highlighter is created AFTER the debug surface is installed in
   * the mount IIFE, so it must be resolved on read, never captured.
   */
  getHighlighter?: () => unknown;
  getChainStats?: () => ChainCounters | null;
}

/**
 * Wave 22 — per-click chain counters the viewer feeds from its
 * single-flight pick pipeline. Exposed through `stats()` so a
 * degradation curve ("delay grows with click count") can be read
 * straight off the page instead of guessed from console noise.
 */
export interface ChainCounters {
  clicks: number;
  applied: number;
  superseded: number;
  emptyClicks: number;
  lastClickToSelectionMs: number | null;
  lastClickToPointMs: number | null;
  recentClickToSelectionMs: number[];
  /**
   * Wave 22: duration of the most recent `highlightByID` cycle
   * (clear + material swap + fragments update — the fragments-worker
   * round-trip the NEXT click's getItemAt queues behind). The prime
   * suspect for click-count-proportional delay.
   */
  lastHighlightMs: number | null;
  /** highlightByID cycles currently in flight (queue depth). */
  highlightInFlight: number;
  /** peak in-flight depth observed since load. Post wave-22 this
   *  must stay ≤ 2 — the coalescer's regression guard (it hit 8
   *  when cycles stacked per click). */
  highlightInFlightPeak: number;
  /** times a pending target was replaced by a newer click before
   *  its cycle ran (intermediate selections skipped). */
  highlightCoalesced: number;
  /**
   * Wave 25: total id-pass renders across all clicks (batched path
   * should be 1 per click; the legacy per-probe path is up to 33).
   */
  idPassRenders: number;
  /** id-pass renders paid by the most recent click. */
  lastClickRenders: number;
  /** Wave 27: batched-path throws → per-probe degrade count. */
  degrades?: number;
  /** Wave 27: last degrade reason (stringified); null if never. */
  lastDegradeReason?: string | null;
  /** Wave 27: picks that never settled inside the stall budget. */
  pickTimeouts?: number;
  /**
   * Wave 28: clicks that hit an element but could not be resolved in
   * time (`itemId → localId` outlived LOCAL_ID_BUDGET_MS, or the
   * degraded scan ran out of its budget). No-op outcome: the selection
   * is left exactly as it was. This is the fast replacement for a
   * multi-second stall latch — if it grows, the fragments worker is
   * wedged; if `pickTimeouts` grows instead, something upstream of the
   * translation is hanging.
   */
  inconclusiveClicks?: number;
  /** Worker translations that outlived LOCAL_ID_BUDGET_MS. */
  pickTranslateTimeouts?: number;
  /** Depth passes (tap-to-create anchor) that hit their budget. */
  phase2Timeouts?: number;
  /** Cost breakdown of the LAST pick — the "1 render / 1 readback / ≤1 RPC" tell. */
  lastPickRpcs?: number | null;
  lastPickReadbacks?: number | null;
  lastPickCacheHits?: number | null;
  lastPickBoxRead?: boolean | null;
  /** Wave 31b: why the box readback was skipped for the last click. */
  lastPickBoxDecline?: string | null;
  /** Wave 28 W1: the last id pass was rendered through the probe scissor. */
  lastPickScissor?: boolean | null;
}

/** Everything `stats()` samples — every field null-safe. */
export interface DebugStats {
  backend: string;
  chain: ChainCounters | null;
  highlighter: {
    /** group name → total element ids currently in its selection map */
    selectionGroups: Record<string, number>;
    styles: number;
    eventSubscribers: number;
  } | null;
  picker: {
    originalMaterials: number | null;
    hiddenLods: number | null;
  } | null;
  fragmentsModels: number | null;
  canvases: number;
  heapMB: number | null;
}

/** The shape installed on `window.__ffDebug` when activated. */
export interface DebugToolsSurface {
  backend: () => string;
  pickAt(
    clientX: number,
    clientY: number,
  ): Promise<{
    ndc: { x: number; y: number };
    item: { modelId: string; localId: number } | null;
    point: { x: number; y: number; z: number } | null;
    full: { modelId: string; localId: number } | null;
    error?: string;
  }>;
  raw: { picker: FastElementPicker | null; world: unknown; fragments: unknown };
  /**
   * Wave 22: snapshot of the growth candidates — highlighter
   * selection sizes, picker material-swap bookkeeping, chain
   * latencies, heap. Sample repeatedly while clicking to read a
   * degradation curve. Never throws; unavailable internals come back
   * null.
   */
  stats(): DebugStats;
}

/**
 * Build the debug surface from a context. Pure with respect to the
 * module graph — no three.js import, plain structural objects only
 * (the TOE picker accepts `{x, y}` in place of a Vector2).
 */
export function buildDebugToolsSurface(
  ctx: DebugToolsContext,
): DebugToolsSurface {
  return {
    backend: () => ctx.backend,
    async pickAt(clientX: number, clientY: number) {
      const canvas = ctx.getCanvas();
      if (!canvas || !ctx.picker) {
        return {
          ndc: { x: NaN, y: NaN },
          item: null,
          point: null,
          full: null,
          error: !ctx.picker ? "no fast picker" : "no canvas",
        };
      }
      const rect = canvas.getBoundingClientRect();
      const ndc = {
        x: ((clientX - rect.left) / rect.width) * 2 - 1,
        y: -(((clientY - rect.top) / rect.height) * 2 - 1),
      };
      try {
        const [item, point, full] = await Promise.all([
          ctx.picker.getItemAt(ndc),
          ctx.picker.getPointAt(ndc),
          ctx.picker.getFullPick(ndc),
        ]);
        return {
          ndc,
          item: item
            ? { modelId: item.modelId, localId: item.localId }
            : null,
          point: point ? { x: point.x, y: point.y, z: point.z } : null,
          full: full ? { modelId: full.modelId, localId: full.localId } : null,
        };
      } catch (err) {
        return {
          ndc,
          item: null,
          point: null,
          full: null,
          error: String(err),
        };
      }
    },
    raw: { picker: ctx.picker, world: ctx.world, fragments: ctx.fragments },
    stats(): DebugStats {
      const out: DebugStats = {
        backend: ctx.backend,
        chain: null,
        highlighter: null,
        picker: null,
        fragmentsModels: null,
        canvases: 0,
        heapMB: null,
      };
      try {
        out.chain = ctx.getChainStats?.() ?? null;
      } catch {
        /* debug gate never throws */
      }
      try {
        const h = ctx.getHighlighter?.() as {
          selection?: Record<string, Record<string, Set<number>>>;
          styles?: { list?: { size?: number }; size?: number };
          eventManager?: { list?: { size?: number; length?: number } };
        } | null;
        if (h) {
          const groups: Record<string, number> = {};
          for (const [g, byModel] of Object.entries(h.selection ?? {})) {
            let n = 0;
            for (const ids of Object.values(byModel)) n += ids?.size ?? 0;
            groups[g] = n;
          }
          out.highlighter = {
            selectionGroups: groups,
            styles: h.styles?.list?.size ?? h.styles?.size ?? -1,
            eventSubscribers: h.eventManager?.list?.size ?? h.eventManager?.list?.length ?? -1,
          };
        }
      } catch {
        /* shape drift across TOE versions — leave null */
      }
      try {
        const p = ctx.picker as unknown as {
          _originalMaterials?: Map<unknown, unknown>;
          _hiddenLods?: unknown[];
        } | null;
        if (p) {
          out.picker = {
            originalMaterials: p._originalMaterials?.size ?? null,
            hiddenLods: p._hiddenLods?.length ?? null,
          };
        }
      } catch {
        /* private TOE internals — best-effort */
      }
      try {
        // FragmentsManager exposes `list` directly (delegated from
        // core) in TOE 3.4.x — read both shapes defensively so a
        // version drift returns null, never a false "no models".
        const f = ctx.fragments as { list?: { size?: number }; core?: { list?: { size?: number } } } | null;
        out.fragmentsModels = f?.list?.size ?? f?.core?.list?.size ?? null;
      } catch {
        /* ignore */
      }
      try {
        out.canvases =
          typeof document !== "undefined" ? document.querySelectorAll("canvas").length : 0;
      } catch {
        /* non-DOM context */
      }
      try {
        const mem = (performance as unknown as {
          memory?: { usedJSHeapSize: number };
        }).memory;
        out.heapMB = mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
      } catch {
        /* Chrome-only */
      }
      return out;
    },
  };
}
