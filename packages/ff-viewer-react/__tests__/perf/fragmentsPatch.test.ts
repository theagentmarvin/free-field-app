// Wave 61 — guards for the local @thatopen/fragments patch
// (patches/@thatopen__fragments@3.6.0.patch, wired in pnpm-workspace.yaml
// `patchedDependencies`).
//
//   1. The patch is actually applied to the installed engine (an engine
//      upgrade without re-basing the patch silently loses the speedup).
//   2. The worker tile-build speedups are BIT-IDENTICAL to the original
//      three.js code paths they replace (face-id colour table, inlined
//      vertex / normal transform) — checked against three's own Color /
//      Vector3 on many inputs, with the exact expressions of the patch.
//   3. Byte-weighted worker balancing: a new model goes to the worker
//      holding the least model data.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports
import { Color, Matrix4, Quaternion, Vector3 } from "three";

const require_ = createRequire(import.meta.url);
const fragsDist = path.dirname(require_.resolve("@thatopen/fragments"));
const workerSrc = fs.readFileSync(path.join(fragsDist, "Worker", "worker.mjs"), "utf8");
const threadsDataPath = path.join(fragsDist, "FragmentsModels", "src", "multithreading", "threads-data.mjs");

describe("fragments patch is applied", () => {
  it("worker carries the tile-build speedups", () => {
    expect(workerSrc).toContain("static faceIdChannelLut()");
    expect(workerSrc).toContain("FreeField patch (perf): the Vector3 fromArray");
  });
  it("main-thread pool balances by model bytes", () => {
    expect(fs.readFileSync(threadsDataPath, "utf8")).toContain("addModelBytes(thread, input)");
  });
});

/** The patch's table: per channel byte, the value `Color.setHex` produces. */
function buildLut(): Float64Array {
  const c = new Color();
  const lut = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    c.setHex(v);
    lut[v] = c.b;
  }
  return lut;
}

describe("face-id colour table", () => {
  it("matches Color.set(id) bit for bit after the Float32 store", () => {
    const lut = buildLut();
    const c = new Color();
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    let rng = 12345;
    const ids: number[] = [0, 1, 255, 256, 65535, 65536, 2 ** 24 - 1, 2 ** 24, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1];
    for (let k = 0; k < 20000; k++) {
      rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
      ids.push(rng);
      ids.push(k * 100 + (k % 97)); // faceId + sample * 100 shape
    }
    for (const id of ids) {
      c.set(0 + id);
      a[0] = c.r;
      a[1] = c.g;
      a[2] = c.b;
      const hex = Math.floor(0 + id);
      b[0] = lut[(hex >> 16) & 255];
      b[1] = lut[(hex >> 8) & 255];
      b[2] = lut[hex & 255];
      expect([b[0], b[1], b[2]]).toEqual([a[0], a[1], a[2]]);
    }
  });
});

describe("inlined vertex transform", () => {
  it("matches Vector3 applyMatrix4 / transformDirection + scale bit for bit", () => {
    const N = 2 ** 15 - 1; // the worker's normalizationValue
    const m = new Matrix4().compose(
      new Vector3(1234.5, -67.8, 9.1),
      new Quaternion(0.1, 0.7, -0.3, 0.6).normalize(),
      new Vector3(1, 1.5, 0.75),
    );
    const e = m.elements;
    const v = new Vector3();
    const pa = new Float32Array(3);
    const pb = new Float32Array(3);
    const na = new Int16Array(3);
    const nb = new Int16Array(3);
    let rng = 777;
    const rnd = (): number => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 2 ** 32 - 0.5;
    };
    for (let k = 0; k < 20000; k++) {
      const src = Float32Array.of(rnd() * 200, rnd() * 200, rnd() * 200);
      v.fromArray(src, 0).applyMatrix4(m).toArray(pa, 0);
      {
        const x = src[0]!, y = src[1]!, z = src[2]!;
        const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
        pb[0] = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w;
        pb[1] = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w;
        pb[2] = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w;
      }
      expect(Array.from(pb)).toEqual(Array.from(pa));

      const srcN = k % 500 === 0 ? new Int16Array(3) : Int16Array.of(rnd() * 65000, rnd() * 65000, rnd() * 65000);
      v.fromArray(srcN, 0).transformDirection(m).multiplyScalar(N).toArray(na, 0);
      {
        const x = srcN[0]!, y = srcN[1]!, z = srcN[2]!;
        let nx = e[0]! * x + e[4]! * y + e[8]! * z;
        let ny = e[1]! * x + e[5]! * y + e[9]! * z;
        let nz = e[2]! * x + e[6]! * y + e[10]! * z;
        const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        nb[0] = nx * N;
        nb[1] = ny * N;
        nb[2] = nz * N;
      }
      expect(Array.from(nb)).toEqual(Array.from(na));
    }
  });
});

describe("byte-weighted worker balancing", () => {
  it("routes a new model to the worker holding the least model data", async () => {
    const { ThreadsData } = (await import(pathToFileURL(threadsDataPath).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ThreadsData: any;
    };
    const data = new ThreadsData("worker.mjs");
    const workers = ["w1", "w2", "w3"].map((name) => ({ name }));
    const load = (modelId: string, mb: number) => ({ modelId, modelData: new ArrayBuffer(mb * 1024) });
    // First three models each get a fresh worker (what newThread() does).
    const initial: Array<[string, number]> = [["MECH", 29], ["ARQ", 3], ["STRUCT", 5]];
    initial.forEach(([id, mb], i) => {
      const w = workers[i];
      data.setPort(w, { w });
      data.setAmount(w, 1);
      data.setThreadGroup(w, undefined);
      data.set(id, w);
      data.addModelBytes(w, load(id, mb));
    });
    // The big model goes to the lightest worker (ARQ's), not the first
    // one-model worker (MECH's) as count-only balancing did.
    expect(data.balanceThreadLoad(load("ARCH", 85), undefined)).toEqual({ w: workers[1] });
    expect(data.getThread("ARCH")).toBe(workers[1]);
    // Next one: STRUCT's worker (5) is now lighter than MECH (29) and ARQ+ARCH (88).
    data.balanceThreadLoad(load("X", 1), undefined);
    expect(data.getThread("X")).toBe(workers[2]);
    // Disposing frees the bytes: after ARCH leaves, its worker is lightest again.
    data.deleteModel("ARCH");
    data.balanceThreadLoad(load("Y", 1), undefined);
    expect(data.getThread("Y")).toBe(workers[1]);
  });

  it("falls back to model count when sizes are unknown", async () => {
    const { ThreadsData } = (await import(pathToFileURL(threadsDataPath).href)) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ThreadsData: any;
    };
    const data = new ThreadsData("worker.mjs");
    const [a, b] = [{ n: "a" }, { n: "b" }];
    for (const [w, amount] of [[a, 2], [b, 1]] as const) {
      data.setPort(w, { w });
      data.setAmount(w, amount);
      data.setThreadGroup(w, undefined);
    }
    data.balanceThreadLoad({ modelId: "Z" }, undefined);
    expect(data.getThread("Z")).toBe(b);
  });
});
