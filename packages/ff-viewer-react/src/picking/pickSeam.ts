// Wave 14 — adapters between the engine's pickers and the handle's
// drift-clean result shapes.
//
// The IfcViewerHandle only ever sees plain `{x, y, z}` and
// `{ modelId, expressId, point }` objects. These functions do the
// engine→plain mapping so the seam can be unit-tested against stubs
// without importing THREE or instantiating a WebGL context.

import type { NdcPoint, WorldPoint } from "./pickTypes";
import type { BatchedIdPassReader } from "./idPassInterop";

/**
 * The minimal slice of `OBC.FastModelPicker` the point pick needs.
 * `getPointAt` reads only `position.x`/`position.y`, so a plain
 * `{x, y}` NDC object is a valid argument at runtime (the engine's
 * `THREE.Vector2` satisfies this structural type).
 */
export interface FastPointPicker {
  getPointAt(
    position?: { x: number; y: number },
  ): Promise<{ x: number; y: number; z: number } | null>;
}

/**
 * The minimal `OBC.Raycasters`-bound caster surface the fallback
 * path needs. Its `castRay` result carries `{ point }` — a plain
 * `{x, y, z}`-shaped vector at runtime.
 */
export interface WorldPointCaster {
  castRay(data?: {
    position?: { x: number; y: number };
  }): Promise<{ point?: { x: number; y: number; z: number } } | null>;
}

/** Map an engine vector-like (`{x,y,z}` or null) to the plain result. */
export function toWorldPoint(
  point: { x: number; y: number; z: number } | null | undefined,
): WorldPoint | null {
  if (!point) return null;
  return { x: point.x, y: point.y, z: point.z };
}

/**
 * Resolve a world-space hit through the FastModelPicker. Returns the
 * same `{x, y, z} | null` shape as the Raycasters path, so callers
 * are backend-agnostic.
 */
export async function pickWorldPointFast(
  picker: FastPointPicker | null,
  ndc?: NdcPoint,
): Promise<WorldPoint | null> {
  if (!picker) return null;
  const point = await picker.getPointAt(ndc);
  return toWorldPoint(point);
}

/**
 * Resolve a world-space hit through the Raycasters path (fallback).
 * Returns the same `{x, y, z} | null` shape as the fast path.
 */
export async function pickWorldPointRaycast(
  caster: WorldPointCaster | null,
  ndc?: NdcPoint,
): Promise<WorldPoint | null> {
  if (!caster) return null;
  const result = await caster.castRay(ndc ? { position: ndc } : undefined);
  return toWorldPoint(result?.point);
}

/**
 * The slice of `FastModelPicker.getFullPick()` the selection path
 * needs. `localId` maps 1:1 to the FreeField "expressId" because the
 * IFC importer preserves express IDs (verified in `getElementData`
 * docs — TOE localId === express ID in this codebase).
 */
export interface FullPickLike {
  modelId: string;
  localId: number;
  point?: { x: number; y: number; z: number } | null;
  /**
   * World-space surface normal under the cursor, from
   * `FastModelPicker.getFullPick()` (the normal pass). Missing/null
   * for stubs, a miss, or picks that skipped the normal pass (e.g. the
   * worker-raycast primary backend). Wave 48 threads it through so the
   * section-plane toolbar can orient parallel to the picked face.
   */
  normal?: { x: number; y: number; z: number } | null;
}

/**
 * The slice of `OBC.FastModelPicker` the multi-model selection path
 * needs. `getFullPick(position)` returns `{ modelId, localId, point,
 * normal, distance }` (or `null` on empty space) — the GPU id pass
 * spans EVERY registered fragments model (see core `applyIdMaterial`),
 * so unlike the Highlighter's single-model click path it resolves the
 * actually-hit model for a click on ANY loaded IFC.
 */
