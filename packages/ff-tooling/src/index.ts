// @ff/tooling entry point. Re-exports the Vite snippets from
// vite.config.base so consumers can do:
//
//   import { ffViewerOptimizeDeps, ffToolingAlias } from "@ff/tooling";
//
// vite.config.base is plain ESM `.js` (+ `.d.ts`) so Node can load it
// natively when Vite reads an app's vite.config.ts.
export { ffViewerOptimizeDeps, ffToolingAlias } from "../vite.config.base.js";
