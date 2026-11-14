import { describe, expect, it } from "vitest";
import {
  resolveTileCache,
  TILE_CACHE_MAX_MODELS,
  TILE_CACHE_MIN_BYTES,
  TILE_CACHE_WAIT_MS,
} from "../../src/perf/tileCache";

const model = { fileId: "f1", versionKey: "f1__v3" };

describe("resolveTileCache", () => {
  it("is off when the prop is false/undefined or the model has no version key", () => {
    expect(resolveTileCache(false, model)).toBeUndefined();
    expect(resolveTileCache(undefined, model)).toBeUndefined();
    expect(resolveTileCache(true, { fileId: "f1", versionKey: "" })).toBeUndefined();
    expect(resolveTileCache(true, { fileId: "", versionKey: "v" })).toBeUndefined();
  });

  it("keys by file and version with the defaults", () => {
    expect(resolveTileCache(true, model)).toEqual({
      key: "f1|f1__v3",
      minBytes: TILE_CACHE_MIN_BYTES,
      maxModels: TILE_CACHE_MAX_MODELS,
      waitMs: TILE_CACHE_WAIT_MS,
    });
  });

  it("a new version gets a new key", () => {
    expect(resolveTileCache(true, model)?.key).not.toBe(
      resolveTileCache(true, { ...model, versionKey: "f1__v4" })?.key,
    );
  });

  it("honours and clamps tuning", () => {
    expect(resolveTileCache({ minBytes: 5, maxModels: 2.7, waitMs: 100 }, model)).toMatchObject({
      minBytes: 5,
      maxModels: 2,
      waitMs: 100,
    });
    expect(resolveTileCache({ minBytes: -1, maxModels: 0, waitMs: -5 }, model)).toMatchObject({
      minBytes: 0,
      maxModels: 1,
      waitMs: 0,
    });
  });
});
