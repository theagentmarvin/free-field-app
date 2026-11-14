#!/usr/bin/env node
// scripts/setup-wasm.mjs
//
// Copies web-ifc's WASM blobs into public/ so Vite serves them at a
// stable URL (the browser version at /web-ifc.wasm, the Node-test
// version at /web-ifc-node.wasm). web-ifc loads its WASM via a
// `locateFile` callback; we set `wasmPath = "/"` and `absolute = true`
// so it concatenates to just "/web-ifc.wasm" / "/web-ifc-node.wasm".
//
// Run this once after `npm install`:
//   node scripts/setup-wasm.mjs
// Or via the convenience npm script:
//   npm run setup
//
// The WASM files are gitignored (they're vendor artifacts and
// regenerate cleanly from `npm install`).

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const sources = [
  ["node_modules/web-ifc/web-ifc.wasm", "public/web-ifc.wasm"],
  ["node_modules/web-ifc/web-ifc-node.wasm", "public/web-ifc-node.wasm"],
];

let copied = 0;
let skipped = 0;
let failed = 0;

for (const [src, dst] of sources) {
  const srcPath = join(projectRoot, src);
  const dstPath = join(projectRoot, dst);
  try {
    if (!existsSync(srcPath)) {
      console.error(`✗ ${src} not found; run "npm install" first.`);
      failed++;
      continue;
    }
    mkdirSync(dirname(dstPath), { recursive: true });
    copyFileSync(srcPath, dstPath);
    console.log(`✓ ${src} → ${dst}`);
    copied++;
  } catch (err) {
    console.error(`✗ ${src} → ${dst}: ${err.message}`);
    failed++;
  }
}

console.log(
  `\n${copied} copied, ${skipped} skipped, ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