export interface FastElementPicker extends FastPointPicker {
  getFullPick(
    position?: { x: number; y: number },
  ): Promise<FullPickLike | null>;
  getItemAt(
    position?: { x: number; y: number },
  ): Promise<{ modelId: string; localId: number } | null>;
  /**
   * World-space surface normal under the cursor (normal pass only —
   * cheaper than `getFullPick`). Used by the viewer's lazy selection-
   * normal resolution for the section-plane toolbar. Optional so the
   * worker-raycast/fallback stubs can omit it gracefully.
   */
  getNormalAt?(
    position?: { x: number; y: number },
  ): Promise<{ x: number; y: number; z: number } | null>;
}

/**
 * Plain element-pick payload — the exact contract
 * `IfcViewerHandle.setOnElementPick` already emits (see
 * `ElementPickEvent`). Kept here so a future selection-path swap
 * (Highlighter → FastModelPicker.getFullPick) produces an identical
 * shape without touching consumers.
 */
export interface ElementPickLike {
  modelId: string;
  expressId: number;
  point: WorldPoint;
  /** Mirrored from `FullPickLike.normal`; undefined when the pick
   *  backend produced no normal. */
  normal?: { x: number; y: number; z: number } | null;
}

/**
 * Map a `getFullPick()` result to the selection result shape. This is
 * the "selection result shape" invariant the seam tests pin down:
 * FastModelPicker's `{ modelId, localId }` → `{ modelId, expressId }`
 * with the world point carried through (empty-space → `null`).
 */
export function mapFullPick(pick: FullPickLike | null): ElementPickLike | null {
  if (!pick) return null;
  const point: WorldPoint = pick.point
    ? { x: pick.point.x, y: pick.point.y, z: pick.point.z }
    : { x: 0, y: 0, z: 0 };
  const out: ElementPickLike = {
    modelId: pick.modelId,
    expressId: pick.localId,
    point,
  };
  // Only attach when present so existing `toEqual` seam contracts that
  // pass a normal-less `FullPickLike` still compare equal.
  if (pick.normal) {
    out.normal = { x: pick.normal.x, y: pick.normal.y, z: pick.normal.z };
  }
  return out;
}

/**
 * Wave 21: selection-critical half of the pick — the id pass + ring
 * tolerance, WITHOUT the depth/normal passes. `getItemAt` renders the
 * id pass once (~60-120 ms measured on-device); `getPointAt` renders
 * the depth pass once more (~40-60 ms) and the normal pass is never
 * needed for selection. The click pipeline applies selection +
 * highlight as soon as this resolves, then runs `getPointAt` at
 * `probeNdc` in the background for the tap-to-create anchor —
 * halving the click→highlight critical path versus the old
 * `pickElementFastTolerant` (which ran all three per click).
 *
 * Wave 28 result contract — three outcomes, not two:
 *   - `IdPickHit`   → an element was hit; select and tint it.
 *   - `null`        → TRUE empty space; clearing the selection is correct.
 *   - `undefined`   → UNKNOWN (translations stalled). The caller must
 *                     treat the click as a no-op: leaving the current
 *                     selection alone is always better than wiping a
 *                     real hit or persisting a wrong task anchor.
 */
export interface IdPickHit {
  modelId: string;
  expressId: number;
  /**
   * The NDC pixel that actually hit — the exact click, or the
   * winning ring probe. The depth pass must re-read THIS position
   * for a point that agrees with the id.
   */
  probeNdc: NdcPoint;
}

