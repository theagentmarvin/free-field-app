import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @free-field/documents is consumed by @free-field/settings at runtime
// (single Vite origin, single Dexie instance). This config exists for
// symmetry with sibling apps and for `tsc -b` typechecking inside
// apps/documents/. It does NOT define a `dev` script — apps/settings
// is the only dev server in the unified app.
//
// The resolve.alias block mirrors apps/documents/tsconfig.json paths so
// editors and IDEs that read vite.config.ts get the same resolution
// graph as the typechecker.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ff/auth": path.resolve(__dirname, "../../packages/ff-auth/src"),
      "@ff/viewer-tools/pdf-measure": path.resolve(
        __dirname,
        "../../packages/ff-viewer-tools/src/pdfMeasure/index.ts",
      ),
      "@free-field/models": path.resolve(__dirname, "../models/src"),
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
  },
});
