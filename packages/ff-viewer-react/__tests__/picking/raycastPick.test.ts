// __tests__/picking/raycastPick.test.ts
//
// Wave 45 — worker-raycast primary pick seam. The boss requirement is
// instant MEP selection regardless of model size / warm-up state, and
// the only lever that removes the applied-tile dependency is
// `FragmentsManager.raycast` (tile-independent worker virtual-geometry
// raycast). This seam runs it FIRST, with the id-pass path as fallback.
//
// These tests pin down the seam's contract against stubs (no THREE, no
// WebGL):
//   - raycast-hit     → the raycast's `localId` (express id) is selected;
//     `itemId` (the internal flatbuffer index) is NEVER mistaken for it.
//   - raycast-null    → empty space (authoritative miss, no id-pass re-scan).
//   - raycast-throws  → id-pass fallback runs instead.
//   - raycast-timeout → bounded race; fallback + `onTimeout` breadcrumb.
//   - pre-tessellation → a hit resolves even when the id-pass has NO tiles.

import { afterEach, describe, expect, it, vi } from "vitest";

import { isRaycastPrimary } from "../../src/picking/chooseBackend";
import {
  pickElementIdRaycast,
  pickElementIdRaycastFirst,
  mapRaycastHit,
  RAYCAST_PICK_TIMEOUT_MS,
} from "../../src/picking/pickSeam";
import type { WorkerRaycaster } from "../../src/picking/pickSeam";

// A minimal engine-shaped raycast result: `fragments` carries the model;
// `localId` is the express id; `itemId` is the internal index (a decoy —
// tests assert it is NOT what gets selected).
const hitResult = (over: Partial<{
  localId: number;
  itemId: number;
  modelId: string;
  point: { x: number; y: number; z: number };
}> = {}) => ({
  localId: over.localId ?? 465474,
  itemId: over.itemId ?? 12_345,
  fragments: { modelId: over.modelId ?? "mep" },
  point: over.point ?? { x: 1, y: 2, z: 3 },
});

const managerHitting = (result: unknown): WorkerRaycaster => ({
  raycast: vi.fn(async () => result as never),
});

describe("isRaycastPrimary", () => {
  it("is primary only when the raycast surface AND a clean id-pass coexist", () => {
    expect(
      isRaycastPrimary({
        fastAvailable: true,
        fastInitError: null,
        raycasterAvailable: true,
        raycastAvailable: true,
      }),
    ).toBe(true);
  });

  it("is not primary when the raycast surface is absent", () => {
    expect(
      isRaycastPrimary({
        fastAvailable: true,
        fastInitError: null,
        raycasterAvailable: true,
        raycastAvailable: false,
      }),
    ).toBe(false);
  });

  it("is not primary when the id-pass fallback did not initialize", () => {
    expect(
      isRaycastPrimary({
        fastAvailable: false,
        fastInitError: "renderer missing",
        raycasterAvailable: true,
        raycastAvailable: true,
      }),
    ).toBe(false);
  });
});

describe("mapRaycastHit", () => {
  it("maps localId → expressId (ignores the internal itemId)", () => {
    const res = mapRaycastHit(hitResult({ localId: 465474, itemId: 99 }));
    expect(res).toEqual({
      modelId: "mep",
      expressId: 465474,
      point: { x: 1, y: 2, z: 3 },
    });
  });

  it("returns null for a miss (null / undefined)", () => {
    expect(mapRaycastHit(null)).toBeNull();
    expect(mapRaycastHit(undefined)).toBeNull();
  });

  it("returns null when the result carries no express id or model id", () => {
    expect(mapRaycastHit({ itemId: 1 })).toBeNull();
    expect(mapRaycastHit({ localId: 5 })).toBeNull();
  });
});