export async function pickElementIdFastTolerant(
  picker: ElementProbe | null,
  ndc: NdcPoint,
  sizePx: { x: number; y: number },
  batched?: BatchedIdPassReader | null,
  onDegrade?: (err: unknown) => void,
): Promise<IdPickHit | null | undefined> {
  if (!picker) return null;
  if (sizePx.x <= 0 || sizePx.y <= 0) return null;

  // Wave 25: when the id-pass interop is available (fast backend), render
  // ONCE and read every probe pixel back from that single target. This is
  // the 33-render → 1-render collapse on the empty-space / thin-MEP miss.
  // The per-probe `getItemAt` loop below stays as the silent fallback.
  if (batched) {
    const probes = idPassProbes(ndc, sizePx);
    try {
      const outcome = await batched.read(probes);
      for (let i = 0; i < probes.length; i += 1) {
        const item = outcome.items[i];
        if (!item) continue;
        return {
          modelId: item.modelId,
          expressId: item.localId,
          probeNdc: probes[i],
        };
      }
      // Wave 28: a pixel hit an element but its express id never came
      // back off the worker. UNKNOWN — the caller keeps the selection.
      return outcome.inconclusive ? undefined : null;
    } catch (err) {
      // Wave-25b: the batched path threw at RUNTIME (private-internals
      // drift — e.g. the live unbound-`readPixelAt` crash this guard was
      // born from). Degrade to the exact pre-wave-25 per-probe getItemAt
      // loop below. A lost click is the only unacceptable outcome here:
      // task anchors are persisted from this path.
      // Wave 27: surface the reason to the caller (chain stats → Sentry).
      // The degrade used to be invisible outside the browser console.
      onDegrade?.(err);
    }
  }

  // Wave 28: the degraded scan bounds every WORKER ROUND-TRIP rather
  // than the scan as a whole. The distinction matters: a slow-but-alive
  // device legitimately needs 33 × ~120 ms here (wave 27's own comment
  // on PICK_STALL_BUDGET_MS), so a blanket scan budget would silently
  // stop the thin-MEP tolerance rings from ever being reached on exactly
  // the backend that still needs them — while a WEDGED worker is caught
  // by the very first bounded call, in PICK_PROBE_RPC_BUDGET_MS instead
  // of the 4 s the chain guard takes. A wedge is therefore reported as
  // UNKNOWN on its own channel (the caller counts `inconclusiveClicks`),
  // and `degrades` / `lastDegradeReason` keep their wave-27 meaning:
  // private-internals drift. The chain's stall guard stays as the final
  // backstop for everything else.
  try {
    const scan = await scanProbesPerProbe(picker, ndc, sizePx);
    return scan === RPC_STALLED ? undefined : scan;
  } catch (err) {
    onDegrade?.(err);
    // A throwing `getItemAt` tells us nothing about what is under the
    // cursor, so this is UNKNOWN too — it must never reject out of the
    // chain (that surfaced as an unhandled error in the click listener)
    // and never clear a selection that may be real.
    return undefined;
  }
}

/**
 * Wave 28: per-round-trip budget for the DEGRADED per-probe scan.
 *
 * Every `getItemAt` in that loop is one `itemId → localId` fragments
 * worker call, and the engine bounds none of them (no timeout, no
 * reject on dispose — see `idPassInterop.ts:resolveLocalId`). Bounding
 * each call rather than the whole scan is deliberate: a slow-but-alive
 * 33-probe empty-space scan is allowed to finish (wave 27 measured
 * ~120 ms per `getItemAt` on the field device), while a wedged worker
 * surfaces as UNKNOWN after ONE budget instead of latching the chain
 * for the full stall period.
 *
 * The literal mirrors `LOCAL_ID_BUDGET_MS` and is repeated here on
 * purpose: `pickSeam.ts` must stay importable without pulling in the
 * three / @thatopen graph that `idPassInterop.ts` carries.
 */
export const PICK_PROBE_RPC_BUDGET_MS = 600;

/** Internal marker: a probe call outlived its RPC budget. */
const RPC_STALLED: unique symbol = Symbol("ff.pick.rpc-stalled");

/**
 * Pre-wave-25 behavior, kept verbatim as the degrade target: one
 * `getItemAt` (one id render + one worker round-trip) per probe, in
 * exact scan order, so batched and degraded picks agree on which of
 * two simultaneous hits wins. Wave 28 bounds every round-trip — the
 * renders are per-probe here, which is exactly why this path is the
 * fallback and not the fast path.
 */
