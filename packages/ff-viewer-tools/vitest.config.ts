// packages/ff-viewer-tools/vitest.config.ts
//
// Vitest config for @ff/viewer-tools. Mirrors apps/models' test env
// (jsdom + globals + the OBC/three/IndexedDB setup) because the moved
// tests exercise the same component + hook surface.
//
// Resolve aliases mirror tsconfig.json `paths` so the sibling @ff
// packages resolve to their `src/` entry regardless of the pnpm
// symlink state during a partial install.

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const obcStub = resolve(__dirname, "./__tests__/support/obc-stub.ts");

export default defineConfig({
  resolve: {
    alias: {
      // Redirect the @thatopen packages (the only importers of
      // three/webgpu, which crashes on load in jsdom) to a light
      // stub. An alias is used instead of vi.mock because these
      // packages aren't deps of @ff/viewer-tools — they resolve out
      // of @ff/viewer-react's node_modules, so a vi.mock id
      // registered here wouldn't intercept them. See obc-stub.ts.
      "@thatopen/components-front": obcStub,
      "@thatopen/components": obcStub,
      "@ff/viewer-react": resolve(__dirname, "../ff-viewer-react/src"),
      "@ff/viewer": resolve(__dirname, "../ff-viewer/src"),
      "@ff/types": resolve(__dirname, "../ff-types/src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./__tests__/setup.ts"],
    globals: true,
  },
});
