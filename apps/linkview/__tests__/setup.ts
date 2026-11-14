// apps/linkview — Vitest setup.
//
// Mirrors apps/models/__tests__/setup.ts so the Linkview module
// gets the same jsdom + IndexedDB + Blob/File polyfills Settings,
// Models, and Documents already have. Any future test that touches
// Dexie or file uploads should work out of the box.
//
// Critical pieces:
//  - fake-indexeddb/auto gives Dexie a working IndexedDB in jsdom.
//  - Node's native Blob/File replace jsdom's incomplete ones (Dexie
//    calls .arrayBuffer() on blobs).
//  - vitest globals (describe/it/expect) are enabled in tsconfig via
//    "types": ["vitest/globals", "node"], so tests don't need to
//    import them.
//
// ── Why the two workspace mocks below ────────────────────────────
//
// `apps/linkview/src` pulls in two heavy package barrels:
//
//   src → @ff/viewer-tools → @ff/viewer-react → @thatopen/components
//                                     ↘ @ff/viewer → @thatopen/components
//
// `@thatopen/components` is the ONLY importer of three's *webgpu*
// build (`three/webgpu`), which crashes at module load in jsdom with
// `TypeError: Cannot read properties of undefined (reading 'VERTEX')`
// — the `GPUShaderStage` global only exists in a browser.
//
// apps/settings solves this with `resolve.alias` + direct
// dependencies on `three` / `@thatopen/components`. Linkview has
// NEITHER as a dependency, so `vi.mock("three")` /
// `vi.mock("@thatopen/components")` cannot resolve those ids from
// this workspace and silently do nothing (a vi.mock whose id does not
// resolve never intercepts the real import). The only ids that DO
// resolve from apps/linkview are its own workspace dependencies —
// `@ff/viewer` and `@ff/viewer-react` — so we mock those instead and
// cut the OBC/three chain at its root.
//
// The @ff/viewer-react mock keeps the two PURE helpers that
// `@ff/viewer-tools` imports at runtime (`buildInvertedIndex`,
// `evaluateRule`) real, by pulling them from their standalone
// module (`src/indexPropertyData.ts` — no React / OBC / Three).
//
// A test file that needs a richer @ff/viewer-react mock (e.g.
// LinkviewApp.test.tsx, which asserts on the imperative handle) can
// call `vi.mock("@ff/viewer-react", ...)` itself: a vi.mock inside a
// test file wins over this global one for that file.
//
// IMPORTANT: `vi.mock(...)` calls must live at the top of the file
// (above any `import` that transitively touches the mocked module).
// Vitest hoists vi.mock calls automatically, but the factory
// references the mocked module path so the order matters for
// readability and for any non-hoisted side effects.

import { vi } from "vitest";

// ── @ff/viewer (headless core) ──────────────────────────────────
//
// @ff/viewer-tools' `useFloorPlanOverlay` imports `loadPDF` from
// here; @ff/viewer's barrel also re-exports LevelPlanController,
// which imports @thatopen/components. Mocking the barrel keeps both
// the OBC chain and the pdfjs-dist import (which needs DOMMatrix /
// Path2D at module init) out of the Linkview test graph.
//
// `loadPDF` is stubbed because the Linkview tests never open a PDF
// plane in the 3D viewer — they assert on the sidebar + canvas
// wiring, not on PDF rasterisation.
vi.mock("@ff/viewer", () => ({
  loadPDF: vi.fn(async () => ({
    doc: { numPages: 1 },
    numPages: 1,
    width: 612,
    height: 792,
    renderPage: vi.fn(),
    destroy: vi.fn(),
  })),
  createLevelPlanController: vi.fn(() => ({
    activeStoreyName: null,
    open: vi.fn(async () => false),
    close: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// ── @ff/viewer-react (React shell) ──────────────────────────────
//
// The barrel re-exports <IfcViewer>, whose module pulls OBC + Three.
// Stub the components; keep the pure helpers real (see the header
// note). `buildInvertedIndex` / `evaluateRule` come from the
// standalone `indexPropertyData` module so the custom-filter code
// paths in @ff/viewer-tools keep their real behavior.
vi.mock("@ff/viewer-react", async () => {
  const { buildInvertedIndex, evaluateRule } = await import(
    "../../../packages/ff-viewer-react/src/indexPropertyData"
  );
  const IfcViewer = () => null;
  const PdfOverlay = () => null;
  return {
    IfcViewer,
    PdfOverlay,
    buildInvertedIndex,
    evaluateRule,
  };
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