async function scanProbesPerProbe(
  picker: ElementProbe,
  ndc: NdcPoint,
  sizePx: { x: number; y: number },
): Promise<IdPickHit | null | typeof RPC_STALLED> {
  const probeAt = (probe: NdcPoint) =>
    withStallGuard<{ modelId: string; localId: number } | null | typeof RPC_STALLED>(
      picker.getItemAt(probe),
      () => undefined,
      RPC_STALLED,
      PICK_PROBE_RPC_BUDGET_MS,
    );

  const exact = await probeAt(ndc);
  if (exact === RPC_STALLED) return RPC_STALLED;
  if (exact) {
    return { modelId: exact.modelId, expressId: exact.localId, probeNdc: ndc };
  }
  for (const radius of TOLERANCE_RADII) {
    for (const off of toleranceOffsets(radius, sizePx)) {
      const probe = { x: ndc.x + off.x, y: ndc.y + off.y };
      const item = await probeAt(probe);
      if (item === RPC_STALLED) return RPC_STALLED;
      if (!item) continue;
      return { modelId: item.modelId, expressId: item.localId, probeNdc: probe };
    }
  }
  return null;
}

/**
 * Wave 27: hard stall budget for the click chain.
 *
 * Evidence (debug-perf-chain telemetry from the boss's real /models
 * scene): `clicks: 1` with EVERY post-await counter null/zero — the
 * pick promise NEVER settled (a hung fragments round-trip inside the
 * degraded per-probe getItemAt loop). Because the chain is
 * single-flight, one hung click latches every later click behind it:
 * "clicking stopped working all together".
 *
 * The batched path is synchronous; the legitimate worst case is the
 * full 33-probe scan (~120 ms per getItemAt ≈ 4 s). Past that budget
 * a pick is hung, not slow. `undefined` (the fallback) means
 * "stalled" and callers must treat it as a dropped no-op — the chain
 * always hands its latch back.
 */
export const PICK_STALL_BUDGET_MS = 4000;

export function withStallGuard<T>(
  pick: Promise<T>,
  onStall: () => void,
  fallback: T,
  ms: number = PICK_STALL_BUDGET_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onStall();
      resolve(fallback);
    }, ms);
    pick.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolve a single element selection through the FastModelPicker GPU
 * pick. `getFullPick` runs the id (multi-model) + depth + normal passes
 * and returns the actually-hit model with a REAL world point — this is
 * the drop-in the wave-14 FastModelPicker was shipped for but the
 * selection path never used (it stayed on the Highlighter).
 *
 * Returns the same `ElementPickLike | null` shape `mapFullPick`
 * produces, so callers are backend-agnostic.
 */
export async function pickElementFast(
  picker: FastElementPicker | null,
  ndc?: NdcPoint,
): Promise<ElementPickLike | null> {
  if (!picker) return null;
  const full = await picker.getFullPick(ndc);
  return mapFullPick(full);
}

/**
 * A normalized element hit from either pick backend. Both the
 * FastModelPicker (`getFullPick`) and the Raycasters fallback
 * (`castRay`) ultimately resolve to `{ modelId, localId }` — the
 * only difference is how the `modelId` is attached (`modelId` top
 * level vs. `fragments.modelId`). Normalizing to this shape is what
 * lets the selection path resolve a click on ANY loaded model
 * regardless of which backend produced the hit.
 */
export interface RawPickHit {
  modelId: string;
  localId: number;
  /**
   * World-space distance from the camera along the ray. The
   * Raycasters fallback provides this; FastModelPicker can carry it
   * too. Missing = treated as farthest so a hit with no distance
   * never beats a concrete nearer hit.
   */
  distance?: number | null;
  point?: { x: number; y: number; z: number } | null;
}

/**
 * The Raycasters `castRay()` result shape. `localId` / `fragments`
 * are only present on a fragment hit — an empty-space cast returns a
 * bare three.js intersection without either, so this shape keeps them
 * optional.
 */
