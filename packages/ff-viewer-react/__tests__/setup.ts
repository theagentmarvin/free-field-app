import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

const { Blob: NodeBlob, File: NodeFile } = await import("node:buffer");
if (typeof globalThis.Blob !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Blob = NodeBlob;
}
if (typeof globalThis.File !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).File = NodeFile;
}

class DOMMatrixShim {}
class Path2DShim {}
if (typeof (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = DOMMatrixShim;
}
if (typeof (globalThis as unknown as { Path2D?: unknown }).Path2D === "undefined") {
  (globalThis as unknown as { Path2D: unknown }).Path2D = Path2DShim;
}

// Task 20 §1.8: when OBC is imported transitively (e.g. via the
// IfcViewer test pulling the real component), three.webgpu.js
// crashes in jsdom with `Cannot read properties of undefined
// (reading 'VERTEX')`. The real OBC factory functions don't matter
// to component tests (which mock the IfcViewer itself), so we stub
// the @thatopen/components namespace with no-op classes. Tests
// that DO exercise OBC behavior (the IfcViewer test in this dir)
// override this via `vi.mock("@thatopen/components", ...)` inside
// the test file — vi.mock calls inside the test file win over this
// global one for that file.
// Task 21: also stub @thatopen/components-front for the same
// reason — the Highlighter class transitively pulls three.
import { vi } from "vitest";
vi.mock("@thatopen/components", () => {
  const NoopClass: unknown = class {};
  const Noop: unknown = () => ({});
  return {
    Components: NoopClass,
    Worlds: { create: Noop },
    World: NoopClass,
    Views: NoopClass,
    FragmentsManager: NoopClass,
    FragmentsModels: NoopClass,
    Classifier: NoopClass,
    Hider: NoopClass,
    Highlighter: NoopClass,
    Raycasters: NoopClass,
    BoundingBoxer: NoopClass,
    MouseNavigation: NoopClass,
    CameraProjection: NoopClass,
    Event: NoopClass,
    ModelIdMap: NoopClass,
    NavModeID: NoopClass,
    SimpleScene: NoopClass,
    SimpleRenderer: NoopClass,
    SimpleCamera: NoopClass,
    OrthoPerspectiveCamera: NoopClass,
    PostproductionRenderer: NoopClass,
    TechnicalDrawings: NoopClass,
    TechnicalDrawing: NoopClass,
    EdgeProjector: NoopClass,
    // Wave 12: shared SnapResolver (3D measurement snap tolerance).
    SnapResolvers: NoopClass,
    SnapResolver: NoopClass,
    SnapClass: { POINT: 0, LINE: 1, FACE: 2 },
  };
});
vi.mock("@thatopen/components-front", () => {
  const NoopClass: unknown = class {};
  return {
    Highlighter: NoopClass,
    Hoverer: NoopClass,
    Measurement: NoopClass,
    RendererWith2D: NoopClass,
    MeasurementLineType: { Basic: "basic", Fat: "fat" },
    // Wave 12: the four 3D measurement components. Referenced at
    // IfcViewer.tsx module scope (`MEASURE_COMPONENT_CLASSES`), so
    // they must exist in every components-front mock that loads the
    // viewer module (including this global setup).
    LengthMeasurement: NoopClass,
    AreaMeasurement: NoopClass,
    AngleMeasurement: NoopClass,
    VolumeMeasurement: NoopClass,
  };
});
// Wave 33: IfcViewer.tsx imports `LodMode` from @thatopen/fragments at
// module scope (force full geometry per model so thin MEP elements carry
// a per-vertex id). The real fragments bundle transitively pulls three +
// worker machinery that is irrelevant to component tests and risks the
// same jsdom crash the @thatopen/components stub above prevents. Stub the
// value import here; the IfcViewer test asserts against these same numeric
// values by importing `LodMode` from the (now stubbed) module.
vi.mock("@thatopen/fragments", () => ({
  LodMode: { DEFAULT: 0, ALL_VISIBLE: 1, ALL_GEOMETRY: 2 },
}));
