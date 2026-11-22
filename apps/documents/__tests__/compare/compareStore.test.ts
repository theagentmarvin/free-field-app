import { beforeEach, describe, expect, it } from "vitest";

import type { PdfVersionRecord } from "@ff/types";

import { buildPrefill, useCompareStore } from "../../src/compare/compareStore";
import type { RunCompare } from "../../src/compare/types";
import { makeResult, sideA, sideB } from "./fixtures";

const ver = (n: number): PdfVersionRecord =>
  ({ id: `f1-v${n}`, pdfFileId: "f1", versionNumber: n, pageCount: 2 }) as PdfVersionRecord;

beforeEach(() => useCompareStore.getState().close());

describe("buildPrefill", () => {
  it("uses previous vs open version, page 1", () => {
    const p = buildPrefill([ver(1), ver(2), ver(3)], "f1-v2")!;
    expect(p.base).toEqual({ pdfFileId: "f1", pdfVersionId: "f1-v1", page: 1 });
    expect(p.revision.pdfVersionId).toBe("f1-v2");
  });
  it("defaults to previous vs latest", () => {
    const p = buildPrefill([ver(1), ver(2), ver(3)])!;
    expect(p.base.pdfVersionId).toBe("f1-v2");
    expect(p.revision.pdfVersionId).toBe("f1-v3");
  });
  it("uses the same version when there is only one", () => {
    const p = buildPrefill([ver(1)])!;
    expect(p.base.pdfVersionId).toBe(p.revision.pdfVersionId);
  });
  it("returns null with no versions", () => {
    expect(buildPrefill([])).toBeNull();
  });
});

describe("compareStore", () => {
  it("open prefills and close resets", () => {
    const s = useCompareStore.getState();
    s.open({ base: sideA, revision: sideB });
    expect(useCompareStore.getState()).toMatchObject({ active: true, base: sideA, revision: sideB });
    useCompareStore.getState().close();
    expect(useCompareStore.getState()).toMatchObject({ active: false, base: null, revision: null });
  });

  it("open without prefill keeps an active selection", () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    useCompareStore.getState().open();
    expect(useCompareStore.getState().base).toEqual(sideA);
  });

  it("swaps sides", () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    useCompareStore.getState().swap();
    expect(useCompareStore.getState().base).toEqual(sideB);
    expect(useCompareStore.getState().revision).toEqual(sideA);
  });

  it("steps through regions with wrap-around", () => {
    useCompareStore.setState({ result: makeResult() });
    const st = () => useCompareStore.getState();
    st().nextRegion();
    expect(st().selectedRegionId).toBe(1);
    st().nextRegion();
    st().nextRegion();
    expect(st().selectedRegionId).toBe(3);
    st().nextRegion();
    expect(st().selectedRegionId).toBe(1);
    st().prevRegion();
    expect(st().selectedRegionId).toBe(3);
  });

  it("prev with no selection starts at the last region", () => {
    useCompareStore.setState({ result: makeResult() });
    useCompareStore.getState().prevRegion();
    expect(useCompareStore.getState().selectedRegionId).toBe(3);
  });

  it("toggles reviewed", () => {
    const st = () => useCompareStore.getState();
    st().toggleReviewed(2);
    expect(st().reviewed).toEqual([2]);
    st().toggleReviewed(2);
    expect(st().reviewed).toEqual([]);
  });

  it("a second run aborts the first and only the second result lands", async () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    const signals: AbortSignal[] = [];
    const first = makeResult({ durationMs: 1 });
    const second = makeResult({ durationMs: 2 });
    let n = 0;
    const runner: RunCompare = (_b, _r, _s, opts) => {
      signals.push(opts!.signal!);
      const mine = ++n;
      return new Promise((resolve) => setTimeout(() => resolve(mine === 1 ? first : second), mine === 1 ? 30 : 5));
    };
    const p1 = useCompareStore.getState().run(runner);
    const p2 = useCompareStore.getState().run(runner);
    await Promise.all([p1, p2]);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(useCompareStore.getState().result?.durationMs).toBe(2);
    expect(useCompareStore.getState().status).toBe("done");
  });

  it("maps AbortError to idle and other errors to error", async () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    await useCompareStore.getState().run(async () => {
      throw Object.assign(new Error("x"), { name: "AbortError" });
    });
    expect(useCompareStore.getState().status).toBe("idle");
    await useCompareStore.getState().run(async () => {
      throw new Error("boom");
    });
    expect(useCompareStore.getState()).toMatchObject({ status: "error", error: "boom" });
  });

  it("does not run without both sides", async () => {
    let called = false;
    await useCompareStore.getState().run(async () => {
      called = true;
      return makeResult();
    });
    expect(called).toBe(false);
  });
});