export interface RaycasterHitLike {
  localId?: number | null;
  fragments?: { modelId?: string } | null;
  point?: { x: number; y: number; z: number } | null;
  distance?: number | null;
}

/**
 * Normalize one backend hit to a `RawPickHit`. Accepts EITHER the
 * FastModelPicker shape (`{ modelId, localId }` — `FullPickLike`) OR
 * the Raycasters shape (`{ fragments: { modelId }, localId }`).
 * Returns `null` for empty-space / non-fragment hits (no `localId`,
 * no resolvable `modelId`).
 */
export function normalizePickHit(
  hit: FullPickLike | RaycasterHitLike | null | undefined,
): RawPickHit | null {
  if (!hit) return null;
  const full = hit as FullPickLike;
  const ray = hit as RaycasterHitLike;
  const localId = ray.localId ?? full.localId;
  if (typeof localId !== "number") return null;
  const modelId = (full.modelId ?? ray.fragments?.modelId) ?? "";
  if (!modelId) return null;
  const point = ray.point ?? full.point ?? undefined;
  const distance = ray.distance ?? undefined;
  return { modelId, localId, distance, point };
}

/**
 * Resolve the element hit for a click across models. Given hits from
 * one or both pick backends (possibly `null` for a miss), return the
 * NEAREST hit as `{ modelId, expressId, point }` — so a click on ANY
 * loaded model resolves to that model's id, never "whichever model
 * happened to be bound first".
 *
 * Ordering: smallest `distance` wins; a missing distance sorts last;
 * ties keep input order (stable), so when both backends agree (the
 * common case) the first hit wins and the result is unchanged from
 * passing a single hit through `mapFullPick`.
 */
export function resolveNearestHit(
  candidates: Array<RawPickHit | null | undefined>,
): ElementPickLike | null {
  let winner: RawPickHit | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c.localId !== "number") continue;
    if (!c.modelId) continue;
    if (winner === null) {
      winner = c;
      continue;
    }
    const winnerDist =
      winner.distance ?? Number.POSITIVE_INFINITY;
    const candDist = c.distance ?? Number.POSITIVE_INFINITY;
    if (candDist < winnerDist) winner = c;
  }
  if (winner === null) return null;
  return mapFullPick({
    modelId: winner.modelId,
    localId: winner.localId,
    point: winner.point,
  });
}

// ── Wave 19b: tolerant fast pick (GPU id-pass single-pixel misses) ──

/**
 * The public `OBC.FastModelPicker` probe surface the tolerant pick
 * needs. `getItemAt` runs the GPU id pass only (no depth/normal) —
 * the cheapest way to test whether a pixel resolves to an element;
 * `getPointAt` runs the depth pass; `getFullPick` runs all three.
 */
export interface ElementProbe {
  getFullPick(
    position?: { x: number; y: number },
  ): Promise<FullPickLike | null>;
  getItemAt(
    position?: { x: number; y: number },
  ): Promise<{ modelId: string; localId: number } | null>;
  getPointAt(
    position?: { x: number; y: number },
  ): Promise<WorldPoint | null>;
}

/**
 * Pixel offsets probed when the exact click pixel reads void, by
 * radius (px). A diamond + diagonals ring keeps the worst case at
 * 32 extra id-pass renders for a TRUE empty-space click; the common
 * miss (thin/angled geometry one or two pixels off the exact read)
 * resolves on the first ring.
 */
const TOLERANCE_RADII = [2, 4, 6, 8] as const;

function toleranceOffsets(
  radiusPx: number,
  size: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const dx = (radiusPx / size.x) * 2;
  const dy = (radiusPx / size.y) * 2;
  return [
    { x: dx, y: 0 },
    { x: -dx, y: 0 },
    { x: 0, y: dy },
    { x: 0, y: -dy },
    { x: dx, y: dy },
    { x: -dx, y: dy },
    { x: dx, y: -dy },
    { x: -dx, y: -dy },
  ];
}

