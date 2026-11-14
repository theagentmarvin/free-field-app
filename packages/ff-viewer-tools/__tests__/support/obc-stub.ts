// packages/ff-viewer-tools/__tests__/support/obc-stub.ts
//
// Lightweight stub for @thatopen/components and
// @thatopen/components-front, aliased in vitest.config.ts.
//
// Why an alias instead of `vi.mock`: the @thatopen packages are NOT
// dependencies of @ff/viewer-tools — they live in @ff/viewer-react's
// (and @ff/viewer's) node_modules. A `vi.mock("@thatopen/components")`
// registered from a ff-viewer-tools test can't resolve the id, so it
// never intercepts the import that IfcViewer.tsx (loaded cross-package
// via the `@ff/viewer-react` alias) actually makes. A resolve.alias
// short-circuits the specifier before resolution, regardless of which
// package's node_modules holds the real module.
//
// The @thatopen namespace is the sole importer of `three/webgpu`
// (whose module-load crashes in jsdom with "reading 'VERTEX'").
// Stubbing it cuts that chain entirely.
//
// Why a Proxy rather than a fixed key list: modules in the barrel
// chain (@ff/viewer-react → @ff/viewer) both `extends OBC.<X>` and
// reference `OBC.<Y>` at module scope. Enumerating every symbol is
// brittle. The Proxy returns a no-op **class** for any accessed name,
// so `class Foo extends OBC.AnnotationSystem {}` and
// `new OBC.Components()` and `OBC.SomeConst` all resolve to a
// harmless value at module-load. None of the ff-viewer-tools tests
// exercise real OBC behavior (they test pure filter/index logic), so
// the no-op surface is sufficient.

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
