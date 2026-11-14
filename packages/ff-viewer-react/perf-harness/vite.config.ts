// packages/ff-viewer-react/perf-harness/vite.config.ts
//
// Vite config for the navigation perf harness page (index.html +
// main.tsx in this folder). Normally started programmatically by
// run.mjs; can also be served by hand for interactive poking:
//
//   FF_PERF_FRAG_DIR=<dir with .frag files> \
//     pnpm --filter @ff/viewer-react exec vite --config perf-harness/vite.config.ts
//
// Mirrors the app's viewer-relevant Vite settings (apps/settings
// vite.config.ts): React plugin, the @ff/tooling viewer aliases and
// `optimizeDeps.exclude: ['@thatopen/fragments']` (the library ships
// its own worker). Frag bytes are served from disk at
// `/__frag/<key>.frag` (dev AND preview), so the page needs no
// IndexedDB seed, no Firebase and no network.

import { defineConfig, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ffViewerOptimizeDeps,
  ffToolingAlias,
} from "../../ff-tooling/vite.config.base";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../../..");
const fragDir = process.env.FF_PERF_FRAG_DIR ?? path.join(here, "node_modules/.frag-cache");

function fragMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? "";
    const m = /^\/__frag\/([A-Za-z0-9._-]+\.frag)(\?.*)?$/.exec(url);
    if (!m) return next();
    const file = path.join(fragDir, m[1]);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        res.end(`frag not found: ${m[1]}`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
  };
}

export default defineConfig({
  root: here,
  // Keep the harness's dep-optimizer cache separate from the package's.
  cacheDir: path.join(here, "node_modules/.vite-perf-harness"),
  plugins: [
    react(),
    {
      name: "ff-perf-frag-serve",
      configureServer(server) {
        server.middlewares.use(fragMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(fragMiddleware());
      },
    },
  ],
  resolve: {
    alias: {
      ...ffToolingAlias(monorepoRoot),
    },
  },
  optimizeDeps: {
    ...(ffViewerOptimizeDeps ?? {}),
    exclude: [...(ffViewerOptimizeDeps?.exclude ?? [])],
  },
  server: {
    host: "127.0.0.1",
    fs: { allow: [monorepoRoot] },
  },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: process.env.FF_PERF_BUILD_DIR ?? path.join(here, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 100_000,
  },
  logLevel: "warn",
});
