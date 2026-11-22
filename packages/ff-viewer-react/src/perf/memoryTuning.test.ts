import { describe, expect, it } from "vitest";
import { clearEngineBudget, effectiveMemory, publishEngineBudget, type EngineMemoryBudget } from "./memoryTuning";

describe("effectiveMemory", () => {
  it("keeps the tuning at no pressure and leaves unset budgets to the engine", () => {
    expect(effectiveMemory({ graphicsQuality: -1 }, "none")).toEqual({ graphicsQuality: -1, graphicBudgetBytes: undefined, meshCacheBytes: undefined, leanTiles: false });
  });
  it("lowers quality and budgets as pressure rises", () => {
    const t = { graphicsQuality: -1, graphicBudgetBytes: 100, meshCacheBytes: 200 };
    expect(effectiveMemory(t, "low")).toEqual({ graphicsQuality: -1.5, graphicBudgetBytes: 25, meshCacheBytes: 100, leanTiles: false });
    expect(effectiveMemory(t, "critical")).toEqual({ graphicsQuality: -2.5, graphicBudgetBytes: 0, meshCacheBytes: 20, leanTiles: false });
  });
  it("evicts invisible tiles under pressure even without a configured budget", () => {
    expect(effectiveMemory({}, "critical").graphicBudgetBytes).toBe(0);
    expect(effectiveMemory({}, "none").graphicBudgetBytes).toBeUndefined();
  });
});

describe("publishEngineBudget", () => {
  it("publishes and clears the engine globals", () => {
    const t: { __ffFragmentsMemory?: EngineMemoryBudget } = {};
    publishEngineBudget({ graphicsQuality: 0, graphicBudgetBytes: 5, meshCacheBytes: 7, leanTiles: true }, t);
    expect(t.__ffFragmentsMemory).toEqual({ graphicBudget: 5, meshCache: 7, leanTiles: true });
    publishEngineBudget({ graphicsQuality: 0, graphicBudgetBytes: undefined, meshCacheBytes: undefined, leanTiles: false }, t);
    expect(t.__ffFragmentsMemory).toBeUndefined();
    publishEngineBudget({ graphicsQuality: 0, graphicBudgetBytes: 0, meshCacheBytes: undefined, leanTiles: false }, t);
    expect(t.__ffFragmentsMemory).toEqual({ graphicBudget: 0 });
    clearEngineBudget(t);
    expect(t.__ffFragmentsMemory).toBeUndefined();
  });
});
