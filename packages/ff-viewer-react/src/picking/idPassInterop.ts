// Wave 25 — TOE-interop boundary for the batched id pass.
//
// Wave 45: this file is now the FALLBACK-only pick backend. The worker
// virtual raycast (`FragmentsManager.raycast`, see picking/pickSeam.ts)
// is PRIMARY — it needs no applied tiles. The batched id pass (and the
// per-probe `getItemAt` degrade below it) runs only when the raycast is
// absent, threw, or timed out. Its ring-tolerance scan + the
// `LOCAL_ID_BUDGET_MS` itemId→localId latch are PRESERVED UNCHANGED for
// exactly that fallback role — do not delete them.
//
// Everything the batched tolerant pick needs lives in PRIVATE
// `@thatopen/components@3.4.6` internals: `_renderTarget`,
// `_renderTargetSize`, `_idMaterial`, `applyIdMaterial()`,
// `renderIdPass()`/`renderPickPass()` (4-px scissored), and
// `readPixelAt()` (see `orchestration/reviews/wave25-warm-pick-
// buffer-critic.md` evidence index: `index.d.ts:2958`, `:3105–3200`;
// runtime fields reachable at `index.mjs:12503+`).
//
// This file is the SINGLE sanctioned seam (`toe-drift-check` rule 14
// forbids `as any` access to `@thatopen/*` private members anywhere
// else). Everything is reached through one `as any` façade confined
// to this file, with runtime shape detection at construction:
//   - all required internals present  → `mode: "batched"`
//   - anything missing (TOE upgrade)  → `mode: "unavailable"` and the
//     caller silently falls back to today's per-probe `getItemAt`.
//
// The batched read renders the id pass ONCE at full frame (CSS-sized
// target — the picker's OWN `_renderTarget`; we never allocate a second
// full-frame target, per the wave-22 heap-accumulation guard), then
// reads every probe pixel back from that one render. This collapses the
// 33-render worst case (empty-space / thin-MEP miss) into 1 render.
//
// Wave 28 collapsed the REST of the click cost. Measured before the
// change: ONE click on an element that filled its tolerance
// neighbourhood paid 33 fragments-worker round-trips plus 33 synchronous
// `gl.readPixels` stalls — 506 ms with a 15 ms worker, and seconds on the
// field device where every RPC queues behind tile streaming. The reader
// was resolving EVERY probe through `getLocalIdsFromItemIds` even though
// the only consumer takes the FIRST hit.
//
// A read is now: 1 render → 1 bounded GPU readback (a self-checked
// bounding box, never trusted until it has agreed with TOE's own
// `readPixelAt` on a pixel that decoded a hit) → decode all probes
// synchronously → resolve ONE `itemId → localId`, memoized per model so
// a repeat click costs nothing, and bounded by `LOCAL_ID_BUDGET_MS`
// because the engine bounds it not at all.
//
// The invariant that shapes every branch below: an UNKNOWN outcome is
// never reported as empty space. A pixel hit whose translation timed out,
// was rejected by the worker, or belonged to a model that vanished
// mid-call reports `inconclusive: true` — because a false miss clears a
// live selection and persists a wrong anchor to Firestore
// (TapCreateTask3D), which is the one outcome worse than a slow click.

// Raw three is confined to this boundary (same `no-restricted-imports`
// waiver `IfcViewer.tsx` already carries for its camera/matrix casts).
// eslint-disable-next-line no-restricted-imports
import * as THREE from "three";
import * as OBC from "@thatopen/components";

import type { NdcPoint } from "./pickTypes";

/** A decoded, id-resolved element hit — the `getItemAt` result shape. */
export interface IdItem {
  modelId: string;
  localId: number;
}

/**
 * Wave 28 — what one {@link BatchedIdPassReader.read} actually cost.
 * These ride the debug-perf chain counters to Sentry so "why is this
 * click slow" is answered with numbers instead of guesses. Before wave
 * 28 a single click on an element that filled its tolerance
 * neighbourhood cost `{ readbacks: 33, rpcs: 33 }` (measured 506 ms at
 * a 15 ms worker round-trip). Steady state after it: `{ readbacks: 1,
 * rpcs: 1 }` on the first click that hits geometry — the read that
 * proves the bounding-box mapping pays one extra 1×1 comparison, and a
 * repeat click pays `{ rpcs: 0 }` from the cache.
 */
export interface BatchedReadStats {
  /** probes handed to `read()` (1 exact + 4 rings × 8 = 33 in prod). */
  probes: number;
  /** probe pixels that decoded to a real model byte + item id. */
  rawHits: number;
  /** fragments-worker round-trips paid for `itemId → localId`. */
  rpcs: number;
  /** translations served from the per-model cache (no worker touched). */
  cacheHits: number;
  /** Wave 32: the id pass had no registered model at all (nothing streamed). */
  sceneEmpty?: boolean;
  /** synchronous GPU readbacks (1 on the box path, else 1 per probe). */
  readbacks: number;
  /**
   * Wave 31b diagnostic: WHY the single-box readback was not used for the
   * last click, so a fan-out report (readbacks far above 1) is actionable
   * from field data instead of a guess. `null` = the box path was used.
   */
  boxDecline: string | null;
  /** true when a single bounding-box readback served the whole scan. */
  boxRead: boolean;
  /**
   * Wave 28 W1: true when the id pass was rendered through the probe-box
   * scissor instead of the full frame. `scissorVerify` marks the one read
   * that also paid a full-frame control render to prove the region math.
   * Optional so pre-28 stubs keep typechecking.
   */
  scissor?: boolean;
  scissorVerify?: boolean;
  /** translations that outlived {@link LOCAL_ID_BUDGET_MS}. */
  translateTimeouts: number;
  /** wall time of the read, ms. */
  ms: number;
}

/** Outcome of one batched read — wave 28 contract. */
export interface BatchedReadOutcome {
  /**
   * Per-probe hits in scan order. Only the FIRST probe whose
   * `itemId → localId` translation succeeded is populated — resolving
   * the rest is exactly what used to cost 33 serialized worker
   * round-trips per click. `pickElementIdFastTolerant` consumes the
   * first non-null entry, so which element wins is unchanged.
   */
  items: Array<IdItem | null>;
  /**
   * A probe pixel decoded to a real element, but the click's outcome is
   * unknowable: the translation never settled inside
   * {@link LOCAL_ID_BUDGET_MS} (a wedged worker), the worker REJECTED it
   * (an alive-but-erroring decoder — `ConnectionHandlers.newHandler`
   * rejects on `errorInfo`, `fragments:28551–28557`), or the model
   * vanished mid-call.
   *
   * Callers MUST treat the click as UNKNOWN, never as empty space:
   * clearing the selection here would wipe a genuine hit and let
   * tap-to-create persist a wrong anchor. A live model that legitimately
   * answers "this item has no express id" is NOT this case — that is a
   * real miss, and the scan continues past it exactly as wave 25 did.
   */
  inconclusive: boolean;
  stats: BatchedReadStats;
}

