// apps/models/src/hideBimElements.ts
//
// Wave 50 — pure grouping helper for the "Hide instance" action in the
// task detail sheet. A task's `location.bim.elements` is a flat list of
// `{ modelId, expressId }` pairs (federated models); the wave-48 manual
// visibility overlay (`useManualVisibilityStore.hideIds`) is keyed per
// model, so we group the ids by model before calling it.
//
// No React, no viewer — the mapping is unit-testable in isolation.

export interface BimElementRef {
  modelId: string;
  expressId: number;
}

/**
 * Group the flat element refs by `modelId` and invoke `hideIds` once
 * per model with the accumulated expression ids. Duplicate ids within
 * a model collapse naturally (Set semantics).
 */
export function hideBimElements(
  elements: readonly BimElementRef[],
  hideIds: (modelId: string, ids: ReadonlySet<number>) => void,
): void {
  const byModel = new Map<string, Set<number>>();
  for (const el of elements) {
    if (!el || typeof el.modelId !== "string" || typeof el.expressId !== "number") {
      continue;
    }
    let ids = byModel.get(el.modelId);
    if (!ids) {
      ids = new Set<number>();
      byModel.set(el.modelId, ids);
    }
    ids.add(el.expressId);
  }
  for (const [modelId, ids] of byModel) {
    hideIds(modelId, ids);
  }
}