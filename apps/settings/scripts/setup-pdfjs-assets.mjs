#!/usr/bin/env node
// scripts/setup-pdfjs-assets.mjs
//
// Copies PDF.js's runtime asset trees into `public/pdfjs/` so the
// browser can fetch them BY NAME from our own origin:
//
//   node_modules/pdfjs-dist/cmaps/          → public/pdfjs/cmaps/
//   node_modules/pdfjs-dist/standard_fonts/ → public/pdfjs/standard_fonts/
//
// `cmaps` are the CJK character maps (169 `.bcmap` files) that
// PDF.js loads when a document's fonts are not embedded — without
// them, Chinese/Japanese/Korean text renders as blanks/boxes.
// `standard_fonts` are the standard-14 + fallback fonts (14 files)
// PDF.js substitutes for non-embedded fonts.
//
// WHY A DIRECTORY COPY (and not a `?url` import)?
//
// The PDF.js *worker* is fetched from a `?url` import in
// `@ff/viewer` (see `packages/ff-viewer/src/pdf/loadPdf.ts`):
//
//   import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
//
// That works because the worker is ONE file whose URL the bundler
// can hand us — hashed, same-origin, no runtime fetch of source.
//
// These assets are a different shape: PDF.js looks them up BY NAME
// at runtime (`<cMapUrl>/<name>.bcmap`), on demand, only for the
// documents that actually need them. No bundler import can express
// "fetch this name from this directory" — the files have to exist
// as real, static assets under `public/`. Hence this copy step.
//
// The two mechanisms are deliberately NOT unified: `?url` for the
// worker, `public/` copy for the asset trees. Folding one into the
// other breaks one of them.
//
// Run this once after `npm install`:
//   node scripts/setup-pdfjs-assets.mjs
// Or via the convenience npm script (which also copies the WASM
// blobs — `npm run setup` runs both):
//   npm run setup
//
// The copied files are gitignored (they're vendor artifacts and
// regenerate cleanly from `npm install`).

import { cpSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// [source dir (relative to the app root), destination dir]
const directories = [
  ["node_modules/pdfjs-dist/cmaps", "public/pdfjs/cmaps"],
  [
    "node_modules/pdfjs-dist/standard_fonts",
    "public/pdfjs/standard_fonts",
  ],
];

let copied = 0;
let failed = 0;

for (const [src, dst] of directories) {
  const srcPath = join(projectRoot, src);
  const dstPath = join(projectRoot, dst);
  try {
    if (!existsSync(srcPath)) {
      console.error(`✗ ${src} not found; run "npm install" first.`);
      failed++;
      continue;
    }
    // Replace the destination wholesale: a pdfjs-dist upgrade can
    // remove files, and a stale copy would keep serving them.
    rmSync(dstPath, { recursive: true, force: true });
    mkdirSync(dirname(dstPath), { recursive: true });
    cpSync(srcPath, dstPath, { recursive: true });
    console.log(`✓ ${src} → ${dst}`);
    copied++;
  } catch (err) {
    console.error(`✗ ${src} → ${dst}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${copied} copied, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
