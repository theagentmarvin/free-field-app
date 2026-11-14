// src/vite-env.d.ts
//
// Vite-specific ambient module declarations. Loaded automatically by
// Vite + `tsc -b` (the `vite/client` triple-slash reference is what
// gives us types for `?url`, `?raw`, asset imports, etc.).
/// <reference types="vite/client" />

// Vite resolves `?url` imports to a `{ default: string }` (a record
// with a `default` field). Pulling the string out is two characters
// at the call site (`import url from "..."`).
declare module "*?url" {
  const url: string;
  export default url;
}

// Demo mode (plan v4 amendment v4.1). "true" boots the app with the
// mocked sign-in — no Firebase backend, roles come from the left-rail
// "View as" toggle instead of Firebase claims.
interface ImportMetaEnv {
  readonly VITE_FF_DEMO_AUTH?: string;
}
