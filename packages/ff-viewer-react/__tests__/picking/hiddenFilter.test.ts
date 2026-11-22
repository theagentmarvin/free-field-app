import { describe, expect, it } from "vitest";
import { HiddenElementTracker, filterHiddenHit } from "../../src/picking/hiddenFilter";

describe("HiddenElementTracker / filterHiddenHit (wave 76)", () => {
  it("tracks hide and show per model", () => {
    const t = new HiddenElementTracker();
    t.apply("m1", [1, 2, 3], false);
    expect(t.isHidden("m1", 2)).toBe(true);
    expect(t.isHidden("m2", 2)).toBe(false);
    t.apply("m1", [2], true);
    expect(t.isHidden("m1", 2)).toBe(false);
    expect(t.size).toBe(2);
  });

  it("clear(model) and clear() drop state", () => {
    const t = new HiddenElementTracker();
    t.apply("m1", [1], false);
    t.apply("m2", [1], false);
    t.clear("m1");
    expect(t.isHidden("m1", 1)).toBe(false);
    expect(t.isHidden("m2", 1)).toBe(true);
    t.clear();
    expect(t.size).toBe(0);
  });

  it("treats a hidden hit as a miss and passes visible hits and misses through", () => {
    const t = new HiddenElementTracker();
    t.apply("m1", [5], false);
    const hidden = { modelId: "m1", expressId: 5 };
    const visible = { modelId: "m1", expressId: 6 };
    expect(filterHiddenHit(hidden, t)).toBeNull();
    expect(filterHiddenHit(visible, t)).toBe(visible);
    expect(filterHiddenHit(null, t)).toBeNull();
    expect(filterHiddenHit(undefined, t)).toBeUndefined();
  });
});
