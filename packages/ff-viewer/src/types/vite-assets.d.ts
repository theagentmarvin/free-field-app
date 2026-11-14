// Ambient declarations for Vite's `?url` asset imports.
//
// @ff/viewer is consumed by Vite-based apps (apps/settings) and
// tested by vitest (which runs on the same Vite transform
// pipeline), so `?url` — a Vite-specific query suffix — resolves
// fine at build/run time. TypeScript needs a declaration for it.
//
// We deliberately do NOT use `/// <reference types="vite/client" />`:
// `vite` is not a direct dependency of @ff/viewer (pnpm's strict
// node_modules layout doesn't expose it here), so that reference
// would fail to resolve — both in this package's own `tsc` run and
// in the consuming apps' typecheck, which compiles this package's
// sources through a path alias.
//
// The `pdfjs-dist` worker URL is the only `?url` import in this
// package today; the pattern is intentionally generic so the next
// asset import doesn't need a new declaration.

declare module "*?url" {
  const src: string;
  export default src;
}