describe("pickElementIdRaycast (bounded primitive)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hit → { kind: hit, hit: { modelId, expressId, point } }", async () => {
    const manager = managerHitting(hitResult({ localId: 77, modelId: "m-2" }));
    const res = await pickElementIdRaycast(manager, {});
    expect(res).toMatchObject({
      kind: "hit",
      hit: { modelId: "m-2", expressId: 77, point: { x: 1, y: 2, z: 3 } },
    });
  });

  it("null from the manager → { kind: miss }", async () => {
    const manager = managerHitting(null);
    expect(await pickElementIdRaycast(manager, {})).toMatchObject({
      kind: "miss",
    });
  });

  it("undefined from the manager → { kind: miss } (FragmentsManager returns undefined)", async () => {
    const manager = managerHitting(undefined);
    expect(await pickElementIdRaycast(manager, {})).toMatchObject({
      kind: "miss",
    });
  });

  it("a rejection is NOT laundered into a miss → { kind: throw }", async () => {
    const err = new Error("worker wedged");
    const manager: WorkerRaycaster = {
      raycast: vi.fn(async () => {
        throw err;
      }),
    };
    const res = await pickElementIdRaycast(manager, {});
    expect(res).toMatchObject({ kind: "throw", error: err });
  });

  it("a missing manager → { kind: throw } (never a miss)", async () => {
    const res = await pickElementIdRaycast(null, {});
    expect(res.kind).toBe("throw");
  });

  it("a never-settling raycast is bounded → { kind: timeout } + onTimeout", async () => {
    vi.useFakeTimers();
    let timedOut = 0;
    const manager: WorkerRaycaster = {
      raycast: () => new Promise(() => undefined),
    };
    const pending = pickElementIdRaycast(manager, {}, { onTimeout: () => void (timedOut += 1) });
    await vi.advanceTimersByTimeAsync(RAYCAST_PICK_TIMEOUT_MS);
    const res = await pending;
    expect(res).toMatchObject({ kind: "timeout" });
    expect(timedOut).toBe(1);
  });
});

describe("pickElementIdRaycastFirst (raycast → id-pass fallback)", () => {
  const idPass = (result: unknown) => vi.fn(async () => result as never);

  it("raycast hit is authoritative — the id-pass fallback is NOT consulted", async () => {
    const fallback = idPass({ modelId: "m-1", expressId: 1, probeNdc: { x: 0, y: 0 } });
    const res = await pickElementIdRaycastFirst({
      raycast: managerHitting(hitResult({ localId: 55, modelId: "mep" })),
      raycastData: {},
      idPassFallback: fallback,
    });
    expect(res).toMatchObject({
      backend: "raycast",
      kind: "hit",
      hit: { modelId: "mep", expressId: 55 },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("raycast miss is authoritative empty space — no id-pass tolerance re-scan", async () => {
    const fallback = idPass(null);
    const res = await pickElementIdRaycastFirst({
      raycast: managerHitting(null),
      raycastData: {},
      idPassFallback: fallback,
    });
    expect(res).toMatchObject({ backend: "raycast", kind: "miss" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("raycast throws → id-pass fallback runs, tagged reason: throw", async () => {
    const fallback = idPass({ modelId: "m-1", expressId: 9, probeNdc: { x: 0, y: 0 } });
    const manager: WorkerRaycaster = {
      raycast: async () => {
        throw new Error("boom");
      },
    };
    const res = await pickElementIdRaycastFirst({
      raycast: manager,
      raycastData: {},
      idPassFallback: fallback,
    });
    expect(res).toMatchObject({ backend: "idpass", reason: "throw" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("raycast timeout → id-pass fallback + reason: timeout (breadcrumb at caller)", async () => {
    const fallback = idPass(null);
    const manager: WorkerRaycaster = {
      raycast: () => new Promise(() => undefined),
    };
    const res = await pickElementIdRaycastFirst({
      raycast: manager,
      raycastData: {},
      idPassFallback: fallback,
      timeoutMs: 1,
    });
    expect(res).toMatchObject({ backend: "idpass", reason: "timeout" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("missing raycast → id-pass fallback + reason: unavailable", async () => {
    const fallback = idPass({ modelId: "m-1", expressId: 2, probeNdc: { x: 0, y: 0 } });
    const res = await pickElementIdRaycastFirst({
      raycast: null,
      raycastData: {},
      idPassFallback: fallback,
    });
    expect(res).toMatchObject({ backend: "idpass", reason: "unavailable" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("pre-tessellation: the raycast hits even when the id-pass has no tiles", async () => {
    // The id-pass fallback returns null (no applied tiles ⇒ no id pixels),
    // yet the raycast still resolves the element — the property that makes
    // picks instant BEFORE any of the ~80 s warm-up.
    const fallback = idPass(null);
    const res = await pickElementIdRaycastFirst({
      raycast: managerHitting(hitResult({ localId: 465474, modelId: "mep" })),
      raycastData: {},
      idPassFallback: fallback,
    });
    expect(res).toMatchObject({
      backend: "raycast",
      kind: "hit",
      hit: { modelId: "mep", expressId: 465474 },
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});