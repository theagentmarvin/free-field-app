// apps/models/src/vite-env.d.ts
//
// Vite-specific ambient module declarations. Loaded automatically by
// Vite + `tsc -b`. Mirrors apps/settings/src/vite-env.d.ts but for
// the models workspace.
/// <reference types="vite/client" />
// ^ required since chunk 3: <Viewer> imports @ff/tasks-react, which
// drags ff-auth's `import.meta.env` into this program.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
