// vite.config.base.ts
//
// Shared Vite snippets for any app in the monorepo that consumes
// the @ff/viewer family of packages.
//
// Structure critic M3 (post-Phase-0 review, 2026-06-19): every
// app that imports @thatopen/fragments needs
// `optimizeDeps.exclude: ['@thatopen/fragments']` — the library
// ships its own Web Worker and is not safe to pre-bundle.
//
// Apps spread this in:
//
//   import { ffViewerOptimizeDeps, ffToolingAlias } from "@ff/tooling/vite.config.base";
//   export default defineConfig({
//     optimizeDeps: { ...ffViewerOptimizeDeps, exclude: [...(ffViewerOptimizeDeps.exclude ?? []), /* app-specific */] },
//     resolve: { alias: ffToolingAlias(workspaceRoot) },
//   });

import type { UserConfig } from "vite";
import path from "node:path";

/** Vite optimizeDeps preset for apps that import @thatopen/fragments. */
export const ffViewerOptimizeDeps: UserConfig["optimizeDeps"] = {
  exclude: ["@thatopen/fragments"],
};

/**
 * Returns alias entries pointing to the source root of each
 * viewer package. Vite consumes the alias map directly; the
 * workspace root is the second arg so the path is repo-relative
 * and stable regardless of where the app lives.
 */
export function ffToolingAlias(workspaceRoot: string): Record<string, string> {
  return {
    "@ff/viewer": path.resolve(workspaceRoot, "packages/ff-viewer/src"),
    "@ff/viewer-react": path.resolve(workspaceRoot, "packages/ff-viewer-react/src"),
  };
}