/**
 * Wave 25: the ORDERED probe list the batched id pass reads — the exact
 * click pixel first, then every ring offset in the same order the
 * per-probe fallback scans. Batched and fallback are therefore
 * bit-identical on which of two simultaneous hits wins (first in scan
 * order).
 */
export function idPassProbes(
  ndc: NdcPoint,
  sizePx: { x: number; y: number },
): NdcPoint[] {
  const probes: NdcPoint[] = [{ x: ndc.x, y: ndc.y }];
  for (const radius of TOLERANCE_RADII) {
    for (const off of toleranceOffsets(radius, sizePx)) {
      probes.push({ x: ndc.x + off.x, y: ndc.y + off.y });
    }
  }
  return probes;
}

/**
 * `pickElementFast` + neighborhood tolerance.
 *
 * Wave 19b (on-device bug hunt): the GPU id pass reads ONE pixel at
 * the exact cursor position. Thin or steeply-angled MEP geometry
 * (duct sides, pipe crowns, chiller panel seams) can land a hair off
 * that pixel after rasterization — the id buffer reads the scene
 * background there, `getFullPick` returns null, and the user is told
 * "empty space" while clearly over an element. Structural slabs
 * (big flat front-facing quads) almost never miss, which is exactly
 * the field asymmetry reported: structural clicks OK, MEP clicks
 * intermittently void.
 *
 * Strategy: exact pixel first (full pick — same behavior as before);
 * on a miss, ring-scan with `getItemAt` (id pass only, cheap) and
 * resolve the winning offset's world point with `getPointAt`. The
 * CPU raycaster is NOT used as a fallback: fragments replaces
 * `Mesh.raycast` with a BVH path that throws on these tile meshes
 * (measured on-device), and the standard three.js raycast can't
 * intersect them either — the GPU passes are the only working pick
 * backend for MEP geometry in TOE 3.4.6.
 */
export async function pickElementFastTolerant(
  picker: ElementProbe | null,
  ndc: NdcPoint,
  sizePx: { x: number; y: number },
): Promise<ElementPickLike | null> {
  if (!picker) return null;
  if (sizePx.x <= 0 || sizePx.y <= 0) return null;
  const exact = mapFullPick(await picker.getFullPick(ndc));
  if (exact) return exact;
  for (const radius of TOLERANCE_RADII) {
    for (const off of toleranceOffsets(radius, sizePx)) {
      const probe = { x: ndc.x + off.x, y: ndc.y + off.y };
      const item = await picker.getItemAt(probe);
      if (!item) continue;
      const point = await picker.getPointAt(probe);
      return {
        modelId: item.modelId,
        expressId: item.localId,
        point: point ?? { x: 0, y: 0, z: 0 },
      };
    }
  }
  return null;
}

// ── Wave 45: worker-raycast primary pick backend ─────────────────────
//
// The boss requirement: MEP clicks must land "as fast as the structural
// model no matter the size". The GPU id pass (the path above) needs
// APPLIED tiles with per-vertex `id` — the root of the ~80 s warm-up
// dependency. `FragmentsManager.raycast` against the worker's virtual
// shells is tile-independent, exact-triangle, and returns the express id
// inline (`localId`), so it works before ANY tessellation. This seam adds
// it as the PRIMARY backend, with the id-pass path above as the fallback.
//
// Everything here stays drift-clean: no `three` import. The `mouse`
// Vector2 / camera / canvas are engine objects assembled by the caller
// (IfcViewer), passed through as `unknown`. The seam only inspects the
// RESULT shape, which is what keeps it unit-testable against stubs.

