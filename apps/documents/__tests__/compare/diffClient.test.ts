import { describe, expect, it, vi } from "vitest";
import { runDiff, type DiffWorkerLike } from "../../src/compare/engine/diffClient";
import { runDiffJob, type DiffJobInput } from "../../src/compare/engine/diffJob";
import { blank, rect } from "./helpers";

const T = { colorThreshold: 48, proximityPx: 1, gridSize: 16, minPixelsPerCell: 6, mergeDistance: 1, marginPx: 0 };
const input = (): DiffJobInput => ({
  base: blank(200, 100),
  revision: rect(blank(200, 100), 50, 30, 20, 20),
  thresholds: T,
  scale: 1,
  autoAlign: false,
  nudgePx: { x: 0, y: 0 },
});

class FakeWorker implements DiffWorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  terminate = vi.fn();
  posted: unknown[] = [];
  constructor(private mode: "ok" | "bootfail" | "silent" | "hang") {
    setTimeout(() => {
      if (mode === "ok" || mode === "hang") this.emit({ type: "started" });
      else if (mode === "bootfail") this.onerror?.({ message: "boom", preventDefault() {} } as ErrorEvent);
    }, 0);
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  postMessage(msg: { type: string; input: DiffJobInput }) {
    this.posted.push(msg);
    if (this.mode !== "ok") return;
    setTimeout(() => {
      this.emit({ type: "stage", stage: "comparing" });
      this.emit({ type: "done", output: runDiffJob(msg.input) });
    }, 0);
  }
}

describe("diffClient", () => {
  it("worker happy path: boot, run, stages, terminate", async () => {
    const w = new FakeWorker("ok");
    const stages: string[] = [];
    const out = await runDiff(input(), { createWorker: () => w, onStage: (s) => stages.push(s) });
    expect(out.regions).toHaveLength(1);
    expect(w.posted).toHaveLength(1);
    expect(stages).toEqual(["comparing"]);
    expect(w.terminate).toHaveBeenCalled();
  });

  it("boot failure falls back in-thread without transferring", async () => {
    const w = new FakeWorker("bootfail");
    const inp = input();
    const out = await runDiff(inp, { createWorker: () => w });
    expect(out.regions).toHaveLength(1);
    expect(w.posted).toHaveLength(0);
    expect(w.terminate).toHaveBeenCalled();
  });

  it("boot timeout falls back in-thread", async () => {
    const w = new FakeWorker("silent");
    const out = await runDiff(input(), { createWorker: () => w, bootTimeoutMs: 30 });
    expect(out.regions).toHaveLength(1);
    expect(w.terminate).toHaveBeenCalled();
  });

  it("a throwing factory or null worker runs in-thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await runDiff(input(), { createWorker: () => { throw new Error("x"); } })).regions).toHaveLength(1);
    expect((await runDiff(input(), { createWorker: () => null })).regions).toHaveLength(1);
    warn.mockRestore();
  });

  it("abort during a run terminates the worker", async () => {
    const w = new FakeWorker("hang");
    const ctl = new AbortController();
    const p = runDiff(input(), { createWorker: () => w, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminate).toHaveBeenCalled();
  });

  it("abort during boot terminates the worker", async () => {
    const w = new FakeWorker("silent");
    const ctl = new AbortController();
    const p = runDiff(input(), { createWorker: () => w, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminate).toHaveBeenCalled();
  });
});
