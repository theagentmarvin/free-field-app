// packages/ff-viewer-tools/__tests__/manualVisibilityStore.test.ts
//
// Wave 48 — the durable manual-visibility overlay + its merge helper.
// This is the regression Maintainer hit: the wave-47 toolbar applied
// hide/isolate through `setElementVisibility` with no record, so a
// filter reapplication pass (triggered by deselect) overwrote the manual
// ops. These tests pin the overlay semantics and prove the merge is
// idempotent w.r.t. manual ops (re-running it keeps hidden ids hidden).

import { beforeEach, describe, expect, it } from "vitest";

import {
  useManualVisibilityStore,
  computeFinalVisibleSets,
} from "../src/manualVisibilityStore";

function resetStore(): void {
  useManualVisibilityStore.getState().showAll();
}

describe("manualVisibilityStore", () => {
  beforeEach(resetStore);

  const state = () => useManualVisibilityStore.getState();

  it("hideIds accumulates manual hides per model", () => {
    state().hideIds("m1", new Set([1, 2]));
    state().hideIds("m1", new Set([2, 3]));
    expect(state().hidden.get("m1")).toEqual(new Set([1, 2, 3]));
  });

  it("isolateTo replaces the isolate set with the given map", () => {
    state().isolateTo(new Map([["m1", new Set([5])]]));
    expect(state().isolate?.visible.get("m1")).toEqual(new Set([5]));
  });

  it("hideIds while isolated also removes the ids from the isolate set", () => {
    state().isolateTo(new Map([["m1", new Set([2, 3])]]));
    state().hideIds("m1", new Set([2]));
    expect(state().isolate?.visible.get("m1")).toEqual(new Set([3]));
    expect(state().hidden.get("m1")).toEqual(new Set([2]));
  });

  it("showAll clears both hidden and isolate", () => {
    state().hideIds("m1", new Set([1]));
    state().isolateTo(new Map([["m1", new Set([2])]]));
    state().showAll();
    expect(state().hidden.size).toBe(0);
    expect(state().isolate).toBeNull();
  });

  it("clearModel forgets one model's overlay entries", () => {
    state().hideIds("m1", new Set([1]));
    state().hideIds("m2", new Set([2]));
    state().isolateTo(
      new Map([
        ["m1", new Set([1])],
        ["m2", new Set([2])],
      ]),
    );
    state().clearModel("m1");
    expect(state().hidden.has("m1")).toBe(false);
    expect(state().hidden.has("m2")).toBe(true);
    expect(state().isolate?.visible.has("m1")).toBe(false);
    expect(state().isolate?.visible.has("m2")).toBe(true);
  });
});

describe("computeFinalVisibleSets (filter + overlay merge)", () => {
  const modelIds = new Set([1, 2, 3, 4]);
  const matching = new Set([1, 2, 3]); // 4 is filtered out by the auto filter

  it("no overlay → final = matching", () => {
    const { visible, hidden } = computeFinalVisibleSets("m1", modelIds, matching, {
      hidden: new Map(),
      isolate: null,
    });
    expect(visible).toEqual(new Set([1, 2, 3]));
    expect(hidden).toEqual(new Set([4]));
  });

  it("hidden → final = matching − hidden, idempotent across reapplication", () => {
    const overlay = {
      hidden: new Map([["m1", new Set([1, 2])]]),
      isolate: null,
    };
    const first = computeFinalVisibleSets("m1", modelIds, matching, overlay);
    // Maintainer's regression: a deselect re-runs the SAME merge — the hidden
    // ids must stay hidden (the manual overlay is the durable record).
    const second = computeFinalVisibleSets("m1", modelIds, matching, overlay);
    expect(first.visible).toEqual(new Set([3]));
    expect(first.hidden).toEqual(new Set([1, 2, 4]));
    expect(second).toEqual(first);
  });

  it("isolate → final = matching ∩ isolate.visible, surviving deselect", () => {
    const overlay = {
      hidden: new Map(),
      isolate: { visible: new Map([["m1", new Set([2])]]) },
    };
    const first = computeFinalVisibleSets("m1", modelIds, matching, overlay);
    // A deselect does NOT mutate the overlay, so the isolate survives.
    const second = computeFinalVisibleSets("m1", modelIds, matching, overlay);
    expect(first.visible).toEqual(new Set([2]));
    expect(first.hidden).toEqual(new Set([1, 3, 4]));
    expect(second).toEqual(first);
  });

  it("show-all restores matching (overlay cleared)", () => {
    const cleared = { hidden: new Map(), isolate: null };
    const { visible } = computeFinalVisibleSets("m1", modelIds, matching, cleared);
    expect(visible).toEqual(new Set([1, 2, 3]));
  });

  it("isolate with a model that has no entry hides every id in that model", () => {
    const overlay = {
      hidden: new Map(),
      isolate: { visible: new Map([["other", new Set([2])]]) },
    };
    const { visible, hidden } = computeFinalVisibleSets("m1", modelIds, matching, overlay);
    expect(visible).toEqual(new Set());
    expect(hidden).toEqual(new Set([1, 2, 3, 4]));
  });
});
describe("manualVisibilityStore — replaceOverlay (wave 54)", () => {
  beforeEach(resetStore);

  const state = () => useManualVisibilityStore.getState();

  it("swaps both overlays wholesale (saved-viewpoint restore)", () => {
    state().hideIds("m1", new Set([1]));
    state().isolateTo(new Map([["m1", new Set([2])]]));
    state().replaceOverlay({
      hidden: new Map([["m9", new Set([7, 8])]]),
      isolate: null,
    });
    expect(state().hidden.has("m1")).toBe(false);
    expect(state().hidden.get("m9")).toEqual(new Set([7, 8]));
    expect(state().isolate).toBeNull();
  });

  it("replaceOverlay(null) clears like showAll", () => {
    state().hideIds("m1", new Set([1]));
    state().replaceOverlay(null);
    expect(state().hidden.size).toBe(0);
    expect(state().isolate).toBeNull();
  });

  it("drops empty id sets on replace", () => {
    state().replaceOverlay({
      hidden: new Map([["m1", new Set()]]),
      isolate: { visible: new Map([["m2", new Set([3])]]) },
    });
    expect(state().hidden.has("m1")).toBe(false);
    expect(state().isolate?.visible.get("m2")).toEqual(new Set([3]));
  });
});
