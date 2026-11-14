// packages/ff-viewer-tools/src/vite-env.d.ts
//
// Ambient module declarations for the @ff/viewer-tools package.
// Mirrors apps/models/src/vite-env.d.ts so `tsc --noEmit` and Vite
// both resolve the CSS-module imports used by CustomFilterBuilder and
// PropertyValueDropdown.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

// Wave 39: the generic FrostedNav shell import its frosted.css as a
// plain side-effect import. TypeScript needs this ambient module so
// `tsc --noEmit` resolves it (vite/client isn't in this package's
// `types` list).
declare module "*.css";
