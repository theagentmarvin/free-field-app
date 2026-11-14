// Ambient declarations for Vite's `?url` asset imports.
//
// Mirrors `packages/ff-viewer/src/types/vite-assets.d.ts` (written for
// the pdfjs worker in task 37). `@ff/viewer-react` is consumed by
// Vite-based apps and tested by vitest, which runs on the same Vite
// transform pipeline, so `?url` — a Vite-specific query suffix —
// resolves fine at build/run time. TypeScript needs a declaration.
//
// We deliberately do NOT use `/// <reference types="vite/client" />`:
// `vite` is not a direct dependency of this package (pnpm's strict
// node_modules layout doesn't expose it here), so that reference would
// fail to resolve — both in this package's own `tsc` run and in the
// consuming apps' typecheck, which compiles these sources through a
// path alias.
//
// Used by `IfcViewer.tsx` for `@thatopen/fragments/worker` — the
// fragments worker script (wave 30).

declare module "*?url" {
  const src: string;
  export default src;
}
