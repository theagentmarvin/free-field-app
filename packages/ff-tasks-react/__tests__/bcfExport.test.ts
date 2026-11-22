import { describe, expect, it, vi } from "vitest";

import type { BcfBinary } from "@ff/tasks";

import {
  BCF_MAX_TOPICS,
  bcfDoneMessage,
  buildBcfBundles,
  buildBcfUserDirectory,
  firstValue,
  selectBcfScope,
  sheetPinNote,
  type BuildBcfDeps,
  type TasksBcfContext,
} from "../src/bcfExport";
import type { TaskTableRow } from "../src/tableColumns";

const bin = (n = 1): BcfBinary => ({ bytes: new Uint8Array(n), mime: "image/jpeg" });

function row(over: Record<string, unknown> = {}): TaskTableRow {
  return {
    id: "t1",
    num: 1,
    title: "Fix wall",
    status: 10,
    updatedAt: 2000,
    createdAt: 1000,
    assigneeName: null,
    lastAction: "create",
    entryCount: 1,
    ...over,
  } as TaskTableRow;
}

const camera = { pos: [1, 2, 3], target: [4, 5, 6], fov: 50, isOrtho: false };

function makeDeps(over: Partial<BuildBcfDeps> = {}, full: Record<string, unknown> | null = null, entries: unknown[] = []) {
  const unsubTask = vi.fn();
  const unsubEntries = vi.fn();
  const source = {
    watchTask: vi.fn((_p: string, _id: string, cb: (t: unknown) => void) => {
      queueMicrotask(() => cb(full));
      return unsubTask;
    }),
    watchTaskEntries: vi.fn((_p: string, _id: string, cb: (e: unknown[]) => void) => {
      queueMicrotask(() => cb(entries));
      return unsubEntries;
    }),
  };
  const fetchBinary = vi.fn(async (_path: string, _o: { mime?: string; measure?: boolean }) => bin());
  const deps: BuildBcfDeps = {
    projectId: "p1",
    source: source as unknown as BuildBcfDeps["source"],
    fetchBinary,
    ...over,
  };
  return { deps, source, fetchBinary, unsubTask, unsubEntries };
}

describe("selectBcfScope", () => {
  it("prefers the selection over the view", () => {
    const s = selectBcfScope(["a"], ["a", "b", "c"]);
    expect(s.rows).toEqual(["a"]);
    expect(s.fromSelection).toBe(true);
  });
  it("falls back to the view when nothing is selected", () => {
    const s = selectBcfScope([], ["a", "b"]);
    expect(s.rows).toEqual(["a", "b"]);
    expect(s.fromSelection).toBe(false);
    expect(s.capped).toBe(false);
  });
  it("caps at 500", () => {
    const view = Array.from({ length: 612 }, (_, i) => i);
    const s = selectBcfScope([], view);
    expect(s.rows).toHaveLength(BCF_MAX_TOPICS);
    expect(s.total).toBe(612);
    expect(s.capped).toBe(true);
  });
});

describe("buildBcfUserDirectory", () => {
  const dir = buildBcfUserDirectory([
    { uid: "u1", name: "Ana Silva", email: "ana@x.io" },
    { uid: "u2", name: "Mateo Rojas" },
  ]);
  it("email, then display name, then fallback name, then uid", () => {
    expect(dir.author("u1", "ignored")).toBe("ana@x.io");
    expect(dir.author("u2")).toBe("Mateo Rojas");
    expect(dir.author("u3", "Stored Name")).toBe("Stored Name");
    expect(dir.author("u4")).toBe("u4");
    expect(dir.author(null)).toBeNull();
  });
  it("authorByName maps a known display name to its email", () => {
    expect(dir.authorByName?.("Ana Silva")).toBe("ana@x.io");
    expect(dir.authorByName?.("Someone Else")).toBe("Someone Else");
    expect(dir.authorByName?.("")).toBeNull();
  });
  it("merges duplicate uids, keeping a known email", () => {
    const d = buildBcfUserDirectory([{ uid: "u1", name: "A", email: "a@x.io" }, { uid: "u1", name: "A2" }]);
    expect(d.author("u1")).toBe("a@x.io");
  });
});

describe("sheetPinNote", () => {
  const pdf = { pdfFileId: "f1", page: 2, uv: [0.424, 0.611] as [number, number] };
  it("formats percentages from uv (top-left origin)", () => {
    expect(sheetPinNote(pdf, { sheetRefs: [{ pdfFileId: "f1", name: "A101" }] })).toBe("Sheet A101 · page 2 · at 42 %, 61 %");
  });
  it("uses the catalog lookup, then the unknown label", () => {
    expect(sheetPinNote(pdf, { lookup: () => "B202" })).toContain("Sheet B202 ·");
    expect(sheetPinNote(pdf, {})).toBe("Sheet (unknown) · page 2 · at 42 %, 61 %");
  });
  it("clamps out-of-range uv", () => {
    expect(sheetPinNote({ ...pdf, uv: [-1, 2] }, {})).toContain("at 0 %, 100 %");
  });
});