/**
 * A single-render batched probe reader. `read()` renders the id pass
 * once (full frame) and decodes every requested probe pixel from that
 * one target, returning results in input order. `totalRenders` is the
 * render counter the seam test asserts (33 probes ⇒ exactly 1 render).
 */
export interface BatchedIdPassReader {
  read(ndcs: readonly NdcPoint[]): Promise<BatchedReadOutcome>;
  totalRenders: number;
  /**
   * Wave 28: stats of the most recent {@link read}, for the chain
   * counters / Sentry `debug-perf-chain` payload. Optional so stubs and
   * pre-28 mocks stay valid.
   */
  lastStats?: BatchedReadStats | null;
}

export interface IdPassInterop {
  mode: "batched" | "unavailable";
  reader: BatchedIdPassReader | null;
}

/**
 * Wave 28 — budget for the ONE fragments-worker round-trip a pick
 * needs. `itemId → localId` is the only await left in the batched
 * path, and the engine gives it no timeout at all: `_FragmentsModel
 * .getLocalIdsFromItemIds` → `threads.invoke` → `fetch`
 * (`@thatopen/fragments/dist/index.mjs:19822, 17932, 36004`) — a bare
 * `await response` on a worker message. A wedged worker therefore never
 * settles, and the wave-27 chain guard paid the full 4000 ms before
 * releasing the click. Past this budget the read returns
 * `inconclusive: true` and the chain hands its latch straight back in
 * milliseconds; the abandoned call keeps running (ignoring it costs
 * nothing).
 *
 * Sized for the field device (Intel HD 620, 4 cores): the lookup
 * itself is a one-element flatbuffer read, but it queues behind tile
 * streaming in the same worker, and a single queued tile decode runs
 * ~100–400 ms there. 600 ms clears normal congestion, catches a real
 * wedge, and keeps the whole pick far inside the stall budget.
 */
export const LOCAL_ID_BUDGET_MS = 600;

/**
 * Per-model cap for the `itemId → localId` cache. A federated scene
 * clicks the same handful of elements repeatedly; 512 entries per
 * model is ~8 KB and evicting the whole bucket on overflow stays
 * leak-proof without an LRU on the hot path.
 */
const LOCAL_ID_CACHE_CAP = 512;

/**
 * Slack around the probe box. The readback and the clip are computed from
 * the same integer mapping now that a bound target's scissor is applied
 * unscaled, so this is cheap insurance against a one-pixel disagreement
 * (an off-by-one in a future three release, a rounding change) rather than
 * a compensation for a known transform.
 */
const SCISSOR_PAD_PX = 2;

/**
 * Ceiling on the scissored id render (256×256 px). Production probes span
 * ±8 px ⇒ ~19×19 with padding. Beyond this the probes were scattered
 * across the frame by absurd NDC and the scissor saves nothing worth the
 * risk, so the full-frame render is used instead.
 */
const MAX_RENDER_BOX_PX = 256 * 256;

/**
 * Cap on the number of per-model buckets held by one reader. Each
 * bucket pins the model instance it was learned from (that identity tag
 * is the stale-reload guard), so the bucket COUNT needs its own bound,
 * not just the bucket size.
 */
const LOCAL_ID_MODEL_CAP = 32;

/**
 * A per-model `itemId → localId` bucket, tagged with the model instance
 * it was learned from.
 *
 * The tag is not decoration (wave-28 review): a reader lives for the
 * life of a mount, and a model can be unloaded and reloaded under the
 * SAME `modelId` with a different internal layout. Checking only that
 * the id is still present in `FragmentsManager.list` would keep serving
 * the stale mapping forever — a repeat click on a reloaded model would
 * tint one element while the anchor persisted for another. Instance
 * identity catches that; presence alone cannot.
 */
interface LocalIdBucket {
  model: unknown;
  ids: Map<number, number>;
}

/** modelId → bucket. */
type LocalIdCache = Map<string, LocalIdBucket>;

