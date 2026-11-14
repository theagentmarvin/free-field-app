// apps/settings/__tests__/seed/demoSeed.test.ts
//
// Wave 56 — unit tests for the direct-injection demo seed (replaces
// the Task 32 pipeline-seed tests, which are retired with
// `pipelineBridge.tsx`).
//
// Covered:
//   • non-demo mode          → "skipped" (real mode never auto-seeds)
//   • stale v2 flag, empty DB → "seeded" (Dexie decides, wave 63)
//   • building already there → "skipped" (protects pre-populated profiles)
//   • happy path             → tables + blobs injected, flag set, NO
//                              IFC pipeline involved (no useIfcPipeline)
//   • failure                → the fail counter is bumped, the flag
//                              is NOT set, nothing is written
//   • counter ≥ 3            → "unavailable" (a broken seed never loops)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // `calls` records the ordered table-bulkPut sequence so the
  // parent-before-child order is under test, not just "called".
  const calls: string[] = [];
  const makeTable = (name: string) => ({
    bulkPut: vi.fn(async () => {
      calls.push(name);
      return undefined;
    }),
  });
  const db = {
    transaction: vi.fn(
      async (
        _mode: string,
        _tables: unknown[],
        fn: () => Promise<void>,
      ): Promise<unknown> => fn(),
    ),
    projects: makeTable("projects"),
    buildings: makeTable("buildings"),
    ifcFiles: makeTable("ifcFiles"),
    pdfFiles: makeTable("pdfFiles"),
    ifcVersions: makeTable("ifcVersions"),
    pdfVersions: makeTable("pdfVersions"),
    storeys: makeTable("storeys"),
    extractedStoreys: makeTable("extractedStoreys"),
    buildingLevelSelection: makeTable("buildingLevelSelection"),
    pdfFolders: makeTable("pdfFolders"),
    pdfFolderAssignments: makeTable("pdfFolderAssignments"),
    propertyCatalog: makeTable("propertyCatalog"),
    calibrations: makeTable("calibrations"),
    fragBlobs: { put: vi.fn(async () => undefined) },
    pdfBlobs: { put: vi.fn(async () => undefined) },
  };
  return {
    db,
    calls,
    isDemoAuth: vi.fn(() => true),
    listBuildings: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("@ff/auth", () => ({ isDemoAuth: mocks.isDemoAuth, DEMO_PROJECT_ID: "default-project" }));
vi.mock("@ff/data/db/database", () => ({ db: mocks.db }));
vi.mock("@ff/data/db/tables/buildings", () => ({
  listBuildings: mocks.listBuildings,
}));

/** Fresh module instance per test — the seed memoizes its in-flight promise. */
async function loadSeedModule() {
  vi.resetModules();
  return import("../../src/seed/demoSeed");
}

/** Minimal, valid manifest used across happy-path cases. */
const SAMPLE_MANIFEST = {
  format: "free-field-demo-seed",
  version: 1,
  tables: {
    projects: [
      { id: "default-project", name: "Default", metadata: {}, createdAt: 1, updatedAt: 1 },
    ],
    buildings: [
      { id: "b1", projectId: "default-project", name: "Demo App", metadata: {}, createdAt: 2, updatedAt: 2 },
    ],
    ifcFiles: [],
    ifcVersions: [],
    storeys: [],
    extractedStoreys: [],
    buildingLevelSelection: [],
    pdfFiles: [],
    pdfVersions: [],
    pdfFolders: [],
    pdfFolderAssignments: [],
    propertyCatalog: [],
    calibrations: [],
  },
  fragBlobs: [{ key: "f1", __blob: true }],
  pdfBlobs: [{ key: "p1", __blob: true }],
};

/** Wire `fetch` to serve the manifest + one blob per referenced key. */
function stubFetch(manifest: unknown) {
  mocks.fetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === "/seed/manifest.json") {
      return { ok: true, status: 200, json: async () => manifest };
    }
    if (u.startsWith("/seed/blobs/")) {
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob([u]),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), blob: async () => new Blob() };
  });
}

