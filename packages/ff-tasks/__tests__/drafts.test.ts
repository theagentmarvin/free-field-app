import { describe, it, expect } from "vitest";

import {
  saveDraft,
  loadDraft,
  clearDraft,
  latestDraft,
  TaskDraftFieldsSchema,
  type DraftTable,
  type TaskDraftFields,
} from "../src/drafts";

/** In-memory port with the same shape as the Dexie drafts table. */
class MemTable implements DraftTable {
  rows = new Map<string, { id: string; projectId: string; updatedAt: number; draft: Record<string, unknown> }>();
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { id: r.id, draft: structuredClone(r.draft) } : undefined;
  }
  async put(row: { id: string; projectId: string; updatedAt: number; draft: Record<string, unknown> }) {
    this.rows.set(row.id, structuredClone(row));
  }
  async delete(id: string) { this.rows.delete(id); }
  async whereProject(projectId: string) {
    return [...this.rows.values()]
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ id: r.id, updatedAt: r.updatedAt, draft: structuredClone(r.draft) as Record<string, unknown> }));
  }
}

const base = { title: "Crack in slab", description: "", type: "task", assigneeUid: null, assigneeName: null, deadline: null, location: null, locationThumb: null, photoPaths: [] } satisfies TaskDraftFields;

describe("drafts — crash recovery (§7 screen 2, one table)", () => {
  it("save → load round-trips through zod defaults", async () => {
    const t = new MemTable();
    await saveDraft(t, "d1", "p1", base as TaskDraftFields, 100);
    const loaded = await loadDraft(t, "d1");
    expect(loaded?.title).toBe("Crack in slab");
    expect(loaded?.description).toBe(""); // schema default filled
  });

  it("autosave overwrites by id (the 15 s snapshot is last-write-wins)", async () => {
    const t = new MemTable();
    await saveDraft(t, "d1", "p1", { ...base, title: "first" } as TaskDraftFields, 100);
    await saveDraft(t, "d1", "p1", { ...base, title: "second" } as TaskDraftFields, 115);
    expect((await loadDraft(t, "d1"))?.title).toBe("second");
    expect(t.rows.size).toBe(1);
  });

  it("latestDraft returns the newest for the project only", async () => {
    const t = new MemTable();
    await saveDraft(t, "old", "p1", { ...base, title: "old" } as TaskDraftFields, 10);
    await saveDraft(t, "new", "p1", { ...base, title: "new" } as TaskDraftFields, 20);
    await saveDraft(t, "other", "p2", { ...base, title: "other" } as TaskDraftFields, 30);
    const found = await latestDraft(t, "p1");
    expect(found?.id).toBe("new");
    expect(found?.fields.title).toBe("new");
  });

  it("clear on successful send leaves nothing behind", async () => {
    const t = new MemTable();
    await saveDraft(t, "d1", "p1", base as TaskDraftFields, 1);
    await clearDraft(t, "d1");
    expect(await loadDraft(t, "d1")).toBeUndefined();
    expect(await latestDraft(t, "p1")).toBeUndefined();
  });

  it("a location pin round-trips with the D1/D2 shapes", () => {
    const parsed = TaskDraftFieldsSchema.parse({
      ...base,
      location: {
        storeyName: "Level 1",
        bim: {
          elements: [{ modelId: "m-1", expressId: 451 }],
          worldPoint: [1, 2, 3],
          cameraPose: { pos: [10, 10, 10], target: [0, 0, 0], fov: 45, isOrtho: false },
        },
        pdf: null,
      },
    });
    expect(parsed.location?.bim?.elements[0]).toEqual({ modelId: "m-1", expressId: 451 });
    expect(parsed.location?.bim?.cameraPose?.isOrtho).toBe(false);
  });
});
