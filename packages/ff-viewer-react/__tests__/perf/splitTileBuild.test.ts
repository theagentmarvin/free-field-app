import { describe, expect, it } from "vitest";
import {
  resolveSplitTileBuild,
  SPLIT_TILE_BUILD_CACHE_BYTES,
  SPLIT_TILE_BUILD_MAX_HELPERS,
  SPLIT_TILE_BUILD_MIN_BYTES,
} from "../../src/perf/splitTileBuild";

describe("resolveSplitTileBuild", () => {
  it("is off when the prop is false", () => {
    expect(resolveSplitTileBuild(false, { cores: 16, deviceMemoryGb: 8 })).toBeUndefined();
  });

  it("defaults to cores - 2 helpers, capped, with the big-model bar", () => {
    expect(resolveSplitTileBuild(true, { cores: 4, deviceMemoryGb: 8 })).toEqual({
      helpers: 2,
      minBytes: SPLIT_TILE_BUILD_MIN_BYTES,
      cacheBytes: SPLIT_TILE_BUILD_CACHE_BYTES,
    });
    expect(resolveSplitTileBuild(undefined, { cores: 16 })?.helpers).toBe(
      SPLIT_TILE_BUILD_MAX_HELPERS,
    );
  });

  it("is off where there are no spare cores or the core count is unknown", () => {
    expect(resolveSplitTileBuild(true, { cores: 2 })).toBeUndefined();
    expect(resolveSplitTileBuild(true, { cores: 1 })).toBeUndefined();
    expect(resolveSplitTileBuild(true, {})).toBeUndefined();
  });

  it("is off on low-memory devices (each helper holds a model copy)", () => {
    expect(resolveSplitTileBuild(true, { cores: 8, deviceMemoryGb: 2 })).toBeUndefined();
    expect(resolveSplitTileBuild(true, { cores: 8, deviceMemoryGb: 4 })?.helpers).toBe(3);
  });

  it("honours explicit tuning", () => {
    expect(
      resolveSplitTileBuild(
        { helpers: 1, minBytes: 1024, inflight: 3, cacheBytes: 1e6 },
        { cores: 4 },
      ),
    ).toEqual({ helpers: 1, minBytes: 1024, inflight: 3, cacheBytes: 1e6 });
    // An explicit helper count wins over the core heuristic, 0 turns it off.
    expect(resolveSplitTileBuild({ helpers: 2 }, { cores: 2 })?.helpers).toBe(2);
    expect(resolveSplitTileBuild({ helpers: 0 }, { cores: 16 })).toBeUndefined();
    expect(resolveSplitTileBuild({ helpers: Number.NaN }, { cores: 16 })).toBeUndefined();
  });

  it("drops a nonsensical inflight value", () => {
    expect(resolveSplitTileBuild({ inflight: 0 }, { cores: 4 })).not.toHaveProperty("inflight");
  });
});
