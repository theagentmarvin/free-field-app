// Wave 14 — pure backend selection for the picking seam.
//
// FastModelPicker is preferred when it initialized cleanly; otherwise
// we fall back to the engine's stock `OBC.Raycasters`. Keeping this a
// pure function (no engine imports) is what makes the "which backend is
// chosen / fallback on init failure" behavior unit-testable.

import type { BackendId } from "./pickTypes";

/** Result of the feature-detection probe run once at viewer init. */
export interface BackendProbe {
  /** FastModelPicker was constructed without throwing. */
  fastAvailable: boolean;
  /** Serialized construction/init error, or `null` when clean. */
  fastInitError: string | null;
  /** The `OBC.Raycasters` component resolved for the world. */
  raycasterAvailable: boolean;
  /**
   * Wave 45: the worker virtual raycast (`FragmentsManager.raycast`) is
   * present. Ped to the seam as the PRIMARY pick backend; the id-pass
   * (`fast`) / Raycasters stay as its fallback. Optional so pre-45 probes
   * (and their tests) keep compiling.
   */
  raycastAvailable?: boolean;
}

/**
 * Choose the live backend from a feature-detection probe.
 *
 * `"fast"` wins only when the FastModelPicker constructed cleanly
 * (`fastAvailable` and no init error). In every other case — including
 * a FastModelPicker that threw during init, or missing Raycasters — we
 * return `"raycaster"` as the safe default (the resolver no-ops to
 * `null` when even that is absent, so callers always get a well-defined
 * `null` rather than a crash).
 */
export function chooseBackend(probe: BackendProbe): BackendId {
  if (probe.fastAvailable && probe.fastInitError === null) return "fast";
  return "raycaster";
}

/**
 * Wave 45: is the worker raycast the primary pick backend for this probe?
 *
 * This does NOT change the `"fast" | "raycaster"` decision above — that
 * remains the id-pass-vs-Highlighter choice. The raycast is a PRE-PASS on
 * top of the fast id-pass pipeline (its fallback), so it is primary only
 * when BOTH the raycast surface exists AND the fast id-pass initialized
 * cleanly (otherwise the raycast pre-pass has no id-pass fallback inside
 * that pipeline and the caller stays on the Highlighter path).
 */
export function isRaycastPrimary(probe: BackendProbe): boolean {
  return (
    probe.raycastAvailable === true &&
    probe.fastAvailable &&
    probe.fastInitError === null
  );
}