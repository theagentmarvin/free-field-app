// apps/models — Vitest setup.
//
// Mirrors apps/settings/__tests__/setup.ts so the Models module gets
// the same jsdom + IndexedDB + Blob/File polyfills Settings has. Any
// future test that touches Dexie, file uploads, or the IfcViewer
// pipeline should work out of the box.
//
// Critical pieces:
//  - fake-indexeddb/auto gives Dexie a working IndexedDB in jsdom.
//  - Node's native Blob/File replace jsdom's incomplete ones (Dexie
//    calls .arrayBuffer() on blobs).
//  - vitest globals (describe/it/expect) are enabled in tsconfig via
//    "types": ["vitest/globals", "node"], so tests don't need to
//    import them.
//  - Task 22 / wave 35: when a test imports `flattenItemData` (or
//    anything that transitively re-exports IfcViewer) from
//    @ff/viewer-react, the import pulls in `@thatopen/components`
//    and Three.js's webgpu build, which crashes in jsdom with
//    "Cannot read properties of undefined (reading 'VERTEX')". The
//    @thatopen packages are aliased to a stub in vite.config.ts
//    (they are not deps of this app, so a vi.mock id registered
//    here could not intercept them).
//
// IMPORTANT: `vi.mock(...)` calls must live at the top of the file
// (above any `import` that transitively touches the mocked
// module). Vitest hoists vi.mock calls automatically, but the
// factory references the mocked module path so the order matters
// for readability and for any non-hoisted side effects. We
// deliberately keep them at the top here.

import { vi } from "vitest";

// Wave 35: the @thatopen packages are NOT dependencies of this app
// (they live in @ff/viewer-react's node_modules), so a `vi.mock` id
// registered here can't intercept them — they are ALIASED to a light
// stub in vite.config.ts (test.alias → __tests__/__mocks__/
// obc-stub.ts) instead, the same pattern apps/settings and
// @ff/viewer-tools use. The `three` guard mock below stays as
// belt-and-suspenders.

// Task 22: importing IfcViewer (transitively via
// @ff/viewer-react) pulls three.js's webgpu build at module
// load. In jsdom the webgpu module throws because the global
// VERTEX constant is undefined. We only use `flattenItemData`
// from IfcViewer in tests, which never touches three. Stub
// three with a minimal surface so the module load succeeds.
// The ff-viewer-react IfcViewer.test.tsx mocks three similarly
// (see packages/ff-viewer-react/__tests__/setup.ts).
vi.mock("three", () => {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Anything that looks like a class constructor — return
      // a no-op class so `new THREE.WebGLRenderer()` etc. don't
      // throw on module load.
      if (typeof prop === "string" && /^[A-Z]/.test(prop)) {
        return class {};
      }
      // Anything else (constants, namespaces) — return a
      // proxy so further reads also resolve.
      return new Proxy(function () {}, handler);
    },
  };
  return new Proxy({}, handler);
});

import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";

// jsdom lacks DOMMatrix / Path2D, which @ff/viewer's pdf/loadPdf.ts
// (pulled transitively via the @ff/viewer barrel) references at module
// load. Mirror packages/ff-viewer-tools/__tests__/setup.ts.
class DOMMatrixShim {}
class Path2DShim {}
if (
  (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix === undefined
) {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = DOMMatrixShim;
}
if (
  (globalThis as unknown as { Path2D?: unknown }).Path2D === undefined
) {
  (globalThis as unknown as { Path2D: unknown }).Path2D = Path2DShim;
}

const { Blob: NodeBlob, File: NodeFile } = await import("node:buffer");
if (typeof globalThis.Blob !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Blob = NodeBlob;
}
if (typeof globalThis.File !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).File = NodeFile;
}
