import { describe, expect, it, vi } from "vitest";
import {
  SegmentLabels,
  formatPlanDistance,
  planDistance,
  planDistanceInUnit,
  planMidpoint,
  type MeasureLabelFactory,
  type MeasureMarkHandle,
} from "../../src/level/measureLabels";

function fakeFactory() {
  const created: Array<{ kind: string; text?: string; handle: MeasureMarkHandle & { pos: unknown; txt?: string; disposed: boolean } }> = [];
  const factory: MeasureLabelFactory = {
    create: (_d, kind, position, text) => {
      const handle = {
        pos: position as unknown,
        txt: text,
        disposed: false,
        setText(t: string) { this.txt = t; },
        setPosition(p: unknown) { this.pos = p; },
        dispose() { this.disposed = true; },
      };
      created.push({ kind, text, handle });
      return handle;
    },
  };
  return { factory, created };
}

describe("plan distance helpers", () => {
  it("measures in the XZ plane and formats in the display unit", () => {
    expect(planDistance({ x: 0, y: 5, z: 0 }, { x: 3, y: -9, z: 4 })).toBe(5);
    expect(formatPlanDistance(5)).toBe("5.00 m");
    expect(formatPlanDistance(5, { unit: "cm", localPerMetre: 1 })).toBe("500.0 cm");
    expect(formatPlanDistance(5, { unit: "mm", localPerMetre: 1 })).toBe("5000 mm");
  });
  it("honours model units (local units per metre)", () => {
    // A millimetre-based drawing: 5000 local units = 5 m.
    expect(planDistanceInUnit(5000, { unit: "m", localPerMetre: 1000 })).toBe(5);
    expect(formatPlanDistance(5000, { unit: "m", localPerMetre: 1000 })).toBe("5.00 m");
    // Degenerate scale falls back to 1.
    expect(planDistanceInUnit(2, { unit: "m", localPerMetre: 0 })).toBe(2);
  });
  it("midpoint stays on the drawing plane", () => {
    expect(planMidpoint({ x: 0, y: 3, z: 0 }, { x: 2, y: 9, z: 4 })).toEqual({ x: 1, y: 0, z: 2 });
  });
});

describe("SegmentLabels", () => {
  it("creates a label + two dots, then moves them on update", () => {
    const { factory, created } = fakeFactory();
    const labels = new SegmentLabels();
    labels.factory = factory;
    labels.show("d", "k", { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 });
    expect(created.map((c) => c.kind).sort()).toEqual(["dot", "dot", "label"]);
    expect(created.find((c) => c.kind === "label")!.text).toBe("5.00 m");
    labels.show("d", "k", { x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 8 });
    expect(created).toHaveLength(3); // reused, not recreated
    expect(created.find((c) => c.kind === "label")!.handle.txt).toBe("10.00 m");
  });

  it("a preview without a second point has only the first dot", () => {
    const { factory, created } = fakeFactory();
    const labels = new SegmentLabels();
    labels.factory = factory;
    labels.show("d", "p", { x: 1, y: 0, z: 1 }, null);
    expect(created.map((c) => c.kind)).toEqual(["dot"]);
    labels.show("d", "p", { x: 1, y: 0, z: 1 }, { x: 1, y: 0, z: 3 });
    expect(created.map((c) => c.kind).sort()).toEqual(["dot", "dot", "label"]);
  });

  it("hide / clear dispose every mark; no factory is a no-op", () => {
    const { factory, created } = fakeFactory();
    const labels = new SegmentLabels();
    labels.show("d", "k", { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }); // no factory yet
    expect(labels.size).toBe(0);
    labels.factory = factory;
    labels.show("d", "a", { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    labels.show("d", "b", { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    labels.hide("a");
    expect(created.filter((c) => c.handle.disposed)).toHaveLength(3);
    labels.clear();
    expect(created.every((c) => c.handle.disposed)).toBe(true);
    expect(labels.size).toBe(0);
    vi.fn();
  });
});