/** The live model object for `modelId`, or null when it is gone. */
function currentModel(p: FastPickerInternals, modelId: string): unknown {
  try {
    const fragments = p.components?.get?.(OBC.FragmentsManager) as
      | { list?: { get?: (id: string) => unknown } }
      | undefined;
    return fragments?.list?.get?.(modelId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cached express id for `itemId`, or `undefined` when there is no
 * bucket, the bucket belongs to a dead model instance, or this item was
 * never translated.
 */
function cachedLocalId(
  p: FastPickerInternals,
  cache: LocalIdCache,
  modelId: string,
  itemId: number,
): number | undefined {
  const bucket = cache.get(modelId);
  if (!bucket) return undefined;
  if (bucket.model !== currentModel(p, modelId)) {
    // Reload / dispose: this bucket describes a model that no longer
    // exists, even though the same id is back in the list.
    cache.delete(modelId);
    return undefined;
  }
  return bucket.ids.get(itemId);
}

/**
 * Resolve `work` inside {@link LOCAL_ID_BUDGET_MS}, as a tagged result.
 * Exported because BOTH halves of the pick path need it: the batched
 * reader's single translation, and the degraded per-probe `getItemAt`
 * loop in `pickSeam.ts` (each of whose calls is one of these
 * round-trips).
 *
 * `work` rejections propagate — a real error is never laundered into a
 * timeout. The timer is always cleared, and it is `globalThis`'s so the
 * seam keeps working if this module is ever bundled into a worker.
 */
export async function raceLocalId<T>(
  work: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await new Promise<{ ok: true; value: T } | { ok: false }>(
      (resolve, reject) => {
        timer = globalThis.setTimeout(
          () => resolve({ ok: false }),
          LOCAL_ID_BUDGET_MS,
        );
        work.then(
          (value) => resolve({ ok: true, value }),
          reject,
        );
      },
    );
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

/**
 * The private-internals slice the batched read reaches. Every field is
 * the runtime shape TOE 3.4.6 actually exposes (typed loosely on purpose
 * — this IS the drift boundary).
 */
interface FastPickerInternals {
  enabled?: boolean;
  world?: {
    renderer?: { three?: unknown };
    scene?: { three?: unknown };
    camera?: { three?: unknown };
  };
  components?: { get?: (c: unknown) => unknown };
  _renderTarget?: unknown;
  _renderTargetSize?: { x?: unknown; y?: unknown };
  _idMaterial?: unknown;
  applyIdMaterial?: () => Map<number, string>;
  restoreOriginalMaterials?: () => void;
  /**
   * TOE's private single-pixel readback. Declared with NO `this`
   * parameter on purpose: it must be invoked as
   * `p.readPixelAt?.call(p, target, ndc)` — extracted-and-unbound calls
   * throw against the live implementation (wave-25b regression guard,
   * pinned by a test).
   */
  readPixelAt?: (target: unknown, ndc?: NdcPoint) => Uint8Array | null;
}

/** Options for {@link detectIdPassInterop}. */
export interface IdPassOptions {
  /**
   * Allow the scissored id render (wave 28 W1). Defaults to allowed; pass
   * `false` (from `?ffscissor=0`) to A/B the optimization on real hardware.
   * Even when allowed, the scissor still has to PROVE itself against a
   * full-frame control before a click is ever answered from it.
   */
  scissor?: boolean;
}

/**
 * Runtime shape detection. Throws nothing: any missing/mismatched member
 * degrades to `unavailable`, so a TOE bump that renames a private field
 * silently returns the caller to the existing per-probe `getItemAt` path.
 */
export function detectIdPassInterop(
  picker: unknown,
  opts: IdPassOptions = {},
): IdPassInterop {
  const p = picker as FastPickerInternals | null | undefined;
  let batched = false;
  try {
    batched =
      p !== null &&
      p !== undefined &&
      p._renderTarget !== null &&
      p._renderTarget !== undefined &&
      p._renderTargetSize !== null &&
      p._renderTargetSize !== undefined &&
      typeof (p._renderTargetSize as { x?: number }).x === "number" &&
      typeof (p._renderTargetSize as { y?: number }).y === "number" &&
      p._idMaterial !== null &&
      p._idMaterial !== undefined &&
      typeof p.applyIdMaterial === "function" &&
      typeof p.restoreOriginalMaterials === "function" &&
      typeof p.readPixelAt === "function" &&
      p.world !== null &&
      p.world !== undefined &&
      p.world.renderer !== null &&
      p.world.renderer !== undefined &&
      p.world.renderer.three !== null &&
      p.world.renderer.three !== undefined &&
      p.world.scene?.three != null &&
      p.world.camera?.three != null &&
      p.components != null &&
      typeof p.components.get === "function";
  } catch {
    batched = false;
  }

  if (!batched || p == null) {
    return { mode: "unavailable", reader: null };
  }

  const reader = createBatchedReader(p, opts);
  return { mode: "batched", reader };
}

/**
 * Probe pixel → target-space integer coordinates, replicating TOE's
 * private `readPixelAt` math exactly (`index.mjs:13036–13053`): floor
 * the NDC mapping, then clamp into `[0, size-1]`. Same math ⇒ the box
 * readback lands on the identical pixels the per-probe path would have
 * read — which is what makes the two paths interchangeable.
 *
 * Non-finite NDC returns `null` rather than NaN coordinates: `NaN`
 * clamps are neither `< 0` nor `>= size`, so an unguarded NaN offset
 * indexes pixel 0 of the box and decodes SOME OTHER probe's pixel as a
 * confident hit.
 */
function probePixel(
  ndc: NdcPoint,
  size: { x: number; y: number },
): { x: number; y: number } | null {
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
  const x = Math.floor((ndc.x + 1) * 0.5 * size.x);
  const y = Math.floor((ndc.y + 1) * 0.5 * (size.y - 1));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(0, Math.min(size.x - 1, x)),
    y: Math.max(0, Math.min(size.y - 1, y)),
  };
}

function createBatchedReader(
  p: FastPickerInternals,
  opts: IdPassOptions = {},
): BatchedIdPassReader {
  let totalRenders = 0;
  /** modelId → the model instance its bucket was learned from + the
   *  itemId → localId pairs cached for it. Repeat clicks must cost 0 RPCs. */
  const localIds = new Map<string, LocalIdBucket>();
  /**
   * Probation state for the READBACK: may one bounding-box
   * `readRenderTargetPixels` answer for the whole scan? Promoted only
   * after it agrees, byte for byte, with TOE's own `readPixelAt` on a
   * pixel that decoded a HIT; demoted to `off` for good on disagreement.
   */
  let boxRead: "pending" | "on" | "off" = "pending";
  /**
   * Probation state for the RENDER (wave 28 W1): may the scissored id pass
   * produce the pixels at all? Same rule, stricter proof — it is compared
   * against a full-frame render of the same probes. A scissor that lands
   * where the probes are not reads VOID over real geometry, and void is
   * the one answer nothing ever questions afterwards: it clears a live
   * selection and anchors a task at nothing.
   */
  let scissorMode: "pending" | "on" | "off" =
    opts.scissor === false ? "off" : "pending";
  /** The target size the proofs were made at; a resize re-arms both. */
  let verifiedSize: { x: number; y: number } | null = null;
  let lastStats: BatchedReadStats | null = null;

  return {
    get totalRenders() {
      return totalRenders;
    },
    get lastStats() {
      return lastStats;
    },
    async read(ndcs) {
      const t0 = performance.now();
      const stats: BatchedReadStats = {
        probes: ndcs.length,
        rawHits: 0,
        rpcs: 0,
        cacheHits: 0,
        readbacks: 0,
      boxDecline: null,
      sceneEmpty: false,
        boxRead: false,
        scissor: false,
        scissorVerify: false,
        translateTimeouts: 0,
        ms: 0,
      };
      // Publish the stats object up front: a read that throws before any
      // pixel is touched must not leave the chain reporting the PREVIOUS
      // click's numbers for the click that just failed.
      lastStats = stats;
      const items: Array<IdItem | null> = new Array(ndcs.length).fill(null);
      // Wave 32: did this click even have a scene to pick? `applyIdMaterial`
      // returns an EMPTY map when no model has streamed tiles into the
      // scene yet — measured on a 38 MB MEP model: 8,201 items known to
      // the worker, 0 tile meshes in the scene, byte map empty. Reporting
      // "no hits" from that is NOT evidence of empty space, and the caller
      // acts on empty space by CLEARING the live selection. Flag it and the
      // outcome becomes inconclusive instead: the click is dropped, the
      // selection survives.
      let sceneHadNoModels = false;
      const done = (inconclusive: boolean): BatchedReadOutcome => {
        // Nothing to pick is its own kind of unknown, never a confirmed
        // miss.
        const eff = inconclusive || sceneHadNoModels;
        stats.ms = Math.round(performance.now() - t0);
        return { items, inconclusive: eff, stats };
      };

      // TOE's own guards (`index.mjs:12741–12743`): disabled picker or
      // missing target ⇒ silent miss (identical to `getItemAt`'s null).
      if (p.enabled === false) return done(false);
      if (p._renderTarget == null) return done(false);
      const renderer = p.world?.renderer?.three ?? null;
      if (renderer == null) return done(false);

      let fragments: { initialized?: boolean; list?: { size?: number } };
      try {
        fragments = (
          p.components?.get?.(OBC.FragmentsManager) ?? {
            initialized: false,
            list: { size: 0 },
          }
        ) as { initialized?: boolean; list?: { size?: number } };
      } catch {
        fragments = { initialized: false, list: { size: 0 } };
      }
      if (!fragments.initialized || !fragments.list?.size) return done(false);

      const target = p._renderTarget;
      const sizeNow = p._renderTargetSize as
        | { x?: number; y?: number }
        | undefined;
      if (
        verifiedSize &&
        sizeNow &&
        (verifiedSize.x !== sizeNow.x || verifiedSize.y !== sizeNow.y)
      ) {
        // The canvas was resized: whatever was proven at the old geometry
        // is not proven now. Both checks go back on probation.
        boxRead = "pending";
        scissorMode = "pending";
        verifiedSize = null;
      }

      // ── Decode the probes out of whatever is currently in the target ──
      // Pure CPU + GL readback. The ONLY await in the whole read is the
      // single translation further down: wave 25's loop awaited one per
      // probe (33 serialized round-trips per click, measured 506 ms at a
      // 15 ms worker), and that fan-out was the click→highlight delay.
      const decodeHits = (byteToModel: Map<number, string>): RawHit[] => {
        const viaProbeReads = (): RawHit[] => {
          const hits: RawHit[] = [];
          for (let i = 0; i < ndcs.length; i += 1) {
            const ndc = ndcs[i];
            if (!ndc) continue;
            // Wave-25b REGRESSION GUARD: the live TOE `readPixelAt`
            // dereferences `this.world` internally. Extracting the
            // method into a local and calling it unbound throws on a
            // real picker (crashed the wave-25 rig on every click;
            // invisible to standalone-function mocks). It MUST be
            // invoked with the picker as receiver via .call(p, ...).
            stats.readbacks += 1;
            const hit = decodeBytes(
              byteToModel,
              p.readPixelAt?.call(p, target, ndc) ?? null,
            );
            if (!hit) continue;
            hits.push({ index: i, ...hit });
          }
          return hits;
        };

        const box = readProbeBox(p, renderer, target, ndcs, boxRead, stats);
        if (!box) return viaProbeReads();

        const raw = decodeBoxHits(p, box, byteToModel, ndcs);
        if (boxRead === "on") {
          stats.boxRead = true;
          return raw;
        }
        if (raw.length === 0) {
          // UNVERIFIED box claiming empty space — never believed. Run the
          // authoritative per-probe scan; if it finds geometry the box
          // missed, the mapping is wrong and the box is off for good.
          const truth = viaProbeReads();
          if (truth.length > 0) boxRead = "off";
          return truth;
        }
        // ── Proof on a pixel that can actually disagree ───────────
        // An all-void agreement proves nothing (cleared memory equals
        // cleared memory), and one agreeing probe does not prove the
        // others — so the comparison happens on a probe that decoded a HIT.
        const hitNdc = ndcs[raw[0].index];
        let agrees = false;
        if (hitNdc) {
          try {
            stats.readbacks += 1;
            const viaToe = p.readPixelAt?.call(p, target, hitNdc) ?? null;
            const viaBox = boxPixelsAt(p, box, hitNdc);
            agrees =
              !!viaToe &&
              !!viaBox &&
              viaToe[0] === viaBox[0] &&
              viaToe[1] === viaBox[1] &&
              viaToe[2] === viaBox[2] &&
              viaToe[3] === viaBox[3];
          } catch {
            agrees = false;
          }
        }
        if (!agrees) {
          boxRead = "off";
          return viaProbeReads();
        }
        boxRead = "on";
        if (sizeNow) {
          verifiedSize = { x: sizeNow.x as number, y: sizeNow.y as number };
        }
        stats.boxRead = true;
        return raw;
      };

      // ── One scan = apply → render → restore → decode ────────────
      // A function because W1 runs it twice — once through the scissor,
      // once full-frame — to prove the scissor on a click that actually
      // hit geometry before ever trusting it again.
      const runScan = (renderBox: RenderBox | null): RawHit[] => {
        const byteToModel = p.applyIdMaterial?.() ?? new Map<number, string>();
        if (byteToModel.size === 0) {
          p.restoreOriginalMaterials?.();
          sceneHadNoModels = true;
          stats.sceneEmpty = true;
          return [];
        }
        try {
          renderIdPass(p, byteToModel, renderBox);
        } catch (err) {
          // Wave-25b: a render failure REJECTS the read so the seam
          // degrades to the per-probe getItemAt loop — NEVER a silent
          // all-miss. A spurious miss would clear the selection and
          // persist a wrong anchor to Firestore (TapCreateTask3D).
          // Restore materials first, then reject.
          // eslint-disable-next-line no-console
          if (typeof console !== "undefined") {
            // eslint-disable-next-line no-console
            console.debug("[idPassInterop] batched render failed:", err);
          }
          p.restoreOriginalMaterials?.();
          stats.ms = Math.round(performance.now() - t0);
          throw err;
        }
        p.restoreOriginalMaterials?.();
        totalRenders += 1;
        return decodeHits(byteToModel);
      };

      let renderBox =
        scissorMode === "off"
          ? null
          : scissorRenderBox(p, probeBounds(p, ndcs));
      // Wave 31b: while the scissor is on probation it must be proven
      // against an unclipped control scan. If the box readback is not
      // usable, that proof costs 2 x one-readback-per-probe — the exact
      // fan-out this seam exists to eliminate (68 measured on a 38 MB
      // model, on EVERY click until probation ended). So when the box is
      // unusable we simply do not use an unproven clip: one authoritative
      // full-frame scan, correct result, half the cost.
      if (renderBox && scissorMode === "pending") {
        const usable = boxUsable(p, renderer, target, ndcs, boxRead);
        if (!usable.ok) {
          stats.boxDecline = usable.reason;
          renderBox = null;
        }
      }
      let raw = runScan(renderBox);
      stats.scissor = renderBox != null;

      if (renderBox && scissorMode === "pending") {
        // The control render is mandatory, not conditional on the boxed
        // scan finding something. The failure this guards against is a
        // scissor that lands off the geometry: it decodes a clean EMPTY
        // scan, which is precisely the answer nothing downstream
        // questions — it clears a live selection. Verifying only when the
        // boxed pass found hits would skip the proof for the one outcome
        // that must never be trusted.
        const control = runScan(null);
        stats.scissorVerify = true;
        if (control.length > 0 && sameScan(raw, control)) {
          // Agreement ON REAL GEOMETRY: proven at this size.
          scissorMode = "on";
          if (sizeNow && !verifiedSize) {
            verifiedSize = { x: sizeNow.x as number, y: sizeNow.y as number };
          }
        } else if (!sameScan(raw, control)) {
          // Disagreement — including "scissored void vs. full-frame hits".
          // The control answer ships and the scissor is off for the life of
          // the reader.
          scissorMode = "off";
          raw = control;
        }
        // Both scans void: nothing was proven either way, so stay on
        // probation and compare again on the next click. One extra render
        // per click until the first click that lands on geometry — which,
        // for a pick path, is almost the first click.
      }
      stats.rawHits = raw.length;
      if (raw.length === 0) return done(false); // true empty space

      // ── Translate the first hit only ──────────────────────────────
      // Wave 28: one round-trip, and only when the pixel data cannot
      // already answer. `no-id` keeps scanning (wave-25 parity: an item
      // with no express id is a genuine pass-through miss); anything that
      // makes the outcome UNKNOWABLE — a rejection, a vanished model, a
      // budget expiry — stops with `inconclusive`, because the one thing
      // this path must never do is report a real element as empty space.
      for (const hit of raw) {
        const cached = cachedLocalId(p, localIds, hit.modelId, hit.itemId);
        if (cached !== undefined) {
          stats.cacheHits += 1;
          items[hit.index] = { modelId: hit.modelId, localId: cached };
          return done(false);
        }
        const translated = await raceLocalId(
          resolveLocalId(p, hit.modelId, hit.itemId, localIds),
        );
        stats.rpcs += 1;
        if (!translated.ok) {
          // Never came back. UNKNOWN, not empty space: the click is a
          // no-op, the selection stays, and the chain releases in ~600 ms
          // instead of latching to the 4 s stall guard. See resolveLocalId
          // for why an unsettled call is a real engine outcome, and why
          // abandoning one is the cheaper of the two failures.
          stats.translateTimeouts += 1;
          return done(true);
        }
        const result = translated.value;
        if (result.kind === "hit") {
          items[hit.index] = result.item;
          return done(false);
        }
        if (result.kind === "unknown") return done(true);
        // `no-id` → next decoded hit.
      }
      // Every hit was real geometry with no express id (LOD filler).
      // Same answer wave 25 gave, so selection behavior is unchanged.
      return done(false);
    },
  };
}

/** Two scans agree when they resolve the same probes to the same items. */
function sameScan(a: readonly RawHit[], b: readonly RawHit[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].index !== b[i].index) return false;
    if (a[i].modelId !== b[i].modelId) return false;
    if (a[i].itemId !== b[i].itemId) return false;
  }
  return true;
}


/**
 * Decode every probe out of one already-read bounding box, in scan
 * order. Pure CPU: `boxPixelsAt` lands on pixels through the same
 * `probePixel` math TOE's `readPixelAt` uses, so these are the pixels
 * the per-probe path would have read one GL sync at a time.
 */
function decodeBoxHits(
  p: FastPickerInternals,
  box: PixelBox,
  byteToModel: Map<number, string>,
  ndcs: readonly NdcPoint[],
): RawHit[] {
  const hits: RawHit[] = [];
  for (let i = 0; i < ndcs.length; i += 1) {
    const ndc = ndcs[i];
    if (!ndc) continue;
    const hit = decodeBytes(byteToModel, boxPixelsAt(p, box, ndc));
    if (!hit) continue;
    hits.push({ index: i, modelId: hit.modelId, itemId: hit.itemId });
  }
  return hits;
}

interface PixelBox {
  /** device-pixel origin of the region inside the id target. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  buf: Uint8Array;
}

/**
 * Wave 28: a render region in the picker target's own device pixels. No
 * device-pixel-ratio math belongs here: three applies a bound target's
 * scissor unscaled (`getTargetPixelRatio()` is 1 for a bound target), and
 * the target is created at CSS size — so target pixels are the same
 * pixels `probePixel` computes.
 */
interface RenderBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Enclosing rectangle of every probe, in target pixels. */
interface PixelBounds {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function probeBounds(
  p: FastPickerInternals,
  ndcs: readonly NdcPoint[],
): PixelBounds | null {
  const size = p._renderTargetSize as { x?: number; y?: number } | undefined;
  if (!size || typeof size.x !== "number" || typeof size.y !== "number") {
    return null;
  }
  if (size.x <= 0 || size.y <= 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const ndc of ndcs) {
    if (!ndc) continue;
    const px = probePixel(ndc, size as { x: number; y: number });
    if (!px) continue;
    if (px.x < minX) minX = px.x;
    if (px.y < minY) minY = px.y;
    if (px.x > maxX) maxX = px.x;
    if (px.y > maxY) maxY = px.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w <= 0 || h <= 0) return null;
  return { x0: minX, y0: minY, w, h };
}

/**
 * The scissor box for the id pass: the probe bounds, padded, clamped to
 * the target.
 *
 * A probe outside the rendered/cleared region reads whatever an earlier
 * pass left there, and a stale ZERO reads as confirmed empty space — the
 * exact silent failure this whole seam exists to prevent, so the box is
 * padded and clamped rather than fitted tight.
 *
 * Returns `null` (⇒ full-frame render) when the target exposes no scissor
 * to write, when the bounds are unusable, or when the padded box grows
 * past `MAX_RENDER_BOX_PX` — a box that large means the probes were
 * scattered across the frame by absurd NDC, and the scissor has stopped
 * buying anything worth its risk.
 */
function scissorRenderBox(
  p: FastPickerInternals,
  bounds: PixelBounds | null,
): RenderBox | null {
  if (!bounds) return null;
  const capable = p._renderTarget as ScissorableTarget | undefined;
  // No target-side scissor surface ⇒ there is nothing to clip with. Do not
  // try: `renderer.setScissor()` while a target is bound is ignored by
  // three, so a "scissored" render would quietly cost a full frame and be
  // indistinguishable from its own control.
  if (!capable || typeof capable.scissor?.set !== "function") return null;
  const size = p._renderTargetSize as { x: number; y: number };
  const pad = SCISSOR_PAD_PX;
  const x = Math.max(0, bounds.x0 - pad);
  const y = Math.max(0, bounds.y0 - pad);
  const right = Math.min(size.x, bounds.x0 + bounds.w + pad);
  const top = Math.min(size.y, bounds.y0 + bounds.h + pad);
  const w = right - x;
  const h = top - y;
  if (w <= 0 || h <= 0 || w * h > MAX_RENDER_BOX_PX) return null;
  return { x, y, w, h };
}

/**
 * Readback of the probe pixels from ONE already-rendered id target, plus
 * the render that produced it. Bounds come from `probeBounds`, so the
 * region is exactly the pixels the scan is allowed to answer from —
 * nothing outside it is ever trusted.
 */
/**
 * Wave 31b: is the single-box readback usable for THIS probe set, right
 * now? Extracted from `readProbeBox` because the RENDER decision has to
 * ask the same question before it chooses between a scissored pass and a
 * full-frame pass: proving the scissor costs a second scan, and each scan
 * costs one GPU readback PER PROBE when the box is unavailable. That is
 * how a probationary state quietly became 68 readbacks per click on a
 * large model.
 */
function boxUsable(
  p: FastPickerInternals,
  renderer: unknown,
  target: unknown,
  ndcs: readonly NdcPoint[],
  boxRead: "pending" | "on" | "off",
): { ok: true; reason?: undefined } | { ok: false; reason: string } {
  if (boxRead === "off") return { ok: false, reason: "disabled" };
  if (ndcs.length === 0) return { ok: false, reason: "no-probes" };
  const bounds = probeBounds(p, ndcs);
  if (!bounds) return { ok: false, reason: "no-bounds" };
  const area = bounds.w * bounds.h;
  if (area > 65536) {
    return { ok: false, reason: "bounds-too-wide:" + bounds.w + "x" + bounds.h };
  }
  const read = (
    renderer as { readRenderTargetPixels?: unknown } | null
  )?.readRenderTargetPixels;
  if (typeof read !== "function") {
    return { ok: false, reason: "no-readRenderTargetPixels" };
  }
  const dims = target as { width?: unknown; height?: unknown } | null;
  const tw = typeof dims?.width === "number" ? dims.width : NaN;
  const th = typeof dims?.height === "number" ? dims.height : NaN;
  if (
    !Number.isFinite(tw) ||
    !Number.isFinite(th) ||
    bounds.x0 < 0 ||
    bounds.y0 < 0 ||
    bounds.x0 + bounds.w > tw ||
    bounds.y0 + bounds.h > th
  ) {
    return {
      ok: false,
      reason:
        "region-out-of-target:" + bounds.w + "x" + bounds.h + "@" +
        bounds.x0 + "," + bounds.y0 + " in " + tw + "x" + th,
    };
  }
  return { ok: true };
}

function readProbeBox(
  p: FastPickerInternals,
  renderer: unknown,
  target: unknown,
  ndcs: readonly NdcPoint[],
  boxRead: "pending" | "on" | "off",
  stats: BatchedReadStats,
): PixelBox | null {
  if (boxRead === "off") {
    stats.boxDecline = "disabled";
    return null;
  }
  if (ndcs.length === 0) {
    stats.boxDecline = "no-probes";
    return null;
  }
  const bounds = probeBounds(p, ndcs);
  if (!bounds) {
    stats.boxDecline = "no-bounds";
    return null;
  }
  const { w, h } = bounds;
  const minX = bounds.x0;
  const minY = bounds.y0;
  if (w * h > 65536) {
    stats.boxDecline = "bounds-too-wide:" + w + "x" + h;
    return null;
  }
  const read = (
    renderer as {
      readRenderTargetPixels?: (
        t: unknown,
        x: number,
        y: number,
        w: number,
        h: number,
        buf: Uint8Array,
      ) => unknown;
    } | null
  )?.readRenderTargetPixels;
  if (typeof read !== "function") {
    stats.boxDecline = "no-readRenderTargetPixels";
    return null;
  }

  // three.js `readRenderTargetPixels` SILENTLY does nothing when the
  // region is out of range (no `else`, no throw — `three.module.js`
  // r182): the buffer stays zero-filled, every probe decodes void, and
  // an unverified box would report confirmed empty space on real
  // geometry. So the region is validated against the TARGET's own
  // dimensions, which is what three checks, not just against
  // `_renderTargetSize` (the two agree today because TOE resizes them
  // together at `components:13222` — a drift we must not assume).
  const dims = target as { width?: unknown; height?: unknown } | null;
  const tw = typeof dims?.width === "number" ? dims.width : NaN;
  const th = typeof dims?.height === "number" ? dims.height : NaN;
  if (
    !Number.isFinite(tw) ||
    !Number.isFinite(th) ||
    minX < 0 ||
    minY < 0 ||
    minX + w > tw ||
    minY + h > th
  ) {
    stats.boxDecline =
      "region-out-of-target:" + w + "x" + h + "@" + minX + "," + minY +
      " in " + tw + "x" + th;
    return null;
  }

  try {
    const buf = new Uint8Array(w * h * 4);
    (renderer as { readRenderTargetPixels: typeof read }).readRenderTargetPixels(
      target,
      minX,
      minY,
      w,
      h,
      buf,
    );
    stats.readbacks += 1;
    return { x0: minX, y0: minY, w, h, buf };
  } catch {
    return null;
  }
}

/** RGBA bytes of one probe inside the box (same `probePixel` math). */
function boxPixelsAt(
  p: FastPickerInternals,
  box: PixelBox,
  ndc: NdcPoint,
): Uint8Array | null {
  const size = p._renderTargetSize as { x?: number; y?: number } | undefined;
  if (
    !size ||
    typeof size.x !== "number" ||
    typeof size.y !== "number" ||
    size.x <= 0 ||
    size.y <= 0
  ) {
    return null;
  }
  const px = probePixel(ndc, size as { x: number; y: number });
  if (!px) return null;
  const col = px.x - box.x0;
  const row = px.y - box.y0;
  if (col < 0 || row < 0 || col >= box.w || row >= box.h) return null;
  const o = (row * box.w + col) * 4;
  return box.buf.subarray(o, o + 4);
}

/**
 * Decode 4 RGBA bytes of an already-rendered id target exactly the way
 * `runIdPass` does (`index.mjs:12767–12775`): model byte in R, the
 * lower three bytes of `itemId + 1` in GBA.
 */
function decodeBytes(
  byteToModel: Map<number, string>,
  pixels: Uint8Array | null,
): RawIdHit | null {
  if (!pixels || pixels.length < 4) return null;
  const modelByte = pixels[0];
  if (modelByte === 0) return null;
  const modelId = byteToModel.get(modelByte);
  if (!modelId) return null;
  const encoded = (pixels[1] << 16) | (pixels[2] << 8) | pixels[3];
  if (encoded === 0) return null;
  return { modelId, itemId: encoded - 1 };
}

/**
 * A replica of TOE's `renderPickPass` (`index.mjs:12846`) with the
 * scissor box OPTIONAL: `null` renders the full frame (the wave-25
 * behavior), a box renders only that region (wave 28 W1).
 *
 * Why the box is safe to cut: one click reads back at most 33 pixels
 * (the exact pixel plus ±8 px of tolerance rings), so everything outside
 * the enclosing box is rasterization nobody consumes. The per-model loop,
 * non-BIM hiding, model-byte uniform and clip-plane forwarding are
 * preserved verbatim from TOE; the only difference is that the clear and
 * the draws are scissored to the probe region.
 *
 * Coordinate convention — the part that must not be guessed. three's
 * `setScissor` scales by the renderer's pixel ratio and rounds
 * (`three.module.js:16346–16360`), and a re-bind reinstates the target's
 * own box (`:18424`, `:18452`) — so the renderer-level route needs a dpr
 * pre-division to cancel out and a rounding allowance. Writing
 * `target.scissor` before binding needs neither. The region is still padded
 * (`SCISSOR_PAD_PX`, see `scissorRenderBox`) because a probe outside the
 * cleared and rendered area reads a stale pixel, and a stale ZERO reads as
 * confirmed empty space.
 */
function renderIdPass(
  p: FastPickerInternals,
  byteToModel: Map<number, string>,
  box: RenderBox | null,
): void {
  const renderer = p.world?.renderer?.three as {
    clippingPlanes?: unknown[];
    getRenderTarget(): unknown;
    autoClear: boolean;
    getClearColor(c: unknown): unknown;
    getClearAlpha(): number;
    getScissorTest(): boolean;
    getScissor(v: unknown): unknown;
    setRenderTarget(t: unknown): void;
    setClearColor(c: unknown, a?: number): void;
    clear(color: boolean, depth: boolean, stencil: boolean): void;
    setScissorTest(v: boolean): void;
    setScissor(x: unknown, y?: number, w?: number, h?: number): void;
    getPixelRatio?(): number;
    render(scene: unknown, camera: unknown): void;
  };
  const scene = p.world?.scene?.three as {
    traverse(cb: (c: unknown) => void): void;
  };
  const camera = p.world?.camera?.three;
  const fragments = p.components?.get?.(OBC.FragmentsManager) as {
    list: Map<string, { object: unknown }>;
  };
  const target = p._renderTarget as ScissorableTarget;
  const material = p._idMaterial as {
    clippingPlanes?: unknown[];
    clipping?: boolean;
    uniforms?: { modelByte?: { value?: number } };
  };

  const planes = renderer.clippingPlanes ?? [];
  material.clippingPlanes = planes;
  material.clipping = planes.length > 0;

  // The box is written on the TARGET, before it is bound.
  //
  // Binding reinstates the target's own scissor: `setRenderTarget` copies
  // `renderTarget.scissor` / `.scissorTest` into `_currentScissor`
  // (`three.module.js:18424`, again at `:18337` inside `renderTarget.render()`)
  // and applies it (`state.scissor( _currentScissor )`, `:18452`). A
  // renderer-level scissor set before a bind is discarded BY that bind.
  //
  // `renderer.setScissor()` is NOT inert while a target is bound — it calls
  // `state.scissor(_currentScissor.copy(_scissor).multiplyScalar(_pixelRatio)
  // .round())` immediately (`:16346–16360`), which is how TOE's 4-px pick
  // clip works: it pre-divides by the device pixel ratio
  // (`components:12871–12878`) to cancel that multiply. We take the target
  // route because it needs no such cancellation, no `getPixelRatio()`, and no
  // allowance for a `.round()` that can shift the box a pixel at fractional
  // ratios — and because it survives a re-bind.
  const prevScissor = target.scissor
    ? {
        x: target.scissor.x ?? 0,
        y: target.scissor.y ?? 0,
        z: target.scissor.z ?? 0,
        w: target.scissor.w ?? 0,
      }
    : null;
  const prevScissorTest = target.scissorTest === true;

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();

  if (target.scissor?.set) {
    const setScissor = target.scissor.set.bind(target.scissor);
    if (box) {
      setScissor(box.x, box.y, box.w, box.h);
      target.scissorTest = true;
    } else {
      setScissor(0, 0, target.width ?? 0, target.height ?? 0);
      target.scissorTest = false;
    }
  }

  renderer.setRenderTarget(target);
  renderer.setClearColor(0, 0);
  renderer.autoClear = false;
  renderer.clear(true, true, false);

  const objectsByModel = new Map<string, unknown>();
  for (const [modelId, model] of fragments.list) {
    objectsByModel.set(modelId, model.object);
  }  const bimRoots = new Set(objectsByModel.values());
  const inBimSubtree = (obj: unknown): boolean => {
    let q = obj as { parent?: unknown } | null;
    while (q) {
      if (bimRoots.has(q)) return true;
      q = (q as { parent?: unknown }).parent ?? null;
    }
    return false;
  };

  const nonBimVisibility = new Map<unknown, boolean>();
  scene.traverse((child) => {
    if (child === scene) return;
    const mesh = child as { isMesh?: boolean; visible?: boolean; parent?: unknown };
    if (!mesh.isMesh) return;
    if (inBimSubtree(mesh)) return;
    nonBimVisibility.set(child, mesh.visible ?? false);
    mesh.visible = false;
  });

  const bimVisibilityBefore = new Map<unknown, boolean>();
  for (const obj of objectsByModel.values()) {
    bimVisibilityBefore.set(obj, (obj as { visible?: boolean }).visible ?? false);
    (obj as { visible?: boolean }).visible = false;
  }
  for (const [byte, modelId] of byteToModel) {
    const obj = objectsByModel.get(modelId);
    if (!obj) continue;
    (obj as { visible?: boolean }).visible = true;
    if (material.uniforms?.modelByte) {
      material.uniforms.modelByte.value = byte;
    }
    renderer.render(scene, camera);
    (obj as { visible?: boolean }).visible = false;
  }
  for (const [obj, was] of bimVisibilityBefore) {
    (obj as { visible?: boolean }).visible = was;
  }
  for (const [obj, was] of nonBimVisibility) {
    (obj as { visible?: boolean }).visible = was;
  }

  // Restore the TARGET's own scissor state before re-binding, since
  // binding a target is what pushes these values into GL.
  if (prevScissor && target.scissor?.set) {
    target.scissor.set(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
    target.scissorTest = prevScissorTest;
  }

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.setClearColor(prevClearColor, prevClearAlpha);
}

/**
 * The picker's render target, narrowed to the scissor surface three
 * actually honours while a target is bound (`WebGLRenderTarget.scissor` +
 * `.scissorTest`, `three.core.js:8934`/`:8943`). Optional members on
 * purpose: if a future build stops exposing them, the scissor is simply
 * never attempted and the full-frame render stays.
 */
interface ScissorableTarget {
  width?: number;
  height?: number;
  scissorTest?: boolean;
  scissor?: {
    x?: number;
    y?: number;
    z?: number;
    w?: number;
    set?: (x: number, y: number, w: number, h: number) => void;
  };
}

interface RawIdHit {
  modelId: string;
  itemId: number;
}

/** A decoded hit plus the index of the probe it came from (scan order). */
interface RawHit extends RawIdHit {
  index: number;
}

/**
 * Outcome of one `itemId → localId` translation, with the failure modes
 * kept APART. Conflating them was the wave-28 review's headline
 * blocker: `ConnectionHandlers.newHandler` rejects as soon as the
 * worker returns `errorInfo` (`@thatopen/fragments:28551–28557`), so an
 * alive-but-erroring decoder is a strictly MORE likely outcome than a
 * wedge, and a swallowed rejection must not become "empty space".
 *
 *   - `hit`     → the express id. Select and tint it.
 *   - `no-id`   → a LIVE model answered "this item has no express id"
 *                 (LOD filler, non-BIM geometry). A genuine
 *                 pass-through miss: keep scanning, and if nothing else
 *                 answers, empty space — exactly wave-25 behavior.
 *   - `unknown` → the model vanished, the map is missing, or the call
 *                 REJECTED. The click outcome is unknowable: the caller
 *                 must leave the selection alone.
 */
type TranslateResult =
  | { kind: "hit"; item: IdItem }
  | { kind: "no-id" }
  | { kind: "unknown" };

/**
 * Resolve a decoded `itemId` → `localId` (express id) exactly the way
 * `getItemAt` does (`index.mjs:12584–12612`) and memoize it per model.
 *
 * This is the single fragments-worker round-trip the batched path pays
 * per click (wave 28: ONE, down from one per probe). It is also the only
 * await in the pick path, and the engine bounds it in exactly ONE of the
 * two ways it can fail:
 *
 *   - The worker ANSWERS with an error. `manageConnection` catches the
 *     handler failure, stamps `errorInfo` on the response
 *     (`@thatopen/fragments/dist/index.mjs:28602–28610`) and main routes it
 *     through `ConnectionHandlers.newHandler`, which REJECTS
 *     (`:28551–28556`). This is the common failure (a corrupt tile, a
 *     web-ifc throw) and it reaches us as a rejection → `unknown`.
 *   - The call is never delivered. `Connection.fetch` registers the
 *     resolve/reject pair and then fires `executeConnection(...)` WITHOUT
 *     awaiting or catching it (`:28579–28585`), so a throw from
 *     `fetchConnection` — connection not initialized (`:28589–28591`), a
 *     thread deleted mid-flight so `getPort` yields `undefined`
 *     (`:35886–35891`), or the `"Error fetching thread!"` placeholder throw
 *     (`:35817–35821`) — becomes an unhandled rejection while the entry in
 *     `_handlers` stays registered forever: `ConnectionHandlers` has no
 *     clear/reject-all (`:28531–28558`), no dispose path touches in-flight
 *     calls (`:19792–19802`, `:35975–35982`, `:36323–36342`), and
 *     `initConnection` wires only `onmessage` — there is NO `worker.onerror`
 *     anywhere in the bundle (`:28586–28588`), so a crashed worker settles
 *     nothing either. That await simply never returns.
 *
 * The second case is why the caller bounds this with
 * {@link LOCAL_ID_BUDGET_MS}: the engine cannot, and wave 27's 4 s chain
 * guard was the only thing that ever released such a click. Bounding it is
 * not free — every abandoned round-trip leaves one permanent `_handlers`
 * entry — but it is bounded by the number of clicks dropped in an already
 * broken session, and it is the cheaper failure than latching the chain.
 * A late arrival cannot corrupt the cache either: it can only write into a
 * bucket that still passes the model-identity check below.
 *
 * The cache keeps repeat clicks off the worker entirely.
 *
 * There is NO synchronous main-thread alternative in 3.4.5: the flatbuffer
 * lookup (`VirtualPropertiesController.getLocalIdsFromItemIds`, `:32294`)
 * is built only into `VirtualFragmentsModel`, which lives inside the
 * worker (`:34869` ← `:28678`) — the `FragmentsModel` instance in
 * `core.models.list` has no `properties` member at all, so casting to
 * one there yields `undefined`, not a shortcut.
 *
 * Latency here is queue position, not lookup cost: on a 4-core device
 * the pool floors at 2 workers (`getMaxWorkers`, `:20863–20873`;
 * `getCpuCapacity` returns `hardwareConcurrency - 3`, `:20883`) and
 * every model on a worker serializes through one 16 ms-budget loop
 * (`:28867–28873`).
 */
async function resolveLocalId(
  p: FastPickerInternals,
  modelId: string,
  itemId: number,
  cache: LocalIdCache,
): Promise<TranslateResult> {
  const model = currentModel(p, modelId) as
    | { getLocalIdsFromItemIds?: (ids: Iterable<number>) => Promise<number[]> }
    | null;
  if (!model || typeof model.getLocalIdsFromItemIds !== "function") {
    // Model gone (reload / unload): its bucket must go with it, or a
    // reload under the same id could serve a stale express id.
    cache.delete(modelId);
    return { kind: "unknown" };
  }
  let localIds: number[] | null | undefined;
  try {
    localIds = await model.getLocalIdsFromItemIds([itemId]);
  } catch {
    // The worker ANSWERED, with an error. UNKNOWN — never a miss.
    return { kind: "unknown" };
  }
  const localId = localIds?.[0];
  if (localId === undefined || localId === null) return { kind: "no-id" };
  let bucket = cache.get(modelId);
  if (!bucket || bucket.model !== model) {
    // A bucket pins its model instance — that identity tag is what
    // rejects a stale same-id reload — so the number of buckets needs a
    // bound of its own: a model disposed and never clicked again would
    // otherwise stay referenced for the life of the mount. Buckets only
    // accumulate per distinct model clicked in one session, so 32 is
    // generous and clearing on overflow beats an LRU on a hot path.
    if (cache.size >= LOCAL_ID_MODEL_CAP) cache.clear();
    bucket = { model, ids: new Map<number, number>() };
    cache.set(modelId, bucket);
  }
  if (bucket.ids.size >= LOCAL_ID_CACHE_CAP) bucket.ids.clear();
  bucket.ids.set(itemId, localId);
  return { kind: "hit", item: { modelId, localId } };
}