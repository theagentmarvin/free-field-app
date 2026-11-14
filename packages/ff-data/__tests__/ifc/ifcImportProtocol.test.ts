// __tests__/ifc/ifcImportProtocol.test.ts
//
// The IFC import worker message protocol (wave 61): the job runner
// shared by the worker and the in-thread fallback. Converter mocked —
// the real single-pass conversion is covered by convertIfc.test.ts.

import { describe, expect, it, vi } from "vitest";

import {
  isIfcImportRequest,
  runIfcImportJob,
  throttleProgress,
  type ConvertFn,
  type IfcImportResponse,
} from "../../src/ifc/ifcImportProtocol";
import type { ParsedIfc } from "../../src/ifc/ifcMetadata";

const PARSED: ParsedIfc = {
  schema: "IFC4",
  buildings: [{ expressId: 1, name: "B", guid: "g-b" }],
  storeys: [
    { expressId: 2, name: "L1", elevation: 0, height: null, guid: "g-1", containedElementIds: [5, 6] },
  ],
  propertyCatalog: [{ fileId: "pending", pset: "Pset_WallCommon", name: "IsExternal" }],
};

function collect() {
  const msgs: { msg: IfcImportResponse; transfer?: Transferable[] }[] = [];
  return {
    msgs,
    post: (msg: IfcImportResponse, transfer?: Transferable[]) => msgs.push({ msg, transfer }),
  };
}

const okConvert: ConvertFn = async (bytes, _opts, onProgress) => {
  onProgress?.({ stage: "converting", fraction: 0.5, detail: "geometries" });
  onProgress?.({ stage: "converting", fraction: 0.501, detail: "geometries" }); // same % -> throttled
  onProgress?.({ stage: "converting", fraction: 0.8, detail: "attributes" });
  return {
    fragBytes: new Uint8Array([bytes.byteLength, 1, 2, 3]),
    parsed: PARSED,
    singlePass: true,
    convertMs: 12,
    metadataMs: 3,
  };
};

describe("isIfcImportRequest", () => {
  it("accepts a well-formed request and rejects junk", () => {
    expect(
      isIfcImportRequest({ type: "import", jobId: 1, source: new Blob([]), options: { includeAllAttributesAndRelations: true } }),
    ).toBe(true);
    expect(isIfcImportRequest(null)).toBe(false);
    expect(isIfcImportRequest({ type: "import", jobId: "1", source: new Blob([]), options: {} })).toBe(false);
    expect(isIfcImportRequest({ type: "import", jobId: 1, options: {} })).toBe(false);
    expect(isIfcImportRequest({ type: "other", jobId: 1, source: new Blob([]), options: {} })).toBe(false);
  });
});

describe("throttleProgress", () => {
  it("forwards only on stage change or whole-percent change", () => {
    const sink = vi.fn();
    const t = throttleProgress(sink);
    t({ stage: "converting", fraction: 0.1 });
    t({ stage: "converting", fraction: 0.104 });
    t({ stage: "converting", fraction: 0.11 });
    t({ stage: "done", fraction: 0.11 });
    expect(sink.mock.calls.map((c) => [c[0].stage, c[0].fraction])).toEqual([
      ["converting", 0.1],
      ["converting", 0.11],
      ["done", 0.11],
    ]);
  });
});

describe("runIfcImportJob", () => {
  it("reads a Blob source, converts once and posts started -> progress -> done (frag buffer transferred)", async () => {
    const { msgs, post } = collect();
    const convert = vi.fn(okConvert);
    const blob = new Blob([new Uint8Array(7)]);
    await runIfcImportJob(
      { type: "import", jobId: 42, source: blob, options: { includeAllAttributesAndRelations: true } },
      post,
      convert,
    );

    expect(convert).toHaveBeenCalledTimes(1);
    const [bytes, opts] = convert.mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(7);
    expect(opts).toEqual({ includeAllAttributesAndRelations: true });

    expect(msgs.every((m) => m.msg.jobId === 42)).toBe(true);
    const types = msgs.map((m) => m.msg.type);
    expect(types[0]).toBe("started");
    expect(types[types.length - 1]).toBe("done");
    expect(types.filter((t) => t === "error")).toHaveLength(0);

    const progress = msgs
      .filter((m) => m.msg.type === "progress")
      .map((m) => (m.msg as Extract<IfcImportResponse, { type: "progress" }>).progress);
    expect(progress[0]).toEqual({ stage: "reading", fraction: 0 });
    expect(progress.map((p) => p.fraction)).toEqual([0, 0.05, 0.5, 0.8, 1]); // 0.501 throttled
    expect(progress[progress.length - 1].stage).toBe("done");
    // Monotonic.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction);
    }

    const done = msgs[msgs.length - 1];
    const d = done.msg as Extract<IfcImportResponse, { type: "done" }>;
    expect(Array.from(d.fragBytes)).toEqual([7, 1, 2, 3]);
    expect(d.parsed).toBe(PARSED);
    expect(d.stats).toMatchObject({ ifcBytes: 7, convertMs: 12, metadataMs: 3, singlePass: true });
    expect(d.stats.readMs).toBeGreaterThanOrEqual(0);
    expect(done.transfer).toEqual([d.fragBytes.buffer]);
  });

  it("accepts an ArrayBuffer source as-is", async () => {
    const { msgs, post } = collect();
    const convert = vi.fn(okConvert);
    const buf = new Uint8Array([9, 9, 9]).buffer;
    await runIfcImportJob(
      { type: "import", jobId: 1, source: buf, options: { includeAllAttributesAndRelations: false } },
      post,
      convert,
    );
    expect(convert.mock.calls[0][0].buffer).toBe(buf);
    expect(msgs[msgs.length - 1].msg.type).toBe("done");
  });

  it("posts an error message (never throws) when conversion fails", async () => {
    const { msgs, post } = collect();
    await expect(
      runIfcImportJob(
        { type: "import", jobId: 7, source: new Blob([]), options: { includeAllAttributesAndRelations: true } },
        post,
        async () => {
          throw new Error("bad IFC");
        },
      ),
    ).resolves.toBeUndefined();
    const last = msgs[msgs.length - 1].msg;
    expect(last).toMatchObject({ type: "error", jobId: 7, message: "bad IFC" });
    expect(msgs.some((m) => m.msg.type === "done")).toBe(false);
  });
});
