import { describe, it, expect } from "vitest";

import {
  ComposeValidationError,
  buildComposeEnqueues,
  draftToCompose,
  emptyCompose,
  quickDeadline,
  toDraftFields,
  type ComposeFields,
} from "../src/composeModel";

const meta = {
  projectId: "p1",
  taskId: "t1",
  actor: { uid: "u1", name: "Ana" },
  at: 1000,
};

function fields(over: Partial<ComposeFields> = {}): ComposeFields {
  return { ...emptyCompose(), title: "Crack in slab", ...over };
}

describe("buildComposeEnqueues", () => {
  it("title trim; create-only when unassigned", () => {
    const [create] = buildComposeEnqueues(fields({ title: "  Punched shear wall  " }), meta);
    expect(create.verb).toBe("create");
    expect(create.statusFrom).toBeNull();
    expect(create.statusTo).toBe(10);
    expect(create.title).toBe("Punched shear wall");
    expect(create.taskId).toBe("t1");
    expect(create.clientGuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("assignee flips create→assign: two payloads, second lands ongoing", () => {
    const payloads = buildComposeEnqueues(
      fields({ assigneeUid: "u2", assigneeName: "Bea" }),
      meta
    );
    expect(payloads).toHaveLength(2);
    const [create, assign] = payloads;
    expect(create.statusTo).toBe(10);
    expect(assign.verb).toBe("assign");
    expect(assign.statusFrom).toBe(10);
    expect(assign.statusTo).toBe(20);
    expect(assign.patch).toEqual({ assigneeUid: "u2", assigneeName: "Bea" });
    expect(assign.clientGuid).not.toBe(create.clientGuid); // distinct entries
  });

  it("empty title rejects", () => {
    expect(() => buildComposeEnqueues(fields({ title: "   " }), meta)).toThrow(
      ComposeValidationError
    );
  });

  it("createDoc carries description/type/deadline/photos with sha-paths", () => {
    const [create] = buildComposeEnqueues(
      fields({
        description: "re-check before pour",
        type: "defect",
        deadline: 2000,
        photos: [{ blobKey: "b1", sha256: "f".repeat(64), size: 10, mime: "image/jpeg" }],
      }),
      meta
    );
    const doc = create.createDoc as Record<string, unknown>;
    expect(doc.description).toBe("re-check before pour");
    expect(doc.type).toBe("defect");
    expect(doc.deadline).toBe(2000);
    expect((doc.photos as { storagePath: string }[])[0].storagePath).toMatch(
      /^projects\/p1\/tasks\/t1\/f{12}-0\.jpg$/
    );
  });
});

describe("sheet references (attach from project)", () => {
  const ref = { pdfFileId: "f1", pdfVersionId: "f1v2", versionNumber: 2, name: "A101.pdf" };

  it("rides the create doc as references, not copies", () => {
    const [create] = buildComposeEnqueues(fields({ sheetRefs: [ref] }), meta);
    expect((create.createDoc as { sheetRefs?: unknown }).sheetRefs).toEqual([ref]);
    expect(create.photoRefs).toEqual([]); // nothing to upload for a reference
  });

  it("omits the field when nothing is attached (old shape stays valid)", () => {
    const [create] = buildComposeEnqueues(fields(), meta);
    expect("sheetRefs" in (create.createDoc as object)).toBe(false);
  });

  it("survives the draft round-trip", () => {
    const draft = toDraftFields(fields({ sheetRefs: [ref] }), "p1", "t1");
    expect(draft.sheetRefs).toEqual([ref]);
    expect(draftToCompose(draft).sheetRefs).toEqual([ref]);
  });
});

describe("draft round-trip", () => {
  it("compose → draft → compose preserves the recoverable fields", () => {
    const src = fields({
      description: "d",
      type: "observation",
      assigneeUid: "u9",
      assigneeName: "Nine",
      deadline: 12345,
      photos: [{ blobKey: "b1", sha256: "a".repeat(64), size: 3, mime: "image/png" }],
    });
    const draft = toDraftFields(src, "p1", "t1");
    expect(draft.photoPaths[0].storagePath).toContain("/t1/");
    const back = draftToCompose(draft);
    expect(back.title).toBe("Crack in slab");
    expect(back.assigneeUid).toBe("u9");
    expect(back.deadline).toBe(12345);
    expect(back.photos[0].blobKey).toBe("b1"); // blob itself is gone — the row failed honestly
  });
});

describe("quickDeadline", () => {
  // Local noon so the local-midnight rounding is unambiguous vs UTC.
  const NOON = new Date(2026, 10, 2, 12, 0, 0, 0).getTime(); // 2 Nov 2026 12:00 local

  it("today → local midnight of the same day", () => {
    const t = quickDeadline(NOON, "today");
    const d = new Date(t);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("tomorrow → local midnight of the next day", () => {
    const t = quickDeadline(NOON, "tomorrow");
    const d = new Date(t);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(0);
  });

  it("week → local midnight seven days out", () => {
    const t = quickDeadline(NOON, "week");
    const d = new Date(t);
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(0);
  });

  it("rolls across month/year boundaries", () => {
    const newYearEve = new Date(2026, 11, 31, 18, 0, 0, 0).getTime();
    const t = quickDeadline(newYearEve, "tomorrow");
    const d = new Date(t);
    expect(d.getFullYear()).toBe(2027);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

import { restoreDraftCompose } from "../src/draftRestore";

describe("restoreDraftCompose", () => {
  const draft = () =>
    toDraftFields(
      fields({
        photos: [
          { blobKey: "b1", sha256: "a", size: 3, mime: "image/jpeg" },
          { blobKey: "b2", sha256: "b", size: 3, mime: "image/jpeg" },
        ],
      }),
      "p1",
      "t1",
    );

  it("resolves photos from the blob store and drops lost ones", async () => {
    const store = new Map([["b1", new Blob(["abc"], { type: "image/jpeg" })]]);
    const back = await restoreDraftCompose(draft(), { get: async (k) => store.get(k) });
    expect(back.photos.map((p) => p.blobKey)).toEqual(["b1"]);
    expect(back.title).toBe("Crack in slab");
  });

  it("gives restored photos an object-URL preview when available", async () => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = () => "blob:preview";
    try {
      const blob = new Blob(["abc"], { type: "image/jpeg" });
      const back = await restoreDraftCompose(draft(), { get: async () => blob });
      expect(back.photos).toHaveLength(2);
      expect(back.photos[0].previewUrl).toBe("blob:preview");
    } finally {
      URL.createObjectURL = orig;
    }
  });
});
