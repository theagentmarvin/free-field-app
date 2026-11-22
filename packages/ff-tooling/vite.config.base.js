// vite.config.base.js
//
// Shared Vite snippets for any app in the monorepo that consumes
// the @ff/viewer family of packages.
//
// This file is plain ESM JavaScript (typed by vite.config.base.d.ts) on
// purpose: Vite loads `vite.config.ts` with Node's native ESM loader and
// externalizes workspace packages, so a `.ts` entry here fails with
// ERR_UNKNOWN_FILE_EXTENSION unless a tsx loader is injected.
//
// Apps spread this in:
//
//   import { ffViewerOptimizeDeps, ffToolingAlias } from "@ff/tooling/vite.config.base";
//   export default defineConfig({
//     optimizeDeps: { ...ffViewerOptimizeDeps },
//     resolve: { alias: ffToolingAlias(workspaceRoot) },
//   });

import path from "node:path";

/** Vite optimizeDeps preset for apps that import @thatopen/fragments. */
export const ffViewerOptimizeDeps = {
  exclude: ["@thatopen/fragments"],
};

/**
 * Returns alias entries pointing to the source root of each viewer package.
 * @param {string} workspaceRoot
 * @returns {Record<string, string>}
 */
export function ffToolingAlias(workspaceRoot) {
  return {
    "@ff/viewer": path.resolve(workspaceRoot, "packages/ff-viewer/src"),
    "@ff/viewer-react": path.resolve(workspaceRoot, "packages/ff-viewer-react/src"),
  };
}