beforeEach(() => {
  localStorage.clear();
  mocks.calls.length = 0;
  vi.stubGlobal("fetch", mocks.fetch);

  mocks.isDemoAuth.mockReturnValue(true);
  mocks.listBuildings.mockReset().mockResolvedValue([]);
  mocks.db.transaction.mockClear();
  mocks.db.fragBlobs.put.mockClear();
  mocks.db.pdfBlobs.put.mockClear();
  for (const name of [
    "projects",
    "buildings",
    "ifcFiles",
    "pdfFiles",
    "ifcVersions",
    "pdfVersions",
    "storeys",
    "extractedStoreys",
    "buildingLevelSelection",
    "pdfFolders",
    "pdfFolderAssignments",
    "propertyCatalog",
    "calibrations",
  ] as const) {
    mocks.db[name].bulkPut.mockClear();
  }
  mocks.fetch.mockReset();
  stubFetch(SAMPLE_MANIFEST);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("runDemoSeedIfEmpty", () => {
  it("skips when the app is not in demo mode", async () => {
    mocks.isDemoAuth.mockReturnValue(false);
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("skipped");
    expect(mocks.listBuildings).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("ff-demo-seeded-v2")).toBeNull();
  });

  // Wave 63: "already seeded" is decided from Dexie. A stale
  // localStorage flag (e.g. IndexedDB was cleared) must not block the
  // seed.
  it("seeds when the v2 flag is set but Dexie has no demo building", async () => {
    localStorage.setItem("ff-demo-seeded-v2", "1");
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("seeded");
    expect(mocks.listBuildings).toHaveBeenCalledWith("default-project");
    expect(mocks.db.buildings.bulkPut).toHaveBeenCalled();
  });

  it("fetches the blobs in parallel", async () => {
    stubFetch({
      ...SAMPLE_MANIFEST,
      fragBlobs: [{ key: "f1" }, { key: "f2" }, { key: "f3" }],
    });
    const base = mocks.fetch.getMockImplementation()!;
    let inFlightBlobs = 0;
    let maxInFlight = 0;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (!String(url).startsWith("/seed/blobs/")) return base(url);
      inFlightBlobs++;
      maxInFlight = Math.max(maxInFlight, inFlightBlobs);
      await new Promise((r) => setTimeout(r, 5));
      inFlightBlobs--;
      return base(url);
    });
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    expect(await runDemoSeedIfEmpty()).toBe("seeded");
    expect(maxInFlight).toBeGreaterThanOrEqual(3);
  });

  it("reports isDemoSeeding() only while the seed is running", async () => {
    const mod = await loadSeedModule();
    const seen: boolean[] = [];
    mod.subscribeDemoSeeding(() => seen.push(mod.isDemoSeeding()));

    expect(mod.isDemoSeeding()).toBe(false);
    await mod.runDemoSeedIfEmpty();

    expect(seen).toEqual([true, false]);
    expect(mod.isDemoSeeding()).toBe(false);
  });

  it("skips when a building already exists in the demo project", async () => {
    mocks.listBuildings.mockResolvedValue([
      { id: "b1", projectId: "default-project", name: "Demo App" },
    ]);
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("skipped");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.db.projects.bulkPut).not.toHaveBeenCalled();
  });

  it("gives up with 'unavailable' once the failure counter hits 3", async () => {
    localStorage.setItem("ff-demo-seed-failed", "3");
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("unavailable");
    expect(mocks.listBuildings).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("ff-demo-seed-failed")).toBe("3");
  });

  it("seeds tables + blobs in parent-before-child order and sets the flag", async () => {
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("seeded");

    // The fragment + PDF blobs are written with the correct fields.
    expect(mocks.db.fragBlobs.put).toHaveBeenCalledWith({
      key: "f1",
      blob: expect.any(Blob),
    });
    expect(mocks.db.pdfBlobs.put).toHaveBeenCalledWith({
      key: "p1",
      bytes: expect.any(Blob),
    });

    // Parent-before-child ordering (projects before buildings before
    // versions before storeys before level-selection, etc).
    expect(mocks.calls).toEqual([
      "projects",
      "buildings",
      "ifcFiles",
      "pdfFiles",
      "ifcVersions",
      "pdfVersions",
      "storeys",
      "extractedStoreys",
      "buildingLevelSelection",
      "pdfFolders",
      "pdfFolderAssignments",
      "propertyCatalog",
      "calibrations",
    ]);

    // The records land via the Dexie table bulkPut (async, no pipeline).
    expect(mocks.db.projects.bulkPut).toHaveBeenCalledWith(
      SAMPLE_MANIFEST.tables.projects,
    );
    expect(mocks.db.buildings.bulkPut).toHaveBeenCalledWith(
      SAMPLE_MANIFEST.tables.buildings,
    );

    // The fetches: manifest + one blob per frag/pdf reference.
    const urls = mocks.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      "/seed/manifest.json",
      "/seed/blobs/fragBlobs/f1",
      "/seed/blobs/pdfBlobs/p1",
    ]);

    // The seed flag + counter state.
    expect(localStorage.getItem("ff-demo-seeded-v2")).toBe("1");
    expect(localStorage.getItem("ff-demo-seed-failed")).toBeNull();
  });

  it("bumps the failure counter and writes nothing when the manifest fetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch.mockRejectedValue(new Error("network down"));
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const result = await runDemoSeedIfEmpty();

    expect(result).toBe("unavailable");
    expect(localStorage.getItem("ff-demo-seed-failed")).toBe("1");
    expect(localStorage.getItem("ff-demo-seeded-v2")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    // Nothing reached Dexie.
    expect(mocks.db.fragBlobs.put).not.toHaveBeenCalled();
    expect(mocks.db.pdfBlobs.put).not.toHaveBeenCalled();
    expect(mocks.db.projects.bulkPut).not.toHaveBeenCalled();
  });

  it.each([
    ["a 404", { ok: false, status: 404, headers: new Headers() }],
    ["the SPA's index.html", { ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }) }],
  ])("treats a missing demo bundle (%s) as 'skipped' — quietly, no failure count", async (_label, res) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetch.mockResolvedValue({ ...res, json: async () => ({}) });
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    expect(await runDemoSeedIfEmpty()).toBe("skipped");
    expect(localStorage.getItem("ff-demo-seed-failed")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.db.projects.bulkPut).not.toHaveBeenCalled();
  });

  it("never runs two seeds concurrently (React StrictMode double mount)", async () => {
    const { runDemoSeedIfEmpty } = await loadSeedModule();

    const [a, b] = await Promise.all([
      runDemoSeedIfEmpty(),
      runDemoSeedIfEmpty(),
    ]);

    expect(a).toBe("seeded");
    expect(b).toBe("seeded");
    expect(mocks.db.projects.bulkPut).toHaveBeenCalledTimes(1);
    expect(mocks.db.fragBlobs.put).toHaveBeenCalledTimes(1);
  });
});