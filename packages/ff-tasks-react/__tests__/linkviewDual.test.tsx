// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskLocation } from "@ff/firestore";
import { locationThumb2dPath, locationThumbPath } from "@ff/tasks";

import { buildComposeEnqueues, draftToCompose, emptyCompose, toDraftFields } from "../src/composeModel";
import { attachPlanSnapshotThumb, enrichTaskLocation, setTaskLocationEnricher } from "../src/snapshot";
import { resolveTaskTarget, taskOpenKind, OPEN_LABEL, type TargetLookup } from "../src/taskTarget";
import { clearPhotoUrlCache } from "../src/usePhotoUrl";

const open = vi.fn();
vi.mock("../src/taskTarget", async (orig) => ({
  ...(await orig<typeof import("../src/taskTarget")>()),
  useOpenTaskLocation: () => open,
}));

import { OpenableLocationThumb } from "../src/LocationThumb";

const pose = { pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false };
const lvLocation: TaskLocation = {
  storeyName: "L1",
  origin: "linkview",
  thumb: { storagePath: locationThumbPath("p", "t1") },
  thumb2d: { storagePath: locationThumb2dPath("p", "t1") },
  bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3], cameraPose: pose },
  pdf: { pdfFileId: "p1", page: 1, uv: [0.25, 0.5], calibId: "p1__L1", pdfVersionId: "p1v2" },
};
const lvTask = { id: "t1", buildingId: "bA", location: lvLocation };

afterEach(() => {
  cleanup();
  clearPhotoUrlCache();
  open.mockClear();
  setTaskLocationEnricher(null);
});

describe("attachPlanSnapshotThumb", () => {
  it("stamps thumb2d + a blob ref and keeps the 3D thumb", () => {
    const base: TaskLocation = { ...lvLocation, thumb2d: undefined };
    const { location, thumb } = attachPlanSnapshotThumb("data:image/jpeg;base64,AAAA", "p", "t1", base);
    expect(location.thumb2d?.storagePath).toBe(locationThumb2dPath("p", "t1"));
    expect(location.thumb?.storagePath).toBe(locationThumbPath("p", "t1"));
    expect(thumb?.size).toBe(3);
  });
  it("a failed capture leaves the location untouched", () => {
    const { location, thumb } = attachPlanSnapshotThumb(null, "p", "t1", lvLocation);
    expect(thumb).toBeNull();
    expect(location).toBe(lvLocation);
  });
});

describe("task location enricher (creation seam)", () => {
  const loc: TaskLocation = { storeyName: null, bim: null, pdf: null };
  it("is a no-op unless a host (LinkView) registered one", () => {
    const r = enrichTaskLocation(loc, { projectId: "p", taskId: "t" });
    expect(r.location).toBe(loc);
    expect(r.thumb2d).toBeNull();
  });
  it("uses the registered enricher and survives a throwing one", () => {
    setTaskLocationEnricher(() => ({ location: lvLocation, thumb2d: { blobKey: "k", size: 1, mime: "image/jpeg" } }));
    expect(enrichTaskLocation(loc, { projectId: "p", taskId: "t" }).location).toBe(lvLocation);
    setTaskLocationEnricher(() => {
      throw new Error("boom");
    });
    expect(enrichTaskLocation(loc, { projectId: "p", taskId: "t" }).location).toBe(loc);
  });
});

describe("compose model carries the plan thumb", () => {
  it("create payload has locationThumb2d and the doc location has both sides", () => {
    const fields = {
      ...emptyCompose(),
      title: "Crack",
      location: lvLocation,
      locationThumb: { blobKey: "a", size: 1, mime: "image/jpeg" },
      locationThumb2d: { blobKey: "b", size: 2, mime: "image/jpeg" },
    };
    const [create] = buildComposeEnqueues(fields, { projectId: "p", taskId: "t1", actor: { uid: "u", name: "A" }, at: 1 });
    expect(create.locationThumb2d).toEqual({ blobKey: "b", size: 2, mime: "image/jpeg" });
    const loc = (create.createDoc as { location: TaskLocation }).location;
    expect(loc.bim).toBeTruthy();
    expect(loc.pdf?.pdfVersionId).toBe("p1v2");
    expect(loc.origin).toBe("linkview");
  });
  it("a Models/Documents compose has no plan thumb", () => {
    const [create] = buildComposeEnqueues({ ...emptyCompose(), title: "x" }, { projectId: "p", taskId: "t", actor: { uid: "u", name: "A" }, at: 1 });
    expect(create.locationThumb2d).toBeNull();
  });
  it("drafts round-trip the plan thumb", () => {
    const f = { ...emptyCompose(), location: lvLocation, locationThumb2d: { blobKey: "b", size: 2, mime: "image/jpeg" } };
    const d = toDraftFields(f, "p", "t1");
    expect(d.locationThumb2d?.blobKey).toBe("b");
    expect(draftToCompose(d as never).locationThumb2d?.blobKey).toBe("b");
  });
});

