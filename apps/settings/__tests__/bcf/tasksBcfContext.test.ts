import { describe, expect, it, vi } from "vitest";

import {
  BCF_CACHE_TTL_MS,
  createTasksBcfContext,
  isIfcGuid,
  type BcfContextDeps,
  type BcfFileRef,
  type BcfViewerLike,
} from "../../src/bcf/tasksBcfContext";

const G1 = "0123456789abcdefghijkl"; // 22 chars
const G2 = "2O2Fr$t4X7Zf8NOew3FNld";

const files: BcfFileRef[] = [
  { id: "m-b", name: "b.ifc", currentVersionId: "v-b" },
  { id: "m-a", name: "a.ifc", currentVersionId: "v-a" },
];

function makeDeps(over: Partial<BcfContextDeps> = {}, viewer: BcfViewerLike | null = null) {
  const deps = {
    getBuildingMetadata: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    listFiles: vi.fn(async () => files),
    getFile: vi.fn(async (id: string) => files.find((f) => f.id === id)),
    readVersionShift: vi.fn(async (_v: string) => [1, 2, 3] as [number, number, number]),
    readVersionGuids: vi.fn(async (_v: string, ids: number[]) => ids.map((i) => (i === 1 ? G1 : i === 2 ? G2 : null))),
    getViewer: vi.fn(() => viewer),
    ...over,
  } satisfies BcfContextDeps;
  return deps;
}

describe("isIfcGuid", () => {
  it("accepts 22 chars of [0-9A-Za-z_$] only", () => {
    expect(isIfcGuid(G1)).toBe(true);
    expect(isIfcGuid(G2)).toBe(true);
    expect(isIfcGuid("short")).toBe(false);
    expect(isIfcGuid(G1 + "x")).toBe(false);
    expect(isIfcGuid("0123456789abcdefghij-l")).toBe(false);
    expect(isIfcGuid(null)).toBe(false);
  });
});

describe("resolveBaseShift order", () => {
  it("1. building metadata wins", async () => {
    const deps = makeDeps({ getBuildingMetadata: vi.fn(async () => ({ bundleBaseShift: [9, 8, 7] })) });
    const ctx = createTasksBcfContext(deps);
    expect(await ctx.resolveBaseShift!("b1")).toEqual([9, 8, 7]);
    expect(deps.readVersionShift).not.toHaveBeenCalled();
  });

  it("ignores a malformed metadata shift and reads the base model's fragment (first by name)", async () => {
    const deps = makeDeps({ getBuildingMetadata: vi.fn(async () => ({ bundleBaseShift: [1, "x", 3] })) });
    const ctx = createTasksBcfContext(deps);
    expect(await ctx.resolveBaseShift!("b1")).toEqual([1, 2, 3]);
    expect(deps.readVersionShift).toHaveBeenCalledWith("v-a"); // a.ifc sorts first
  });

  it("3. falls back to the live viewer only when it holds a model of the building", async () => {
    const failing = { readVersionShift: vi.fn(async () => { throw new Error("no frag"); }) };
    const viewer: BcfViewerLike = { loadedModelIds: new Set(["m-b"]), getBaseCoordinates: () => [4, 5, 6] };
    expect(await createTasksBcfContext(makeDeps(failing, viewer)).resolveBaseShift!("b1")).toEqual([4, 5, 6]);

    const other: BcfViewerLike = { loadedModelIds: new Set(["elsewhere"]), getBaseCoordinates: () => [4, 5, 6] };
    expect(await createTasksBcfContext(makeDeps(failing, other)).resolveBaseShift!("b1")).toBeNull();
  });

  it("4. null without a building, without files, or when everything fails", async () => {
    const deps = makeDeps({ listFiles: vi.fn(async () => []) });
    const ctx = createTasksBcfContext(deps);
    expect(await ctx.resolveBaseShift!(null)).toBeNull();
    expect(await ctx.resolveBaseShift!("b1")).toBeNull();
  });

  it("caches per building (and expires)", async () => {
    let t = 0;
    const deps = makeDeps();
    const ctx = createTasksBcfContext(deps, () => t);
    await ctx.resolveBaseShift!("b1");
    await ctx.resolveBaseShift!("b1");
    expect(deps.readVersionShift).toHaveBeenCalledTimes(1);
    await ctx.resolveBaseShift!("b2");
    expect(deps.readVersionShift).toHaveBeenCalledTimes(2);
    t = BCF_CACHE_TTL_MS + 1;
    await ctx.resolveBaseShift!("b1");
    expect(deps.readVersionShift).toHaveBeenCalledTimes(3);
  });

  it("does not cache a miss", async () => {
    const deps = makeDeps({ listFiles: vi.fn(async () => []) });
    const ctx = createTasksBcfContext(deps);
    await ctx.resolveBaseShift!("b1");
    await ctx.resolveBaseShift!("b1");
    expect(deps.listFiles).toHaveBeenCalledTimes(2);
  });
});

