// apps/models/__tests__/__mocks__/obc-stub.ts
//
// Lightweight stub for @thatopen/components and
// @thatopen/components-front, aliased in vite.config.ts (test.alias).
//
// Why an alias instead of `vi.mock`: the @thatopen packages are NOT
// dependencies of @free-field/models — they live in @ff/viewer-react's
// node_modules. A `vi.mock("@thatopen/components")` registered from a
// models test can't resolve the id, so it never intercepts the import
// that IfcViewer.tsx (loaded cross-package via the `@ff/viewer-react`
// alias) actually makes.
//
// The @thatopen namespace is the sole importer of `three/webgpu`
// (whose module load crashes in jsdom with "reading 'VERTEX'").
// Stubbing it cuts that chain entirely.
//
// Why a Proxy rather than a fixed key list: modules in the barrel
// chain (@ff/viewer-react → @ff/viewer) both `extends OBC.<X>` and
// reference `OBC.<Y>` at module scope. Enumerating every symbol is
// brittle. The Proxy returns a no-op **class** for any accessed name,
// so `class Foo extends OBC.AnnotationSystem {}` and
// `new OBC.Components()` and `OBC.SomeConst` all resolve to a
// harmless value at module-load. None of the models tests exercise
// real OBC behavior, so the no-op surface is sufficient.

const NoopClass = class {};

const handler: ProxyHandler<Record<string, unknown>> = {
  get(target, prop) {
    if (prop === "__esModule") return true;
    if (prop === "default") return proxy;
    // Every named access resolves to a no-op class. Classes are
    // callable both as `new X()` and as an `extends X` base.
    if (!(prop in target)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (target as any)[prop] = NoopClass;
    }
    return target[prop as string];
  },
};

const proxy: Record<string, unknown> = new Proxy({}, handler);

// Re-export the proxy as the module namespace. `import * as OBC` and
// `import { Foo } from ...` both read through these traps.
export default proxy;
export const {
  Components,
  Worlds,
  World,
  Views,
  FragmentsManager,
  FragmentsModels,
  Classifier,
  Hider,
  Highlighter,
  Hoverer,
  Raycasters,
  BoundingBoxer,
  MouseNavigation,
  CameraProjection,
  Event,
  ModelIdMap,
  NavModeID,
  SimpleScene,
  SimpleRenderer,
  SimpleCamera,
  OrthoPerspectiveCamera,
  PostproductionRenderer,
  TechnicalDrawings,
  TechnicalDrawing,
  EdgeProjector,
  AnnotationSystem,
  BaseAnnotationStyle,
  DrawingSystemDescriptor,
} = proxy as Record<string, unknown>;
