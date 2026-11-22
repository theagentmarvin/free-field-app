// Wave 76 — visibility-aware pick filter.
//
// The viewer hides elements through `setElementVisibility` (the hider
// path used by storey isolation and the filter hooks). The pick
// pipeline's worker raycast does not consult that state, so a click
// could select an element the user cannot see. This tracker mirrors the
// hidden set the viewer itself wrote, so a pick that lands on a hidden
// element can be treated as a miss.
//
// Pure and drift-clean (no three.js, no engine imports).

export class HiddenElementTracker {
  private readonly hidden = new Map<string, Set<number>>();

  /** Record a visibility write (the same buckets handed to the hider). */
  apply(modelId: string, expressIds: Iterable<number>, visible: boolean): void {
    if (visible) {
      const set = this.hidden.get(modelId);
      if (!set) return;
      for (const id of expressIds) set.delete(id);
      if (set.size === 0) this.hidden.delete(modelId);
      return;
    }
    let set = this.hidden.get(modelId);
    if (!set) {
      set = new Set();
      this.hidden.set(modelId, set);
    }
    for (const id of expressIds) set.add(id);
  }

  isHidden(modelId: string, expressId: number): boolean {
    return this.hidden.get(modelId)?.has(expressId) ?? false;
  }

  /** Drop one model's state (model unloaded) or everything. */
  clear(modelId?: string): void {
    if (modelId === undefined) this.hidden.clear();
    else this.hidden.delete(modelId);
  }

  get size(): number {
    let n = 0;
    for (const s of this.hidden.values()) n += s.size;
    return n;
  }
}

/**
 * Treat a pick hit on a hidden element as a miss. Passes `null` /
 * `undefined` (miss / inconclusive) through untouched.
 */
export function filterHiddenHit<T extends { modelId: string; expressId: number }>(
  hit: T | null | undefined,
  tracker: Pick<HiddenElementTracker, "isHidden">,
): T | null | undefined {
  if (!hit) return hit;
  return tracker.isHidden(hit.modelId, hit.expressId) ? null : hit;
}
