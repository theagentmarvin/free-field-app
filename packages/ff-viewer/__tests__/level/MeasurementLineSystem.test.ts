// __tests__/viewer/level/MeasurementLineSystem.test.ts
//
// Pure-function tests for the measurement line state machine.
// Doesn't exercise the OBC-dependent class — only the reducer —
// but importing the module still triggers the @thatopen/components
// side-effect (which transitively imports three.webgpu and explodes
// in jsdom). We stub OBC with `vi.mock` so the import path is
// safe, then re-import just the pure parts we want to test.

import { describe, expect, it, vi } from "vitest";

vi.mock("@thatopen/components", () => ({
  // Minimal OBC surface used by MeasurementLineSystem's top-level
  // type imports and the Event generic. The class itself
  // (AnnotationSystem) is NOT used in these tests because we only
  // exercise the pure reducer.
  Event: class {
    trigger() {
      return undefined;
    }
    add() {
      return undefined;
    }
    reset() {
      return undefined;
    }
  },
  BaseAnnotationStyle: class {},
  DrawingSystemDescriptor: class {},
  TechnicalDrawing: class {},
  // Task 37 §Step 0: this file-level mock overrides the global
  // one in __tests__/setup.ts, and `src/level/LevelPlanController.ts`
  // touches `OBC.EdgeProjector` at module scope (the idempotent
  // prototype patch). Without this export the import of
  // `@ff/viewer` throws before any test runs.
  EdgeProjector: class {},
  ThreeVector3: class {},
  ThreeLine3: class {},
  ThreeBufferGeometry: class {},
  ThreeBufferAttribute: class {},
  ThreeGroup: class {},
  ThreeLineSegments: class {},
  AnnotationSystem: class {},
}));

import {
  measureLineMachine,
  type MeasureLineState,
} from "@ff/viewer";

const initial: MeasureLineState = { kind: "awaitingFirstPoint", cursor: null };

describe("measureLineMachine", () => {
  it("starts in awaitingFirstPoint", () => {
    expect(initial.kind).toBe("awaitingFirstPoint");
  });

  it("MOUSE_MOVE in state 1 updates the cursor", () => {
    const next = measureLineMachine(initial, {
      type: "MOUSE_MOVE",
      point: { x: 1, y: 0, z: 2 },
    });
    expect(next.kind).toBe("awaitingFirstPoint");
    if (next.kind === "awaitingFirstPoint") {
      expect(next.cursor).toEqual({ x: 1, y: 0, z: 2 });
    }
  });

  it("CLICK with no line in state 1 is a no-op", () => {
    const next = measureLineMachine(initial, {
      type: "CLICK",
      point: { x: 1, y: 0, z: 2 },
      line: null,
    });
    expect(next).toBe(initial);
  });

  it("CLICK with a line in state 1 transitions to awaitingSecondPoint and snaps to the line", () => {
    const line = {
      start: { x: 0, y: 0, z: 0 },
      end: { x: 10, y: 0, z: 0 },
    };
    const next = measureLineMachine(initial, {
      type: "CLICK",
      point: { x: 5, y: 0, z: 3 },
      line,
    });
    expect(next.kind).toBe("awaitingSecondPoint");
    if (next.kind === "awaitingSecondPoint") {
      expect(next.pointA).toEqual({ x: 5, y: 0, z: 0 });
    }
  });

  it("CLICK in state 2 with a line commits and returns to state 1 via `committed`", () => {
    const state2: MeasureLineState = {
      kind: "awaitingSecondPoint",
      pointA: { x: 0, y: 0, z: 0 },
      cursor: null,
    };
    const line = {
      start: { x: 0, y: 0, z: 5 },
      end: { x: 10, y: 0, z: 5 },
    };
    const next = measureLineMachine(state2, {
      type: "CLICK",
      point: { x: 7, y: 0, z: 8 },
      line,
    });
    expect(next.kind).toBe("committed");
    if (next.kind === "committed") {
      expect(next.line.pointA).toEqual({ x: 0, y: 0, z: 0 });
      expect(next.line.pointB).toEqual({ x: 7, y: 0, z: 5 });
      expect(next.line.style).toBe(""); // stamped by the component
      expect(next.line.uuid).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("CLICK in state 2 with no line stays in state 2 (no half-commit)", () => {
    const state2: MeasureLineState = {
      kind: "awaitingSecondPoint",
      pointA: { x: 0, y: 0, z: 0 },
      cursor: null,
    };
    const next = measureLineMachine(state2, {
      type: "CLICK",
      point: { x: 1, y: 0, z: 1 },
      line: null,
    });
    expect(next).toBe(state2);
  });

  it("MOUSE_MOVE in state 2 updates the cursor but keeps pointA", () => {
    const state2: MeasureLineState = {
      kind: "awaitingSecondPoint",
      pointA: { x: 1, y: 0, z: 1 },
      cursor: null,
    };
    const next = measureLineMachine(state2, {
      type: "MOUSE_MOVE",
      point: { x: 4, y: 0, z: 5 },
    });
    expect(next.kind).toBe("awaitingSecondPoint");
    if (next.kind === "awaitingSecondPoint") {
      expect(next.pointA).toEqual({ x: 1, y: 0, z: 1 });
      expect(next.cursor).toEqual({ x: 4, y: 0, z: 5 });
    }
  });

  it("ESCAPE in state 1 is a no-op (no half-state to cancel)", () => {
    const next = measureLineMachine(initial, { type: "ESCAPE" });
    expect(next).toBe(initial);
  });

  it("ESCAPE in state 2 returns to state 1 with no cursor", () => {
    const state2: MeasureLineState = {
      kind: "awaitingSecondPoint",
      pointA: { x: 1, y: 0, z: 1 },
      cursor: { x: 2, y: 0, z: 2 },
    };
    const next = measureLineMachine(state2, { type: "ESCAPE" });
    expect(next.kind).toBe("awaitingFirstPoint");
    if (next.kind === "awaitingFirstPoint") {
      expect(next.cursor).toBeNull();
    }
  });

  it("snaps clicks at the segment endpoints (clamping)", () => {
    const line = {
      start: { x: 0, y: 0, z: 0 },
      end: { x: 1, y: 0, z: 0 },
    };
    // Click way past the end of the segment: should clamp to end.
    const next = measureLineMachine(initial, {
      type: "CLICK",
      point: { x: 50, y: 0, z: 0 },
      line,
    });
    expect(next.kind).toBe("awaitingSecondPoint");
    if (next.kind === "awaitingSecondPoint") {
      expect(next.pointA).toEqual({ x: 1, y: 0, z: 0 });
    }
  });

  it("snaps clicks before the segment start (clamping)", () => {
    const line = {
      start: { x: 5, y: 0, z: 5 },
      end: { x: 10, y: 0, z: 5 },
    };
    const next = measureLineMachine(initial, {
      type: "CLICK",
      point: { x: -100, y: 0, z: 0 },
      line,
    });
    expect(next.kind).toBe("awaitingSecondPoint");
    if (next.kind === "awaitingSecondPoint") {
      expect(next.pointA).toEqual({ x: 5, y: 0, z: 5 });
    }
  });
});
