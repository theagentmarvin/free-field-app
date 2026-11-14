// @ff/tooling entry point. Re-exports the Vite snippets from
// vite.config.base so consumers can do:
//
//   import { ffViewerOptimizeDeps, ffToolingAlias } from "@ff/tooling";
//
// without reaching for the subpath export. The Vite snippet file
// is `.ts` (not `.js`) on purpose: Vite itself consumes it via
// tsx-friendly ts-loaders, and the package.json `exports` map
// makes the resolution explicit.
export { ffViewerOptimizeDeps, ffToolingAlias } from "../vite.config.base";
