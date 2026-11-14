import { describe, it, expect } from "vitest";

import type { Task, TaskEntry } from "@ff/firestore";

import type { DemoTaskStore } from "../src/demoTaskSource";
import { DemoTaskSource } from "../src/demoTaskSource";
import { buildDemoTaskSeeds, type DemoSeedContext } from "../src/demoSeed";
import { TERMINAL_STATUSES } from "../src/status";

class MemDemoStore implements DemoTaskStore {
  tasks = new Map<string, Task>();
  entriesByTask = new Map<string, TaskEntry[]>();
  counter: { next: number } | undefined;
  photos = new Map<string, string>();
  async putTask(_p: string, t: Task) { this.tasks.set(t.id, structuredClone(t)); }
  async getTask(id: string) { const t = this.tasks.get(id); return t ? structuredClone(t) : undefined; }
  async listTasks() { return [...this.tasks.values()]; }
  async countTasks() { return this.tasks.size; }
  async putEntry(_p: string, taskId: string, e: TaskEntry) {
    const l = this.entriesByTask.get(taskId) ?? [];
    l.push(structuredClone(e));
    this.entriesByTask.set(taskId, l);
  }
  async listEntries(_p: string, taskId: string) { return this.entriesByTask.get(taskId) ?? []; }
  async getCounter() { return this.counter; }
  async putCounter(_p: string, c: { next: number }) { this.counter = { ...c }; }
  async putPhoto(p: string, d: string) { this.photos.set(p, d); }
  async getPhoto(p: string) { return this.photos.get(p); }
}

let seq = 0;
function ctx(over: Partial<DemoSeedContext> = {}): DemoSeedContext {
  return {
    projectId: "default-project",
    modelId: "ifc-1",
    storeys: [
      { name: "Level 1", elevation: 0, expressId: 101, containedElementIds: [1001, 1002] },
      { name: "Level 2", elevation: 3, expressId: 102, containedElementIds: [2001] },
      { name: "Level 3", elevation: 6, expressId: 103, containedElementIds: [3001] },
    ],
    pdfFileId: "pdf-s101",
    now: 1_700_000_000_000,
    newId: () => `id-${++seq}`,
    ...over,
  };
}

describe("buildDemoTaskSeeds", () => {
  it("produces 6–8 tasks with the required status mix", () => {
    const seeds = buildDemoTaskSeeds(ctx());
    expect(seeds.length).toBeGreaterThanOrEqual(6);
    expect(seeds.length).toBeLessThanOrEqual(8);

    const statuses = seeds.map((s) => s.task.status);
    expect(statuses).toContain(40); // awaiting-approval
    expect(statuses).toContain(30); // rejected (reserved display state)
    expect(statuses.some((s) => TERMINAL_STATUSES.includes(s))).toBe(true);
  });

  it("assigns 2–3 3D locations with the REAL model id + plausible world points", () => {
    const seeds = buildDemoTaskSeeds(ctx());
    const with3D = seeds.filter((s) => s.task.location?.bim?.worldPoint);
    expect(with3D.length).toBeGreaterThanOrEqual(2);
    expect(with3D.length).toBeLessThanOrEqual(3);
    for (const s of with3D) {
      const bim = s.task.location!.bim!;
      expect(bim.elements[0].modelId).toBe("ifc-1");
      expect(bim.worldPoint).toHaveLength(3);
      expect(Number.isFinite(bim.worldPoint![1])).toBe(true);
    }
  });

  it("assigns exactly one 2D location on S-101 page 1", () => {
    const seeds = buildDemoTaskSeeds(ctx());
    const with2D = seeds.filter((s) => s.task.location?.pdf);
    expect(with2D).toHaveLength(1);
    const pdf = with2D[0].task.location!.pdf!;
    expect(pdf.pdfFileId).toBe("pdf-s101");
    expect(pdf.page).toBe(1);
    expect(pdf.uv).toHaveLength(2);
  });

  it("includes one task with 2 photos and per-task entry history", () => {
    const seeds = buildDemoTaskSeeds(ctx());
    const twoPhotos = seeds.filter((s) => s.task.photos.length === 2);
    expect(twoPhotos).toHaveLength(1);
    for (const s of seeds) {
      expect(s.entries.length).toBeGreaterThanOrEqual(1);
      expect(s.task.entryCount).toBe(s.entries.length);
    }
  });

  it("numbers tasks T001..T008 sequentially", () => {
    const seeds = buildDemoTaskSeeds(ctx());
    const nums = seeds.map((s) => s.task.num);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("DemoTaskSource.seed idempotency", () => {
  it("seeds once then becomes a no-op (counter pinned, no duplicates)", async () => {
    const store = new MemDemoStore();
    const source = new DemoTaskSource({ store, latency: { wait: async () => undefined } });
    const seeds = buildDemoTaskSeeds(ctx());

    const first = await source.seed("default-project", seeds);
    expect(first).toBe(true);
    expect(store.tasks.size).toBe(seeds.length);
    expect(store.counter).toEqual({ next: seeds.length });

    const second = await source.seed("default-project", buildDemoTaskSeeds(ctx()));
    expect(second).toBe(false);
    expect(store.tasks.size).toBe(seeds.length);
  });
});