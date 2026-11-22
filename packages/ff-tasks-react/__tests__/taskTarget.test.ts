import { describe, expect, it } from "vitest";

import { resolveTaskTarget, type TargetLookup } from "../src/taskTarget";

const lookup: TargetLookup = {
  ifcFiles: new Map([
    ["m1", { id: "m1", buildingId: "bA", name: "Arch.ifc" }],
    ["m2", { id: "m2", buildingId: "bB", name: "Struct.ifc" }],
  ]),
  pdfFiles: new Map([
    ["p1", { id: "p1", buildingId: "bA", name: "A101.pdf" }],
    ["p2", { id: "p2", buildingId: "bB", name: "S101.pdf" }],
  ]),
  pdfVersions: [
    { id: "p1v1", pdfFileId: "p1", versionNumber: 1, isLatest: false },
    { id: "p1v2", pdfFileId: "p1", versionNumber: 2, isLatest: true },
    { id: "p2v1", pdfFileId: "p2", versionNumber: 1, isLatest: true },
  ],
};
const pose = { pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false };

describe("resolveTaskTarget — 3D", () => {
  const task = {
    id: "t1",
    location: {
      storeyName: "L1",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: pose },
      pdf: null,
    },
  };
  it("opens Models with the saved camera and the elements", () => {
    const r = resolveTaskTarget(task, lookup);
    expect(r).toMatchObject({
      ok: true,
      intent: { kind: "models", taskId: "t1", buildingId: "bA", cameraPose: pose, elements: [{ modelId: "m1", expressId: 7 }] },
    });
  });
  it("old task without a stored camera still opens (frames the element)", () => {
    const r = resolveTaskTarget(
      { id: "t2", location: { storeyName: null, bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: null, cameraPose: null }, pdf: null } },
      lookup,
    );
    expect(r).toMatchObject({ ok: true, intent: { kind: "models", cameraPose: null } });
  });
  it("drops elements of deleted models with a notice; none left is a clear message", () => {
    const partial = resolveTaskTarget(
      { id: "t3", location: { storeyName: null, bim: { elements: [{ modelId: "m1", expressId: 1 }, { modelId: "gone", expressId: 2 }], worldPoint: null, cameraPose: null }, pdf: null } },
      lookup,
    );
    expect(partial).toMatchObject({ ok: true, intent: { elements: [{ modelId: "m1", expressId: 1 }] } });
    expect((partial as { notice?: string }).notice).toMatch(/no longer exist/i);
    const none = resolveTaskTarget(
      { id: "t4", location: { storeyName: null, bim: { elements: [{ modelId: "gone", expressId: 2 }], worldPoint: null, cameraPose: null }, pdf: null } },
      lookup,
    );
    expect(none).toMatchObject({ ok: false });
    expect((none as { message: string }).message).toMatch(/model/i);
  });
});

describe("resolveTaskTarget — plan", () => {
  const pdfTask = (extra: Record<string, unknown> = {}) => ({
    id: "t5",
    location: { storeyName: null, bim: null, pdf: { pdfFileId: "p1", page: 1, uv: [0.25, 0.5] as [number, number], calibId: "c", ...extra } },
  });
  it("opens the pinned version when it is the latest", () => {
    const r = resolveTaskTarget(pdfTask({ pdfVersionId: "p1v2" }), lookup);
    expect(r).toMatchObject({ ok: true, intent: { kind: "documents", pdfFileId: "p1", versionId: "p1v2", page: 1, uv: [0.25, 0.5], buildingId: "bA" } });
    expect((r as { notice?: string }).notice).toBeUndefined();
  });
  it("older pinned version falls back to the latest with a clear message", () => {
    const r = resolveTaskTarget(pdfTask({ pdfVersionId: "p1v1" }), lookup);
    expect(r).toMatchObject({ ok: true, intent: { versionId: "p1v2" } });
    expect((r as { notice: string }).notice).toMatch(/v1.*v2/);
  });
  it("a pin without a version opens the latest", () => {
    expect(resolveTaskTarget(pdfTask(), lookup)).toMatchObject({ ok: true, intent: { versionId: "p1v2" } });
  });
  it("a deleted pinned version of an existing sheet falls back to its latest", () => {
    const r = resolveTaskTarget(pdfTask({ pdfVersionId: "ghost" }), lookup);
    expect(r).toMatchObject({ ok: true, intent: { versionId: "p1v2" } });
    expect((r as { notice: string }).notice).toMatch(/no longer|latest/i);
  });
  it("a deleted sheet is a clear message", () => {
    const r = resolveTaskTarget(pdfTask({ pdfFileId: "nope" }), lookup);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/plan|sheet/i);
  });
  it("a task with no location has nothing to open", () => {
    expect(resolveTaskTarget({ id: "x", location: null }, lookup)).toMatchObject({ ok: false });
  });
  it("prefers 3D when both are stored", () => {
    const both = {
      id: "b",
      location: {
        storeyName: null,
        bim: { elements: [{ modelId: "m1", expressId: 1 }], worldPoint: [0, 0, 0] as [number, number, number], cameraPose: null },
        pdf: { pdfFileId: "p1", page: 1, uv: [0, 0] as [number, number], calibId: "c" },
      },
    };
    expect(resolveTaskTarget(both, lookup)).toMatchObject({ ok: true, intent: { kind: "models" } });
  });
});

describe("resolveTaskTarget — building", () => {
  it("uses the building that owns the target file, even if the task is stamped differently", () => {
    const r = resolveTaskTarget(
      { id: "t", buildingId: "bB", location: { storeyName: null, bim: null, pdf: { pdfFileId: "p1", page: 1, uv: [0, 0], calibId: "c" } } },
      lookup,
    );
    expect(r).toMatchObject({ ok: true, intent: { buildingId: "bA" } });
  });
});
