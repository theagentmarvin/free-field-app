// packages/ff-viewer-tools/__tests__/setup.ts
//
// Vitest setup for @ff/viewer-tools. Mirrors apps/models/__tests__/setup.ts.
//
// Why the OBC stub: the package's public barrel (@ff/viewer-react)
// value-exports `IfcViewer`, which transitively imports
// `@thatopen/components` and three's webgpu build. Any test whose
// source pulls the barrel (customPresetEvaluator, useModelPropertyIndex
// — for the pure `buildInvertedIndex`/`evaluateRule`) would load OBC
// → three/webgpu → crash in jsdom ("reading 'VERTEX'").
//
// The @thatopen packages are NOT deps of @ff/viewer-tools (they live
// in @ff/viewer-react's node_modules), so a `vi.mock` id registered
// here wouldn't intercept them. Instead we alias @thatopen/* to a
// stub in vitest.config.ts (see __tests__/support/obc-stub.ts). This
// setup file keeps the `three` guard mock (belt-and-suspenders) plus
// the fake-indexeddb + Blob/File polyfills the Dexie test double needs.
//
// Why fake-indexeddb: the Dexie-backed test doubles in
// __tests__/support/testDb.ts need a working IndexedDB. `useLiveQuery`
// observes Dexie writes process-globally, so a local test Dexie
// faithfully drives the package hooks' live-query re-fire — the exact
// reactivity contract documented in src/dataSource.ts.

import { vi } from "vitest";

// three's webgpu build throws on module load in jsdom (undefined VERTEX).
// Proxy every export to a no-op class / nested proxy so the load succeeds.
vi.mock("three", () => {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop === "string" && /^[A-Z]/.test(prop)) {
        return class {};
      }
      return new Proxy(function () {}, handler);
    },
  };
  return new Proxy({}, handler);
});

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

// jsdom lacks DOMMatrix / Path2D, which @ff/viewer's pdf/loadPdf.ts
// (pulled transitively via the @ff/viewer-react barrel) references at
// module load. Mirror apps/../ff-viewer-react/__tests__/setup.ts.
class DOMMatrixShim {}
class Path2DShim {}
if (
  typeof (globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix ===
  "undefined"
) {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = DOMMatrixShim;
}
if (
  typeof (globalThis as unknown as { Path2D?: unknown }).Path2D === "undefined"
) {
  (globalThis as unknown as { Path2D: unknown }).Path2D = Path2DShim;
}