describe("firstValue", () => {
  it("resolves the first callback and unsubscribes once", async () => {
    const unsub = vi.fn();
    const v = await firstValue<number>((cb) => {
      setTimeout(() => cb(1), 0);
      setTimeout(() => cb(2), 1);
      return unsub;
    }, 0);
    expect(v).toBe(1);
    expect(unsub).toHaveBeenCalledTimes(1);
  });
  it("unsubscribes even when the callback fires synchronously", async () => {
    const unsub = vi.fn();
    const v = await firstValue<number>((cb) => {
      cb(7);
      return unsub;
    }, 0);
    expect(v).toBe(7);
    expect(unsub).toHaveBeenCalledTimes(1);
  });
  it("falls back after the timeout", async () => {
    const unsub = vi.fn();
    const v = await firstValue<string>(() => unsub, "fb", 5);
    expect(v).toBe("fb");
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe("buildBcfBundles", () => {
  const ctxBase: TasksBcfContext = {
    resolveBaseShift: async () => [10, 0, -5],
    resolveGlobalIds: async (_b, els) =>
      els.map((e) => (e.expressId === 1 ? { ifcGuid: "0123456789abcdefghijkl", originatingSystem: "m.ifc", authoringToolId: `${e.modelId}:1` } : null)),
  };

  it("carries the camera from location.bim.cameraPose and resolves components", async () => {
    const full = { ...row(), location: { storeyName: "L1", bim: { elements: [{ modelId: "m", expressId: 1 }, { modelId: "m", expressId: 2 }], worldPoint: null, cameraPose: camera } } };
    const { deps } = makeDeps({ context: ctxBase }, full);
    const out = await buildBcfBundles([row({ buildingId: "b1", buildingName: "Tower" })], deps);
    const b = out.bundles[0]!;
    expect(b.task.cameraPose).toEqual(camera);
    expect(b.task.buildingName).toBe("Tower");
    expect(b.task.storeyName).toBe("L1");
    expect(b.components).toHaveLength(1);
    expect(b.unresolvedComponents).toBe(1);
    expect(out.shifts.get("t1")).toEqual([10, 0, -5]);
  });

  it("never gives a 2D-only (pdf) task a camera, and writes the pin note", async () => {
    const full = { ...row(), location: { storeyName: null, bim: null, pdf: { pdfFileId: "f1", page: 1, uv: [0.42, 0.61], calibId: "c" } } };
    const { deps } = makeDeps({ context: ctxBase, sheetName: () => "A101" }, full);
    const b = (await buildBcfBundles([row()], deps)).bundles[0]!;
    expect(b.task.cameraPose).toBeNull();
    expect(b.task.sheetPinNote).toBe("Sheet A101 · page 1 · at 42 %, 61 %");
  });

  it("without a context: no camera, no components", async () => {
    const full = { ...row(), location: { storeyName: null, bim: { elements: [{ modelId: "m", expressId: 1 }], worldPoint: null, cameraPose: camera } } };
    const { deps } = makeDeps({}, full);
    const out = await buildBcfBundles([row()], deps);
    expect(out.bundles[0]!.task.cameraPose).toBeNull();
    expect(out.bundles[0]!.components).toBeUndefined();
    expect(out.shifts.get("t1")).toBeNull();
  });

  it("fetches snapshot, task photos and entry photos; one-shot unsubscribes", async () => {
    const full = {
      ...row(),
      photos: [{ storagePath: "p/1.jpg", mime: "image/jpeg", caption: "crack", sha256: "x", size: 1 }],
      location: { storeyName: null, thumb: { storagePath: "p/thumb.jpg" }, bim: null, pdf: null },
    };
    const entries = [
      { id: "e2", action: "comment", text: "later", by: "A", byUid: "u1", at: 20, statusFrom: null, statusTo: null, photos: [{ storagePath: "p/e.png", mime: "image/png" }] },
      { id: "e1", action: "create", text: "", by: "A", byUid: "u1", at: 10, statusFrom: null, statusTo: 10, photos: [] },
    ];
    const { deps, fetchBinary, unsubTask, unsubEntries } = makeDeps({}, full, entries);
    const b = (await buildBcfBundles([row()], deps)).bundles[0]!;
    const paths = fetchBinary.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(["p/thumb.jpg", "p/1.jpg", "p/e.png"]);
    expect(fetchBinary.mock.calls[0]![1].measure).toBe(true);
    expect(b.photos).toHaveLength(2);
    expect(b.photos![0]!.caption).toBe("crack");
    expect(b.photos![1]!.entryId).toBe("e2");
    expect(b.snapshot).toBeTruthy();
    expect(b.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(unsubTask).toHaveBeenCalledTimes(1);
    expect(unsubEntries).toHaveBeenCalledTimes(1);
  });

  it("skips photos whose fetch fails or throws", async () => {
    const full = { ...row(), photos: [{ storagePath: "a" }, { storagePath: "b" }] };
    const fetchBinary = vi.fn(async (p: string) => {
      if (p === "a") throw new Error("x");
      return null;
    });
    const { deps } = makeDeps({ fetchBinary }, full);
    const out = await buildBcfBundles([row()], deps);
    expect(out.bundles[0]!.photos).toHaveLength(0);
    expect(out.skippedPhotos).toBe(2);
  });

  it("exports a photo repeated by the creation entry once (same storage path)", async () => {
    const full = { ...row(), photos: [{ storagePath: "p/1.png", mime: "image/png" }, { storagePath: "p/2.png", mime: "image/png" }] };
    const entries = [
      { id: "e1", action: "create", text: "", by: "A", byUid: "u1", at: 10, statusFrom: null, statusTo: 10, photos: [{ storagePath: "p/1.png" }, { storagePath: "p/2.png" }] },
      { id: "e2", action: "comment", text: "c", by: "A", byUid: "u1", at: 20, statusFrom: null, statusTo: null, photos: [{ storagePath: "p/3.png" }] },
    ];
    const { deps, fetchBinary } = makeDeps({}, full, entries);
    const b = (await buildBcfBundles([row()], deps)).bundles[0]!;
    expect(fetchBinary.mock.calls.map((c) => c[0])).toEqual(["p/1.png", "p/2.png", "p/3.png"]);
    expect(b.photos!.map((p) => p.entryId ?? null)).toEqual([null, null, "e2"]);
  });

  it("stops adding photos past the byte budget and counts them", async () => {
    const full = { ...row(), photos: ["a", "b", "c", "d"].map((p) => ({ storagePath: p })) };
    const fetchBinary = vi.fn(async () => bin(40));
    const { deps } = makeDeps({ fetchBinary, maxPhotoBytes: 100 }, full);
    const out = await buildBcfBundles([row()], deps);
    expect(out.bundles[0]!.photos).toHaveLength(2); // 40 + 40; the 3rd would be 120 > 100
    expect(out.budgetSkippedPhotos).toBe(2);
    expect(out.skippedPhotos).toBe(0);
    expect(fetchBinary).toHaveBeenCalledTimes(3); // the 4th is not even fetched
  });

  it("keeps the snapshot when the photo budget is zero", async () => {
    const full = { ...row(), photos: [{ storagePath: "a" }], location: { storeyName: null, thumb: { storagePath: "t" }, bim: null, pdf: null } };
    const { deps } = makeDeps({ maxPhotoBytes: 0 }, full);
    const out = await buildBcfBundles([row()], deps);
    expect(out.bundles[0]!.snapshot).toBeTruthy();
    expect(out.bundles[0]!.photos).toHaveLength(0);
    expect(out.budgetSkippedPhotos).toBe(1);
  });

  it("falls back to the row when the task doc never arrives", async () => {
    const source = { watchTask: vi.fn(() => () => {}), watchTaskEntries: vi.fn(() => () => {}) };
    const out = await buildBcfBundles([row({ description: "d", priority: "high" })], {
      projectId: "p1",
      source: source as unknown as BuildBcfDeps["source"],
      fetchBinary: async () => null,
      timeoutMs: 5,
    });
    expect(out.bundles[0]!.task.description).toBe("d");
    expect(out.bundles[0]!.task.priority).toBe("high");
    expect(out.bundles[0]!.entries).toEqual([]);
  });

  it("reports progress and caches the shift per building", async () => {
    const resolveBaseShift = vi.fn(async () => [1, 2, 3] as [number, number, number]);
    const { deps } = makeDeps({ context: { resolveBaseShift }, onProgress: vi.fn() });
    const rows = ["a", "b", "c"].map((id) => row({ id, buildingId: "b1" }));
    await buildBcfBundles(rows, deps);
    expect(resolveBaseShift).toHaveBeenCalledTimes(1);
    expect(deps.onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe("bcfDoneMessage", () => {
  it("counts tasks and distinct tasks without a 3D view", () => {
    const w = (taskId: string, kind: "no-3d-view" | "photo-skipped") => ({ taskId, taskNum: 1, kind, message: "" });
    expect(bcfDoneMessage(40, "2.1", [])).toBe("Exported 40 tasks to BCF 2.1");
    expect(bcfDoneMessage(1, "3.0", [w("a", "no-3d-view"), w("a", "no-3d-view"), w("b", "photo-skipped")])).toBe(
      "Exported 1 task to BCF 3.0 · 1 without 3D view",
    );
  });
  it("surfaces skipped photos and the photo size limit", () => {
    expect(bcfDoneMessage(2, "2.1", [], { skipped: 1 })).toBe("Exported 2 tasks to BCF 2.1 · 1 photo skipped");
    expect(bcfDoneMessage(2, "2.1", [], { skipped: 3, budgetSkipped: 2 })).toBe(
      "Exported 2 tasks to BCF 2.1 · 3 photos skipped · photo size limit reached, 2 photos left out",
    );
    expect(bcfDoneMessage(2, "3.0", [], { skipped: 0, budgetSkipped: 0 })).toBe("Exported 2 tasks to BCF 3.0");
  });
});