describe("dual thumb display", () => {
  const resolve = async (p: string) => `blob:${p}`;

  it("a LinkView task with both thumbs shows plan | 3D side by side, each opening LinkView", async () => {
    render(
      <OpenableLocationThumb
        task={lvTask}
        path={lvLocation.thumb!.storagePath}
        path2d={lvLocation.thumb2d!.storagePath}
        resolve={resolve}
        label="Snap"
      />,
    );
    const two = await screen.findByTestId("ff-location-thumb-2d");
    const three = await screen.findByTestId("ff-location-thumb-3d");
    expect(two.getAttribute("src")).toContain("location-thumb-2d.jpg");
    expect(three.getAttribute("src")).toContain("location-thumb.jpg");
    // plan first (left), 3D second (right)
    expect(two.compareDocumentPosition(three) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Open in LinkView" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(lvTask);
  });

  it("a Models task renders the single thumb exactly as before", async () => {
    const task = { id: "m", location: { bim: lvLocation.bim, pdf: null, thumb: lvLocation.thumb } };
    render(<OpenableLocationThumb task={task} path="a" path2d={null} resolve={resolve} label="Snap" />);
    await screen.findByTestId("ff-location-thumb");
    expect(screen.queryByTestId("ff-location-thumb-2d")).toBeNull();
    expect(screen.getByRole("button", { name: "Open in Models" })).toBeTruthy();
  });

  it("a LinkView task missing the plan thumb falls back to the single thumb, still LinkView", async () => {
    render(<OpenableLocationThumb task={lvTask} path="a" path2d={null} resolve={resolve} label="Snap" />);
    await screen.findByTestId("ff-location-thumb");
    expect(screen.getByRole("button", { name: "Open in LinkView" })).toBeTruthy();
  });

  it("a non-LinkView task ignores a stray thumb2d", async () => {
    const task = { id: "d", location: { bim: null, pdf: lvLocation.pdf } };
    render(<OpenableLocationThumb task={task} path="a" path2d="b" resolve={resolve} label="Snap" />);
    await screen.findByTestId("ff-location-thumb");
    expect(screen.queryByTestId("ff-location-thumb-2d")).toBeNull();
  });
});

describe("quick access routes LinkView tasks to /linkview", () => {
  const lookup: TargetLookup = {
    ifcFiles: new Map([["m1", { id: "m1", buildingId: "bA", name: "Arch.ifc" }]]),
    pdfFiles: new Map([["p1", { id: "p1", buildingId: "bA", name: "A101.pdf" }]]),
    pdfVersions: [
      { id: "p1v1", pdfFileId: "p1", versionNumber: 1, isLatest: false },
      { id: "p1v2", pdfFileId: "p1", versionNumber: 2, isLatest: true },
    ],
  };

  it("kind and label", () => {
    expect(taskOpenKind(lvTask)).toBe("linkview");
    expect(OPEN_LABEL.linkview).toBe("Open in LinkView");
    // origin marker is required: a task with both sides but no origin keeps the old routing
    expect(taskOpenKind({ id: "x", location: { ...lvLocation, origin: undefined } })).toBe("models");
  });

  it("builds one intent with the plan half and the 3D half", () => {
    const r = resolveTaskTarget(lvTask, lookup);
    expect(r).toMatchObject({
      ok: true,
      intent: {
        kind: "linkview",
        taskId: "t1",
        buildingId: "bA",
        documents: { pdfFileId: "p1", versionId: "p1v2", page: 1, uv: [0.25, 0.5] },
        models: { elements: [{ modelId: "m1", expressId: 7 }], cameraPose: pose },
      },
    });
    expect((r as { notice?: string }).notice).toBeUndefined();
  });

  it("keeps the version fallback notice when pinned on a superseded version", () => {
    const old = { ...lvTask, location: { ...lvLocation, pdf: { ...lvLocation.pdf!, pdfVersionId: "p1v1" } } };
    const r = resolveTaskTarget(old, lookup);
    expect(r).toMatchObject({ ok: true, intent: { documents: { versionId: "p1v2" } } });
    expect((r as { notice?: string }).notice).toMatch(/Pinned on v1.*Showing the latest \(v2\)/);
  });

  it("a deleted sheet still opens the 3D half, with the notice", () => {
    const r = resolveTaskTarget({ ...lvTask, location: { ...lvLocation, pdf: { ...lvLocation.pdf!, pdfFileId: "gone" } } }, lookup);
    expect(r).toMatchObject({ ok: true, intent: { kind: "linkview", documents: null, models: { elements: [{ modelId: "m1", expressId: 7 }] } } });
    expect((r as { notice?: string }).notice).toMatch(/plan sheet/i);
  });

  it("both targets gone is a clear message", () => {
    const r = resolveTaskTarget(
      { ...lvTask, location: { ...lvLocation, bim: { ...lvLocation.bim!, elements: [{ modelId: "gone", expressId: 1 }] }, pdf: { ...lvLocation.pdf!, pdfFileId: "gone" } } },
      lookup,
    );
    expect(r.ok).toBe(false);
  });
});
