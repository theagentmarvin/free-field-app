import { describe, expect, it, vi } from "vitest";
import {
  MeasurementBook,
  boundsOfPoints,
  focusBoundsAsync,
  labelElementsOf,
  type BookSource,
} from "../../src/measure/measureBook";

const line = (id: string, value: number, s = { x: 0, y: 0, z: 0 }, e = { x: 3, y: 4, z: 0 }) => ({
  id,
  value,
  start: s,
  end: e,
});

function sources(parts: Partial<Record<"length" | "area" | "angle" | "volume", { list: unknown[]; units?: string }>>): BookSource[] {
  return Object.entries(parts).map(([variant, c]) => ({
    variant: variant as BookSource["variant"],
    component: { list: c!.list, units: c!.units },
  }));
}

describe("MeasurementBook.snapshot", () => {
  it("orders entries by creation across variants and numbers per variant", () => {
    const book = new MeasurementBook();
    const l1 = line("l1", 5);
    const a1 = { id: "a1", value: 12.5, points: [] };
    const lengthList: unknown[] = [l1];
    const areaList: unknown[] = [a1];
    let snap = book.snapshot(sources({ length: { list: lengthList }, area: { list: areaList, units: "m2" } }));
    expect(snap.map((e) => e.label)).toEqual(["Length 1", "Area 1"]);
    const l2 = line("l2", 7.123);
    lengthList.push(l2);
    snap = book.snapshot(sources({ length: { list: lengthList }, area: { list: areaList, units: "m2" } }));
    expect(snap.map((e) => `${e.id}:${e.text}`)).toEqual(["l1:5.00 m", "a1:12.50 m²", "l2:7.12 m"]);
    expect(snap[2].label).toBe("Length 2");
  });

  it("keeps ordinals stable when an earlier item is deleted", () => {
    const book = new MeasurementBook();
    const items = [line("a", 1), line("b", 2)];
    book.snapshot(sources({ length: { list: items } }));
    items.shift();
    const snap = book.snapshot(sources({ length: { list: items } }));
    expect(snap).toHaveLength(1);
    expect(snap[0].label).toBe("Length 2");
  });

  it("falls back to a generated id when the item has none", () => {
    const book = new MeasurementBook();
    const snap = book.snapshot(sources({ angle: { list: [{ value: 90 }], units: "deg" } }));
    expect(snap[0].id).toMatch(/^angle-\d+$/);
    expect(snap[0].text).toBe("90.0°");
  });

  it("resolves async volume values once and notifies", async () => {
    const book = new MeasurementBook();
    const getValue = vi.fn(async () => 2.5);
    const onResolved = vi.fn();
    book.onValueResolved = onResolved;
    const vol = { id: "v1", getValue };
    let snap = book.snapshot(sources({ volume: { list: [vol], units: "m3" } }));
    expect(snap[0]).toMatchObject({ value: null, text: "…" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onResolved).toHaveBeenCalledTimes(1);
    snap = book.snapshot(sources({ volume: { list: [vol], units: "m3" } }));
    expect(snap[0]).toMatchObject({ value: 2.5, text: "2.50 m³" });
    expect(getValue).toHaveBeenCalledTimes(1);
  });

  it("find() returns the source + item for an id", () => {
    const book = new MeasurementBook();
    const l1 = line("l1", 5);
    const src = sources({ length: { list: [l1] } });
    book.snapshot(src);
    expect(book.find(src, "l1")?.item).toBe(l1);
    expect(book.find(src, "nope")).toBeNull();
  });
});

describe("focus bounds", () => {
  it("boundsOfPoints centres and sizes, with a minimum radius", () => {
    const b = boundsOfPoints([{ x: 0, y: 0, z: 0 }, { x: 6, y: 8, z: 0 }])!;
    expect(b.center).toEqual({ x: 3, y: 4, z: 0 });
    expect(b.radius).toBeCloseTo(5);
    expect(boundsOfPoints([{ x: 1, y: 1, z: 1 }])!.radius).toBe(0.25);
    expect(boundsOfPoints([])).toBeNull();
  });
  it("focusBoundsAsync per variant", async () => {
    expect((await focusBoundsAsync("length", line("l", 1)))!.center.x).toBe(1.5);
    expect(
      (await focusBoundsAsync("angle", { start: { x: 0, y: 0, z: 0 }, vertex: { x: 2, y: 0, z: 0 }, end: { x: 2, y: 2, z: 0 } }))!.center,
    ).toEqual({ x: 1, y: 1, z: 0 });
    expect(
      (await focusBoundsAsync("volume", { getBox: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }) }))!.center,
    ).toEqual({ x: 1, y: 1, z: 1 });
    expect(await focusBoundsAsync("volume", { getBox: async () => { throw new Error("x"); } })).toBeNull();
  });
});

describe("labelElementsOf", () => {
  it("finds the label element of the visual built from an item", () => {
    const el = { classList: {} } as unknown as HTMLElement;
    const item = {};
    const other = {};
    const comp = {
      lines: [
        { line: other, label: { three: { element: {} as HTMLElement } } },
        { line: item, label: { three: { element: el } } },
      ],
    };
    expect(labelElementsOf("length", comp, item)).toEqual([el]);
    const angleComp = { _visuals: new Map([[item, { label: { three: { element: el } } }]]) };
    expect(labelElementsOf("angle", angleComp, item)).toEqual([el]);
    expect(labelElementsOf("area", {}, item)).toEqual([]);
  });
});
