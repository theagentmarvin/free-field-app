import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

// jsdom's Blob / File implementations are incomplete (no
// arrayBuffer(), limited slice support). Replace them with
// Node's native Blob/File, which are spec-compliant in Node ≥
// 18. The global replacement must happen before any test file
// imports Dexie or pdfjs-dist transitively.
const { Blob: NodeBlob, File: NodeFile } = await import("node:buffer");
if (typeof globalThis.Blob !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Blob = NodeBlob;
}
if (typeof globalThis.File !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).File = NodeFile;
}

// pdfjs-dist (loaded transitively by loadPdf tests) needs
// DOMMatrix / Path2D / ImageData at module init time. jsdom
// doesn't expose them. We polyfill the bare minimum required
// for the import to succeed — the tests don't actually render
// PDFs (the loadPdf code path is only entered when the user
// clicks a row), so the polyfills just need to be no-op
// classes so the module init doesn't throw.
class DOMMatrixShim {}
class Path2DShim {}
if (typeof (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = DOMMatrixShim;
}
if (typeof (globalThis as unknown as { Path2D?: unknown }).Path2D === "undefined") {
  (globalThis as unknown as { Path2D: unknown }).Path2D = Path2DShim;
}

// Task 37 §Step 0: the global mocks below were stale — they
// lived only in apps/settings/__tests__/setup.ts, so @ff/viewer's
// own suite crashed on three.webgpu's `.VERTEX` read and on the
// missing `EdgeProjector` OBC export. Both blocks are copied
// verbatim from the settings setup file (single source of truth
// for the stub shape) so the two suites agree.
//
// three.webgpu.js crashes in jsdom with
// `Cannot read properties of undefined (reading 'VERTEX')`.
// The real three.js API isn't exercised by these unit tests
// (they assert classes/methods, not rendering), so a no-op stub
// is enough to let the module load.
import { vi } from "vitest";

vi.mock("three", () => {
  return {
    default: {},
    // Types used in viewer type annotations
    PerspectiveCamera: class {},
    Vector3: class {},
    Mesh: class {},
    Group: class {},
    Object3D: class {},
    Scene: class {},
    WebGLRenderer: class {},
    Color: class {},
    Material: class {},
    MeshBasicMaterial: class {},
    MeshStandardMaterial: class {},
    BufferGeometry: class {},
    PlaneGeometry: class {},
    Box3: class {},
    Vector2: class {},
    Matrix4: class {},
    Raycaster: class {},
    Line3: class {},
    Plane: class {},
    Spherical: class {},
    Euler: class {},
    Quaternion: class {},
    Frustum: class {},
    BoxGeometry: class {},
    // Static constants that three.js defines at module scope
    REVISION: "mock",
    // Math utilities
    MathUtils: {
      radToDeg: (r: number) => (r * 180) / Math.PI,
      degToRad: (d: number) => (d * Math.PI) / 180,
    },
    // Common constants
    NoBlending: 0,
    NormalBlending: 1,
    AdditiveBlending: 2,
    SubtractiveBlending: 3,
    MultiplyBlending: 4,
    CustomBlending: 5,
    CullFaceNone: 0,
    CullFaceBack: 1,
    CullFaceFront: 2,
    DoubleSide: 2,
    FrontSide: 0,
    BackSide: 1,
    LinearFilter: 1006,
    NearestFilter: 1008,
    RGBAFormat: 1023,
    UnsignedByteType: 1009,
    FloatType: 1010,
    ClampToEdgeWrapping: 1001,
    RepeatWrapping: 1000,
    MirroredRepeatWrapping: 1002,
    AlwaysDepth: 1,
    LessEqualDepth: 3,
    GreaterDepth: 5,
    SRGBColorSpace: "srgb",
    LinearSRGBColorSpace: "srgb-linear",
    NoColorSpace: "",
    DisplayP3ColorSpace: "display-p3",
  };
});

vi.mock("@thatopen/components", () => {
  const NoopClass: unknown = class {};
  const Noop: unknown = () => ({});
  // Exhaustive list of OBC exports referenced by @ff/viewer.
  // If a new OBC export is added there, this list needs to grow
  // or the test suite will fail with "No <X> export is defined on
  // the @thatopen/components mock".
  return {
    // Core
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
    // Camera / renderer / scene
    SimpleScene: NoopClass,
    SimpleRenderer: NoopClass,
    SimpleCamera: NoopClass,
    OrthoPerspectiveCamera: NoopClass,
    PostproductionRenderer: NoopClass,
    // TechnicalDrawings (Task 16 / 18)
    TechnicalDrawings: NoopClass,
    TechnicalDrawing: NoopClass,
    EdgeProjector: NoopClass,
    AnnotationSystem: NoopClass,
    BaseAnnotationStyle: NoopClass,
    DrawingSystemDescriptor: NoopClass,
  };
});
