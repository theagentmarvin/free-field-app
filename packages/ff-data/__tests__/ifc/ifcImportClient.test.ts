// __tests__/ifc/ifcImportClient.test.ts
//
// Main-thread client of the IFC import worker (wave 61), with a mock
// Worker that runs the real job runner (runIfcImportJob) "remotely"
// against a mocked converter — so the full request/response protocol
// is exercised without a real Worker or web-ifc.

import { describe, expect, it, vi } from "vitest";

import {
  runIfcImport,
  createIfcImportWorker,
  IfcImportAbortedError,
  type IfcImportWorkerLike,
} from "../../src/ifc/ifcImportClient";
import { computeFullContentHash } from "../../src/db/files/hash";
import {
  runIfcImportJob,
  isIfcImportRequest,
  type ConvertFn,
} from "../../src/ifc/ifcImportProtocol";
import type { IfcImportProgress } from "../../src/ifc/convertIfc";
import type { ParsedIfc } from "../../src/ifc/ifcMetadata";

const PARSED: ParsedIfc = { schema: "IFC4", buildings: [], storeys: [], propertyCatalog: [] };

const convert: ConvertFn = async (bytes, _o, onProgress) => {
  onProgress?.({ stage: "converting", fraction: 0.5, detail: "geometries" });
  return { fragBytes: new Uint8Array([bytes.byteLength]), parsed: PARSED, singlePass: true, convertMs: 1, metadataMs: 0 };
};

type Behaviour = "ok" | "boot-fail" | "crash-after-start" | "convert-error" | "hang" | "messageerror";

