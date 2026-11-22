#!/usr/bin/env node
/**
 * prune-demo-assets.mjs - strip the demo seed and sample models from a build.
 *
 * `apps/settings/public/seed` (~114 MB) and `apps/settings/public/samples`
 * (~38 MB) exist only for the no-login demo (`VITE_FF_DEMO_AUTH=true`) and the
 * dev model picker. A self-hosted deployment does not need them, and they
 * dominate the hosting upload. Run this AFTER `vite build`:
 *
 *   pnpm build:selfhost          # = pnpm build && node scripts/prune-demo-assets.mjs
 *
 * The app tolerates their absence: the demo seeder reports "unavailable" and
 * the dev picker only fetches samples on demand.
 *
 * Usage: node scripts/prune-demo-assets.mjs [distDir]   (default apps/settings/dist)
 */
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "apps/settings/dist"));

try {
  await stat(dist);
} catch {
  console.error(`prune-demo-assets: ${dist} does not exist. Run the build first.`);
  process.exit(1);
}

for (const dir of ["seed", "samples"]) {
  const target = path.join(dist, dir);
  await rm(target, { recursive: true, force: true });
  console.log(`prune-demo-assets: removed ${path.relative(root, target)}`);
}
