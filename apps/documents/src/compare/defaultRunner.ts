// apps/documents/src/compare/defaultRunner.ts
//
// Lazy bridge to the diff engine so the UI bundle only pulls it in on use.

import type { RunCompare } from "./types";

export const defaultRunner: RunCompare = async (base, revision, settings, opts) => {
  const mod = await import("./engine");
  return mod.runCompare(base, revision, settings, opts);
};