class MockWorker implements IfcImportWorkerLike {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  terminated = false;
  received: unknown[] = [];
  constructor(private behaviour: Behaviour, private conv: ConvertFn = convert) {}
  postMessage(msg: unknown): void {
    this.received.push(msg);
    const emitMsg = (data: unknown) => this.onmessage?.({ data } as MessageEvent);
    const emitErr = (message: string) =>
      this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
    queueMicrotask(async () => {
      if (!isIfcImportRequest(msg)) return;
      if (this.behaviour === "boot-fail") return emitErr("Failed to fetch worker chunk");
      // A stray message for another job must be ignored by the client.
      emitMsg({ type: "progress", jobId: msg.jobId + 1000, progress: { stage: "converting", fraction: 0.9 } });
      if (this.behaviour === "hang") {
        emitMsg({ type: "started", jobId: msg.jobId });
        return; // never finishes
      }
      if (this.behaviour === "messageerror") {
        emitMsg({ type: "started", jobId: msg.jobId });
        return this.onmessageerror?.({ data: null } as MessageEvent);
      }
      if (this.behaviour === "crash-after-start") {
        emitMsg({ type: "started", jobId: msg.jobId });
        return emitErr("out of memory");
      }
      const conv: ConvertFn =
        this.behaviour === "convert-error"
          ? async () => {
              throw new Error("Fragments: IFC Schema not found");
            }
          : this.conv;
      await runIfcImportJob(msg, (m) => {
        if (!this.terminated) emitMsg(m);
      }, conv);
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

const file = () => new Blob([new Uint8Array(5)]);

describe("runIfcImport (worker client)", () => {
  it("runs in the worker: posts one import request with the Blob, relays progress, resolves, terminates", async () => {
    const w = new MockWorker("ok");
    const seen: IfcImportProgress[] = [];
    const src = file();
    const out = await runIfcImport(
      src,
      { includeAllAttributesAndRelations: true },
      { createWorker: () => w, onProgress: (p) => seen.push(p), convert: vi.fn() },
    );
    expect(out.ranIn).toBe("worker");
    expect(Array.from(out.fragBytes)).toEqual([5]);
    expect(out.parsed).toEqual(PARSED);
    expect(out.stats.singlePass).toBe(true);
    expect(w.terminated).toBe(true);
    expect(w.onmessage).toBeNull();

    expect(w.received).toHaveLength(1);
    const req = w.received[0] as { type: string; source: unknown; options: unknown };
    expect(req.type).toBe("import");
    expect(req.source).toBe(src); // the Blob handle, not materialised bytes
    expect(req.options).toEqual({ includeAllAttributesAndRelations: true });

    // Stray other-job progress (0.9) filtered out.
    expect(seen.map((p) => p.fraction)).toEqual([0, 0.05, 0.5, 1]);
  });

  it("rejects (no main-thread fallback) when the conversion fails in the worker", async () => {
    const w = new MockWorker("convert-error");
    const fallback = vi.fn(convert);
    await expect(
      runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => w, convert: fallback }),
    ).rejects.toThrow("Fragments: IFC Schema not found");
    expect(fallback).not.toHaveBeenCalled();
    expect(w.terminated).toBe(true);
  });

  it("rejects (no fallback) when the worker crashes after it started", async () => {
    const w = new MockWorker("crash-after-start");
    const fallback = vi.fn(convert);
    await expect(
      runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => w, convert: fallback }),
    ).rejects.toThrow(/crashed: out of memory/);
    expect(fallback).not.toHaveBeenCalled();
    expect(w.terminated).toBe(true);
  });

  it("falls back to the calling thread when the worker fails to boot", async () => {
    const w = new MockWorker("boot-fail");
    const fallback = vi.fn(convert);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await runIfcImport(
      file(),
      { includeAllAttributesAndRelations: false },
      { createWorker: () => w, convert: fallback },
    );
    warn.mockRestore();
    expect(out.ranIn).toBe("main-thread");
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][1]).toEqual({ includeAllAttributesAndRelations: false });
    expect(w.terminated).toBe(true);
  });

  it("runs in-thread when no worker is available (factory returns null / throws)", async () => {
    const fallback = vi.fn(convert);
    const a = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => null, convert: fallback });
    expect(a.ranIn).toBe("main-thread");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, {
      createWorker: () => {
        throw new Error("Worker is not defined");
      },
      convert: fallback,
    });
    warn.mockRestore();
    expect(b.ranIn).toBe("main-thread");
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("main-thread conversion errors reject", async () => {
    await expect(
      runIfcImport(file(), { includeAllAttributesAndRelations: true }, {
        createWorker: () => null,
        convert: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("default factory returns null outside a browser (Node / vitest)", () => {
    expect(createIfcImportWorker()).toBeNull();
  });

  it("returns the full-file SHA-256 of the input", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await runIfcImport(new Blob([bytes]), { includeAllAttributesAndRelations: true }, {
      createWorker: () => new MockWorker("ok"),
    });
    expect(out.contentHash).toBe(await computeFullContentHash(bytes));
    expect(out.stats.hashMs).toBeGreaterThanOrEqual(0);
  });

  it("onContentHash=false stops the worker before a result and rejects 'duplicate'", async () => {
    const w = new MockWorker("ok");
    const seen: string[] = [];
    const err = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, {
      createWorker: () => w,
      onContentHash: (h) => {
        seen.push(h);
        return false;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect(err.reason).toBe("duplicate");
    expect(err.contentHash).toBe(seen[0]);
    expect(w.terminated).toBe(true);
  });

  it("onContentHash=false in-thread skips the conversion entirely", async () => {
    const conv = vi.fn(convert);
    const err = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, {
      createWorker: () => null,
      convert: conv,
      onContentHash: () => false,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect(err.reason).toBe("duplicate");
    expect(conv).not.toHaveBeenCalled();
  });

  it("AbortSignal terminates the worker and rejects 'aborted'", async () => {
    const w = new MockWorker("hang");
    const ctl = new AbortController();
    const p = runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => w, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect(err.reason).toBe("aborted");
    expect(w.terminated).toBe(true);
  });

  it("an already-aborted signal rejects without spawning a worker", async () => {
    const factory = vi.fn(() => new MockWorker("ok"));
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: factory, signal: ctl.signal }),
    ).rejects.toBeInstanceOf(IfcImportAbortedError);
    expect(factory).not.toHaveBeenCalled();
  });

  it("times out: terminates the worker and rejects 'timeout'", async () => {
    const w = new MockWorker("hang");
    const err = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => w, timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect(err.reason).toBe("timeout");
    expect(w.terminated).toBe(true);
  });

  it("times out in-thread too (late result dropped)", async () => {
    const slow = vi.fn(async (b: Uint8Array, o: unknown, p?: (x: IfcImportProgress) => void) => {
      await new Promise((r) => setTimeout(r, 60));
      return convert(b, o as never, p);
    });
    const err = await runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => null, convert: slow, timeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect(err.reason).toBe("timeout");
  });

  it("onmessageerror rejects and terminates", async () => {
    const w = new MockWorker("messageerror");
    await expect(
      runIfcImport(file(), { includeAllAttributesAndRelations: true }, { createWorker: () => w }),
    ).rejects.toThrow(/could not be deserialised/);
    expect(w.terminated).toBe(true);
  });
});
