// src/ifc/webIfcWasm.ts
//
// Where web-ifc's WASM lives, for the standalone IfcAPI (parseIfc)
// and for FRAGS.IfcImporter. Moved verbatim from
// hooks/useIfcPipeline.ts so the IFC import Web Worker
// (./ifcImport.worker.ts) resolves the wasm exactly like the
// main-thread path did: in a browser (window OR worker — neither
// defines `process`) it is the app's own bundled copy at
// <BASE_URL>web-ifc.wasm, under Node (vitest / tooling) it is
// node_modules/web-ifc on disk.

import type * as WEBIFC from "web-ifc";
import type * as FRAGS from "@thatopen/fragments";

/**
 * Locate the web-ifc WASM for the current environment.
 *
 * Browser: Vite serves public/ at BASE_URL, so the wasm resolves to
 * "<origin><BASE_URL>web-ifc.wasm" (see getBrowserWasmDir).
 *
 * Node (vitest / SSR / tooling): there's no public/, but the WASM
 * is right next to web-ifc-api-node.js inside node_modules/web-ifc/.
 * We resolve that path relative to the current source file so the
 * project layout (root / src / public / __tests__ / node_modules)
 * works from any CWD.
 */
/**
 * True when we're running under a real browser (Vite dev / production
 * build), false under Node (vitest / SSR / tooling). The trick: we
 * check for the absence of `process` — Vite's browser bundle doesn't
 * define a global `process`; Node always has one.
 */
export function isBrowser(): boolean {
  return typeof process === "undefined" || (process as { browser?: boolean }).browser === true;
}

// Browser: the app ships web-ifc's wasm itself — apps/settings
// `scripts/setup-wasm.mjs` copies node_modules/web-ifc/web-ifc.wasm
// into public/, so it is served next to index.html in dev and lands
// in dist/ on build. We resolve it against Vite's BASE_URL so a
// sub-path deploy works, in the page AND in the import worker (a
// module worker's relative URLs resolve against the worker script, so
// we always hand web-ifc an absolute URL). No CDN fetch at runtime:
// imports work offline and the wasm version always matches the
// installed web-ifc JS.
//
// web-ifc's locateFile does `wasmPath + "web-ifc.wasm"` when
// `absolute` is true, so the path must end with "/".

/** Directory URL (trailing "/") the browser loads web-ifc.wasm from. */
export function getBrowserWasmDir(): string {
  let base = "/";
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: unknown } }).env;
    if (env && typeof env.BASE_URL === "string" && env.BASE_URL) base = env.BASE_URL;
  } catch {
    /* no import.meta.env outside Vite */
  }
  if (!base.endsWith("/")) base += "/";
  const loc = (globalThis as { location?: { href?: string; origin?: string } }).location;
  if (/^[a-z][a-z0-9+.-]*:/i.test(base)) return base; // already absolute
  if (!loc?.origin || loc.origin === "null") return base;
  // A relative base ("./") must not resolve against a worker's
  // /assets/ URL: anchor it at the document (page) or the site root
  // (worker).
  const anchor =
    typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : loc.origin + "/";
  return new URL(base, anchor).href;
}

export function setWebIfcWasmPath(ifc: WEBIFC.IfcAPI): void {
  if (isBrowser()) {
    ifc.SetWasmPath(getBrowserWasmDir(), true);
    return;
  }
  // Node: <repo>/node_modules/web-ifc/web-ifc-node.wasm.
  // web-ifc's locateFile callback appends the wasm filename to
  // wasmPath unconditionally, so we pass the *directory* and
  // absolute=true so it doesn't prepend its own currentScriptPath.
  ifc.SetWasmPath(getNodeWasmDir(), true);
}

export function setFragmentsWasmPath(importer: FRAGS.IfcImporter): void {
  importer.wasm.path = isBrowser() ? getBrowserWasmDir() : getNodeWasmDir();
  importer.wasm.absolute = true;
}

let cachedNodeWasmDir: string | null = null;
/**
 * Resolve the absolute filesystem path to web-ifc's wasm directory
 * (containing both `web-ifc.wasm` and `web-ifc-node.wasm`).
 *
 * Only invoked under Node (see `isBrowser()`). We use a lazy
 * `createRequire` so `node:*` modules never reach the browser bundle.
 */
function getNodeWasmDir(): string {
  if (cachedNodeWasmDir !== null) return cachedNodeWasmDir;
  // `createRequire` is the spec-blessed way to do `require` from ESM.
  // Vite/Rollup tree-shake this whole branch in the browser build
  // because it's gated by `isBrowser()`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeModule = require("node:module") as typeof import("node:module");
  const req = nodeModule.createRequire(import.meta.url);
  const { fileURLToPath } = req("node:url") as typeof import("node:url");
  const { dirname, resolve } = req("node:path") as typeof import("node:path");
  // `here` ends in `/<repo>/src/ifc` (this file). Going up 2
  // levels lands at `/<repo>`, where node_modules lives. (Going
  // up 3 would escape the repo entirely.)
  const here = dirname(fileURLToPath(import.meta.url));
  // Trailing separator matters: web-ifc does `wasmPath + filename`
  // and produces `web-ifcweb-ifc-node.wasm` without the trailing /.
  cachedNodeWasmDir =
    resolve(here, "..", "..", "node_modules", "web-ifc") + "/";
  return cachedNodeWasmDir;
}
