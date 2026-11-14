// packages/ff-data/perf/ifc-import/vite.config.ts — see ./run.mjs.
// Serves IFC files from FF_IFC_DIR at /__ifc/<name>. Mirrors the app's
// relevant settings: @thatopen/fragments excluded from optimizeDeps.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../../../..");
const ifcDir = process.env.FF_IFC_DIR ?? path.join(monorepoRoot, "apps/settings/public/samples");

type Req = { url?: string };
type Res = {
  statusCode: number;
  end(s?: string): void;
  writeHead(code: number, headers: Record<string, string | number>): void;
};
// (@ff/data has no vite dependency; run.mjs loads the settings app's vite.)
// web-ifc's wasm is served by the page itself (as the app does from
// public/), straight from node_modules — no CDN, so the harness runs
// offline (run.mjs --offline blocks every non-local request).
const wasmDir = path.join(here, "../../node_modules/web-ifc");
function ifcMiddleware() {
  return (req: Req, res: Res & NodeJS.WritableStream, next: () => void) => {
    const url = (req.url ?? "").split("?")[0];
    const w = /^\/(web-ifc(?:-node)?\.wasm)$/.exec(url);
    const m = /^\/__ifc\/([^?]+)/.exec(req.url ?? "");
    if (!m && !w) return next();
    const file = w
      ? path.join(wasmDir, w[1])
      : path.join(ifcDir, path.basename(decodeURIComponent(m![1])));
    const type = w ? "application/wasm" : "application/octet-stream";
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": st.size });
      fs.createReadStream(file).pipe(res);
    });
  };
}

export default {
  root: here,
  cacheDir: path.join(here, "../../node_modules/.vite-ifc-import-harness"),
  plugins: [
    {
      name: "ff-ifc-serve",
      configureServer(s: { middlewares: { use(fn: unknown): void } }) {
        s.middlewares.use(ifcMiddleware());
      },
      configurePreviewServer(s: { middlewares: { use(fn: unknown): void } }) {
        s.middlewares.use(ifcMiddleware());
      },
    },
  ],
  optimizeDeps: { exclude: ["@thatopen/fragments"] },
  server: { host: "127.0.0.1", fs: { allow: [monorepoRoot] } },
  preview: { host: "127.0.0.1" },
  build: {
    outDir: process.env.FF_IFC_HARNESS_BUILD_DIR ?? path.join(here, "../../node_modules/.ifc-import-harness-dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 100_000,
  },
  logLevel: "warn",
};