/**
 * The engine's `FRAGS.RaycastResult`, narrowed to plain fields (no
 * THREE import). `fragments` is the hit `FragmentsModel` (`{ modelId }`).
 *
 * `localId` IS the IFC express id the current id-pass path lands on:
 * the worker `RaycastController` sets `raycast.localId` from
 * `meshesItems(itemId) → model.localIds(...)` — the SAME computation
 * `getLocalIdsFromItemIds` performs (`@thatopen/fragments` index.mjs
 * :29207–29211 vs :32294–32303). `itemId` is the internal flatbuffer
 * item index and is NOT the express id — using it would select the
 * wrong element. (Verified in the installed 3.4.5 dist before coding.)
 */
export interface RaycastResultLike {
  localId?: number | null;
  itemId?: number | null;
  point?: { x: number; y: number; z: number } | null;
  distance?: number | null;
  /** The hit model — the engine attaches `fragments` (FragmentsModel). */
  fragments?: { modelId?: string } | null;
  /** Convenience top-level model id for test stubs. */
  modelId?: string | null;
}

/** The manager slice the raycast primary needs (`FragmentsManager.raycast`). */
export interface WorkerRaycaster {
  raycast(data: unknown): Promise<RaycastResultLike | null | undefined>;
}

/** A raycast hit normalized to the seam's selection shape + a real point. */
export interface RaycastIdHit {
  modelId: string;
  expressId: number;
  point: WorldPoint | null;
}

/**
 * Normalize an engine raycast result to `{ modelId, expressId, point }`.
 *
 * Reuses {@link normalizePickHit} — the SAME localId→expressId mapping the
 * current path uses — instead of inventing a second mapping (spec §Target
 * design 2). `null`/`undefined` input, a missing express id, or a missing
 * model id ⇒ `null` (a miss). `point` is the raycast's exact world hit —
 * unlike the id-pass path there is no depth pass to run, so the anchor is
 * free.
 */
export function mapRaycastHit(
  result: RaycastResultLike | null | undefined,
): RaycastIdHit | null {
  if (!result) return null;
  const hit = normalizePickHit(result);
  if (!hit) return null;
  const point: WorldPoint | null = hit.point
    ? { x: hit.point.x, y: hit.point.y, z: hit.point.z }
    : null;
  return { modelId: hit.modelId, expressId: hit.localId, point };
}

/**
 * Wave 45: budget for the worker-raycast round-trip. Bounded by
 * `Promise.race` so a wedged worker (the exact failure the id-pass path
 * already guards against) cannot reintroduce the wave-27 click-latch.
 * 1500 ms clears normal congested-worker latency on the field device
 * (`getLocalIdsFromItemIds` queues behind tile streaming there) while
 * catching a real wedge; the fallback id-pass keeps its own 4000 ms
 * {@link PICK_STALL_BUDGET_MS} guard.
 */
export const RAYCAST_PICK_TIMEOUT_MS = 1500;

/** Sentinel resolved by the bounded race when the budget lapses. */
const RAYCAST_TIMED_OUT: unique symbol = Symbol("ff.raycast.timed-out");

/**
 * One worker-raycast attempt, mapped to four KEPT-APART outcomes.
 *
 *   - `hit`     → an element was hit; the caller selects + tints it.
 *   - `miss`    → the manager answered empty space, OR the hit carried no
 *                 resolvable express id / model id. Authoritative — the
 *                 raycast is exact ray-triangle, so no id-pass tolerance
 *                 ring re-scan is needed on the primary path.
 *   - `timeout` → the round-trip never settled inside the budget. The
 *                 caller falls back to the id-pass and breadcrumbs it.
 *   - `throw`   → `raycast` is absent or rejected (engine drift / wedged
 *                 worker). The caller falls back to the id-pass.
 *
 * A rejection is NEVER laundered into a miss: a spurious miss clears a
 * live selection and anchors a task at nothing.
 */
