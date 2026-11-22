import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @free-field/models is consumed by @free-field/settings at runtime
// (single Vite origin, single Dexie instance). This config exists for
// symmetry with sibling apps and for `tsc -b` typechecking inside
// apps/models/. It does NOT define a `dev` script — apps/settings is
// the only dev server in the unified app.
//
// The resolve.alias block mirrors apps/models/tsconfig.json paths so
// editors and IDEs that read vite.config.ts get the same resolution
// graph as the typechecker.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ff/viewer-react": path.resolve(
        __dirname,
        "../../packages/ff-viewer-react/src",
      ),
      "@ff/viewer": path.resolve(__dirname, "../../packages/ff-viewer/src"),
      "@ff/types": path.resolve(__dirname, "../../packages/ff-types/src"),
    },
  },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    setupFiles: ["./__tests__/setup.ts"],
    globals: true,
    // The @thatopen packages (the only importers of three/webgpu,
    // which crashes on load in jsdom) are NOT dependencies of this
    // app — they live in @ff/viewer-react's node_modules — so the
    // `vi.mock` in __tests__/setup.ts can't intercept them. Alias
    // them to a light stub instead, exactly like the sibling
    // packages do (apps/settings + @ff/viewer-tools). Without this,
    // ANY test that imports the @ff/viewer-tools barrel (which
    // re-exports hooks that import @ff/viewer-react) dies on the
    // three/webgpu module load.
    alias: {
      "@thatopen/components": fileURLToPath(new URL("./__tests__/__mocks__/obc-stub.ts", import.meta.url)),
      "@thatopen/components-front": fileURLToPath(new URL("./__tests__/__mocks__/obc-stub.ts", import.meta.url)),
    },
  },
});