describe("resolveGlobalIds", () => {
  it("reads the stored fragment in one batch per model and fills originatingSystem/authoringToolId", async () => {
    const deps = makeDeps();
    const ctx = createTasksBcfContext(deps);
    const out = await ctx.resolveGlobalIds!("b1", [
      { modelId: "m-a", expressId: 1 },
      { modelId: "m-a", expressId: 2 },
      { modelId: "m-a", expressId: 3 },
    ]);
    expect(deps.readVersionGuids).toHaveBeenCalledTimes(1);
    expect(deps.readVersionGuids).toHaveBeenCalledWith("v-a", [1, 2, 3]);
    expect(out[0]).toEqual({ ifcGuid: G1, originatingSystem: "a.ifc", authoringToolId: "m-a:1" });
    expect(out[1]?.ifcGuid).toBe(G2);
    expect(out[2]).toBeNull();
  });

  it("caches per model: a second call only asks for missing ids", async () => {
    const deps = makeDeps();
    const ctx = createTasksBcfContext(deps);
    await ctx.resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 1 }]);
    await ctx.resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 1 }, { modelId: "m-a", expressId: 2 }]);
    expect(deps.readVersionGuids).toHaveBeenCalledTimes(2);
    expect(deps.readVersionGuids).toHaveBeenLastCalledWith("v-a", [2]);
    await ctx.resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 2 }]);
    expect(deps.readVersionGuids).toHaveBeenCalledTimes(2);
  });

  it("prefers the live viewer when the model is loaded", async () => {
    const viewer: BcfViewerLike = {
      loadedModelIds: new Set(["m-a"]),
      getGlobalIds: vi.fn(async (_m: string, ids: number[]) => ids.map(() => G2)),
    };
    const deps = makeDeps({}, viewer);
    const out = await createTasksBcfContext(deps).resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 7 }]);
    expect(out[0]?.ifcGuid).toBe(G2);
    expect(deps.readVersionGuids).not.toHaveBeenCalled();
  });

  it("falls back to the fragment when the viewer returns null", async () => {
    const viewer: BcfViewerLike = { loadedModelIds: new Set(["m-a"]), getGlobalIds: vi.fn(async () => null) };
    const deps = makeDeps({}, viewer);
    const out = await createTasksBcfContext(deps).resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 1 }]);
    expect(out[0]?.ifcGuid).toBe(G1);
  });

  it("rejects malformed guids and unknown models", async () => {
    const deps = makeDeps({ readVersionGuids: vi.fn(async (_v: string, ids: number[]) => ids.map(() => "not-a-guid")) });
    const ctx = createTasksBcfContext(deps);
    expect(await ctx.resolveGlobalIds!(null, [{ modelId: "m-a", expressId: 1 }, { modelId: "gone", expressId: 1 }])).toEqual([null, null]);
  });

  it("does not provide taskUrl (no deep-link route exists)", () => {
    expect(createTasksBcfContext(makeDeps()).taskUrl).toBeUndefined();
  });
});