export async function pickElementIdRaycast(
  raycast: WorkerRaycaster | null | undefined,
  raycastData: unknown,
  opts: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<
  | { kind: "hit"; hit: RaycastIdHit; ms: number }
  | { kind: "miss"; ms: number }
  | { kind: "timeout"; ms: number }
  | { kind: "throw"; ms: number; error: unknown }
> {
  const t0 = performance.now();
  const elapsed = (): number => Math.round(performance.now() - t0);
  if (!raycast || typeof raycast.raycast !== "function") {
    return {
      kind: "throw",
      ms: elapsed(),
      error: new Error("raycast unavailable"),
    };
  }
  const timeoutMs = opts.timeoutMs ?? RAYCAST_PICK_TIMEOUT_MS;
  try {
    const result = await new Promise<RaycastResultLike | null | undefined>(
      (resolve, reject) => {
        let settled = false;
        const timer = globalThis.setTimeout(() => {
          if (settled) return;
          settled = true;
          opts.onTimeout?.();
          resolve(RAYCAST_TIMED_OUT as never);
        }, timeoutMs);
        raycast.raycast(raycastData).then(
          (value) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            reject(err);
          },
        );
      },
    );
    if ((result as unknown) === RAYCAST_TIMED_OUT) {
      return { kind: "timeout", ms: elapsed() };
    }
    const hit = mapRaycastHit(result);
    if (hit) return { kind: "hit", hit, ms: elapsed() };
    return { kind: "miss", ms: elapsed() };
  } catch (err) {
    return { kind: "throw", ms: elapsed(), error: err };
  }
}

/** The result of the raycast-primary seam (raycast first, id-pass fallback). */
export type RaycastFirstResult =
  | { backend: "raycast"; kind: "hit"; hit: RaycastIdHit; ms: number }
  | { backend: "raycast"; kind: "miss"; ms: number }
  | {
      backend: "idpass";
      outcome: IdPickHit | null | undefined;
      reason: "unavailable" | "throw" | "timeout";
      raycastMs: number;
    };

export interface RaycastFirstDeps {
  /** The `FragmentsManager` (or null when it isn't a raycast manager). */
  raycast: WorkerRaycaster | null | undefined;
  /** `{ camera, dom, mouse }` assembled by the caller (engine objects). */
  raycastData: unknown;
  /** The id-pass tolerant pick — the fallback (already stall-guarded). */
  idPassFallback: () => Promise<IdPickHit | null | undefined>;
  timeoutMs?: number;
  /** Fired when the bounded raycast round-trip lapses (caller breadcrumb). */
  onTimeout?: () => void;
}

/**
 * The wave-45 primary seam: raycast FIRST, id-pass fallback.
 *
 *   - raycast hit/miss → authoritative, no id-pass consulted (the miss
 *     is exact, no tolerance re-scan).
 *   - raycast absent / threw / timed out → the id-pass fallback runs and
 *     its outcome (hit / null / `undefined` UNKNOWN) is returned verbatim,
 *     tagged with WHY the fallback ran (`unavailable` | `throw` | `timeout`).
 */
export async function pickElementIdRaycastFirst(
  deps: RaycastFirstDeps,
): Promise<RaycastFirstResult> {
  const t0 = performance.now();
  if (!deps.raycast || typeof deps.raycast.raycast !== "function") {
    return {
      backend: "idpass",
      outcome: await deps.idPassFallback(),
      reason: "unavailable",
      raycastMs: Math.round(performance.now() - t0),
    };
  }
  const outcome = await pickElementIdRaycast(deps.raycast, deps.raycastData, {
    timeoutMs: deps.timeoutMs,
    onTimeout: deps.onTimeout,
  });
  if (outcome.kind === "hit") {
    return { backend: "raycast", kind: "hit", hit: outcome.hit, ms: outcome.ms };
  }
  if (outcome.kind === "miss") {
    return { backend: "raycast", kind: "miss", ms: outcome.ms };
  }
  return {
    backend: "idpass",
    outcome: await deps.idPassFallback(),
    reason: outcome.kind,
    raycastMs: outcome.ms,
  };
}
