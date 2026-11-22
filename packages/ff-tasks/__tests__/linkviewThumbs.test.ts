import { describe, expect, it } from "vitest";

import type { OutboxRecord } from "@ff/types";

import { buildActionPayload } from "../src/action";
import { TaskDraftFieldsSchema } from "../src/drafts";
import {
  isDualThumbLocation,
  isLinkviewLocation,
  LINKVIEW_ORIGIN,
  normalizeLocationThumb2dPath,
} from "../src/merge";
import { locationThumb2dPath, locationThumbPath } from "../src/photos";
import { createTaskExecutor } from "../src/repository";
import { outboxBlobKeys } from "../src/taskBlobs";

const bim = { elements: [{ modelId: "m1", expressId: 1 }], worldPoint: [0, 0, 0] };
const pdf = { pdfFileId: "p1", page: 1, uv: [0.1, 0.2], calibId: "c" };

describe("locationThumb2dPath", () => {
  it("is a fixed, distinct name inside the photos prefix (no storage rule change)", () => {
    expect(locationThumb2dPath("p1", "t7")).toBe("projects/p1/tasks/t7/location-thumb-2d.jpg");
    expect(locationThumb2dPath("p1", "t7")).not.toBe(locationThumbPath("p1", "t7"));
  });
});

describe("LinkView location helpers", () => {
  it("normalizeLocationThumb2dPath reads location.thumb2d.storagePath", () => {
    expect(normalizeLocationThumb2dPath({ thumb2d: { storagePath: "x" } })).toBe("x");
    expect(normalizeLocationThumb2dPath({ thumb: { storagePath: "x" } })).toBeNull();
    expect(normalizeLocationThumb2dPath(null)).toBeNull();
  });
  it("isLinkviewLocation needs the origin AND both sides", () => {
    expect(isLinkviewLocation({ origin: LINKVIEW_ORIGIN, bim, pdf })).toBe(true);
    expect(isLinkviewLocation({ bim, pdf })).toBe(false);
    expect(isLinkviewLocation({ origin: "linkview", bim, pdf: null })).toBe(false);
    expect(isLinkviewLocation(undefined)).toBe(false);
  });
  it("isDualThumbLocation additionally needs both thumbs", () => {
    const t = { storagePath: "a" };
    expect(isDualThumbLocation({ origin: "linkview", bim, pdf, thumb: t, thumb2d: t })).toBe(true);
    expect(isDualThumbLocation({ origin: "linkview", bim, pdf, thumb: t })).toBe(false);
    expect(isDualThumbLocation({ bim, pdf, thumb: t, thumb2d: t })).toBe(false);
  });
});

describe("outbox carries the plan thumb", () => {
  const base = { verb: "create" as const, projectId: "p1", taskId: "t1", statusFrom: null, actor: { uid: "u", name: "A" }, title: "x", guid: "g", at: 1 };

  it("buildActionPayload defaults locationThumb2d to null and carries it when given", () => {
    expect(buildActionPayload(base).locationThumb2d).toBeNull();
    const p = buildActionPayload({ ...base, locationThumb2d: { blobKey: "b2", size: 3, mime: "image/jpeg" } });
    expect(p.locationThumb2d?.blobKey).toBe("b2");
  });

  it("outboxBlobKeys lists the plan thumb key too", () => {
    const row = {
      photoRefs: [{ blobKey: "p1" }],
      payload: { locationThumb: { blobKey: "t3d" }, locationThumb2d: { blobKey: "t2d" } },
    } as unknown as OutboxRecord;
    expect(outboxBlobKeys(row)).toEqual(["p1", "t3d", "t2d"]);
  });

  it("the executor uploads BOTH snapshots, each at its own fixed path", async () => {
    const uploaded: string[] = [];
    const exec = createTaskExecutor(
      undefined as unknown as Parameters<typeof createTaskExecutor>[0],
      { exists: async () => false, upload: async (path: string) => void uploaded.push(path) } as never,
      { get: async () => new Blob(["x"]) } as never,
    );
    const payload = buildActionPayload({
      ...base,
      locationThumb: { blobKey: "a", size: 1, mime: "image/jpeg" },
      locationThumb2d: { blobKey: "b", size: 1, mime: "image/jpeg" },
    });
    await exec.uploadPhotos({ payload: payload as unknown as Record<string, unknown> } as OutboxRecord);
    expect(uploaded).toEqual([locationThumbPath("p1", "t1"), locationThumb2dPath("p1", "t1")]);
  });

  it("an already-uploaded 3D thumb does not skip the plan thumb (retry safe)", async () => {
    const uploaded: string[] = [];
    const exec = createTaskExecutor(
      undefined as unknown as Parameters<typeof createTaskExecutor>[0],
      { exists: async (p: string) => p === locationThumbPath("p1", "t1"), upload: async (path: string) => void uploaded.push(path) } as never,
      { get: async () => new Blob(["x"]) } as never,
    );
    const payload = buildActionPayload({
      ...base,
      locationThumb: { blobKey: "a", size: 1, mime: "image/jpeg" },
      locationThumb2d: { blobKey: "b", size: 1, mime: "image/jpeg" },
    });
    await exec.uploadPhotos({ payload: payload as unknown as Record<string, unknown> } as OutboxRecord);
    expect(uploaded).toEqual([locationThumb2dPath("p1", "t1")]);
  });
});

describe("drafts keep the LinkView location", () => {
  const draft = {
    title: "t", description: "", type: "task", assigneeUid: null, assigneeName: null, deadline: null,
    location: {
      storeyName: "L1", origin: "linkview",
      thumb: { storagePath: "a" }, thumb2d: { storagePath: "b" },
      bim: { elements: [{ modelId: "m1", expressId: 1 }], worldPoint: [0, 0, 0], cameraPose: null },
      pdf: { ...pdf, pdfVersionId: "v1" },
    },
    locationThumb: { blobKey: "a", size: 1, mime: "image/jpeg" },
    locationThumb2d: { blobKey: "b", size: 1, mime: "image/jpeg" },
    photoPaths: [],
  };
  it("round-trips thumb2d, origin and the plan blob ref", () => {
    const out = TaskDraftFieldsSchema.parse(draft);
    expect(out.location?.origin).toBe("linkview");
    expect(out.location?.thumb2d?.storagePath).toBe("b");
    expect(out.locationThumb2d?.blobKey).toBe("b");
  });
  it("an old draft (no plan thumb) parses unchanged, with no plan thumb", () => {
    const { locationThumb2d: _drop, ...old } = draft;
    expect(TaskDraftFieldsSchema.parse(old).locationThumb2d ?? null).toBeNull();
  });
});
