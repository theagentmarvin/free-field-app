// apps/models/__tests__/hideBimElements.test.ts
//
// Wave 50 — the "Hide instance" mapping groups a task's federated
// `{ modelId, expressId }` refs by model before hiding, so the
// wave-48 manual-visibility overlay receives one `hideIds` call per
// model. Verified against the real `useManualVisibilityStore` too.

import { describe, expect, it, vi } from "vitest";

import { hideBimElements } from "../src/hideBimElements";
import { useManualVisibilityStore } from "@ff/viewer-tools";

describe("hideBimElements", () => {
  it("groups elements by model and calls hideIds once per model", () => {
    const hideIds = vi.fn();
    hideBimElements(
      [
        { modelId: "m1", expressId: 1 },
        { modelId: "m1", expressId: 2 },
        { modelId: "m2", expressId: 5 },
      ],
      hideIds,
    );

    expect(hideIds).toHaveBeenCalledTimes(2);
    expect(hideIds.mock.calls[0]![0]).toBe("m1");
    expect([...(hideIds.mock.calls[0]![1] as Set<number>)]).toEqual([1, 2]);
    expect(hideIds.mock.calls[1]![0]).toBe("m2");
    expect([...(hideIds.mock.calls[1]![1] as Set<number>)]).toEqual([5]);
  });

  it("collapses duplicate ids within a model", () => {
    const hideIds = vi.fn();
    hideBimElements(
      [
        { modelId: "m1", expressId: 7 },
        { modelId: "m1", expressId: 7 },
      ],
      hideIds,
    );
    expect(hideIds).toHaveBeenCalledTimes(1);
    expect([...(hideIds.mock.calls[0]![1] as Set<number>)]).toEqual([7]);
  });

  it("accumulates into the wave-48 manual visibility overlay", () => {
    useManualVisibilityStore.getState().showAll();
    hideBimElements(
      [
        { modelId: "m1", expressId: 1 },
        { modelId: "m1", expressId: 2 },
        { modelId: "m2", expressId: 9 },
      ],
      (modelId, ids) => useManualVisibilityStore.getState().hideIds(modelId, ids),
    );

    const hidden = useManualVisibilityStore.getState().hidden;
    expect([...(hidden.get("m1") ?? new Set())]).toEqual([1, 2]);
    expect([...(hidden.get("m2") ?? new Set())]).toEqual([9]);

    // showAll clears the overlay (lint-guard: the action is wired).
    useManualVisibilityStore.getState().showAll();
    expect(useManualVisibilityStore.getState().hidden.size).toBe(0);
  });
});