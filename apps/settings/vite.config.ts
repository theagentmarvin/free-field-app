/// <reference types="vitest" />
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
// Task 20 §1.8.6: shared Vite snippets from @ff/tooling.
// ffViewerOptimizeDeps injects optimizeDeps.exclude for
// @thatopen/fragments (which ships its own Web Worker and
// must NOT be pre-bundled). ffToolingAlias returns the
// workspace-relative @ff/viewer + @ff/viewer-react aliases.
import {
  ffViewerOptimizeDeps,
  ffToolingAlias,
} from "@ff/tooling/vite.config.base";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// Wave 18 U7 (spec §5.1/§8): Sentry sourcemap/release upload via
// @sentry/vite-plugin — ENABLED ONLY when the deploy env carries the
// secret trio. Absent env → zero plugin, build graph identical to v1
// (risk §9.6: this lockdown file only changes here, in integration).
// Auth token/org/project exist in CI/deploy env only, never in any
// committed .env*. Both the plugin-native SENTRY_* names and the
// VITE_-prefixed ones from spec §8 are accepted.
const sentryDsn = process.env.VITE_SENTRY_DSN ?? "";
const sentryAuthToken =
  process.env.VITE_SENTRY_AUTH_TOKEN ?? process.env.SENTRY_AUTH_TOKEN ?? "";
const sentryOrg = process.env.SENTRY_ORG ?? "";
const sentryProject = process.env.SENTRY_PROJECT ?? "ff-field-web";
const sentryRelease = process.env.VITE_SENTRY_RELEASE ?? "";
const sentryUploadEnabled =
  sentryDsn !== "" && sentryAuthToken !== "" && sentryOrg !== "";

// Free Field — Vite config
//
// Notes for Task 2 (IfcViewer / FragmentsModels):
// - `optimizeDeps.exclude: ['@thatopen/fragments']` is required because
//   @thatopen/fragments ships its own Web Worker and is not safe to pre-bundle.
// - COOP/COEP headers below enable `SharedArrayBuffer` in the dev server,
//   which FragmentsModels / web-ifc workers may require. If Phase 1 turns out
//   to not need SharedArrayBuffer, we can drop the headers in a follow-up.
// - The wasm-serve plugin serves web-ifc .wasm files *directly from disk*
//   (bypassing Vite's middleware chain) so Content-Type: application/wasm is
//   guaranteed. Vite's built-in middlewares can overwrite headers set by
//   custom middlewares, causing WebAssembly.instantiateStreaming() to fail.
export default defineConfig({
  plugins: [
    react(),
    ...(sentryUploadEnabled
      ? sentryVitePlugin({
          org: sentryOrg,
          project: sentryProject,
          authToken: sentryAuthToken,
          telemetry: false,
          // Release identity from deploy env (git sha, spec §8); when
          // unset the plugin auto-detects from git.
          release: sentryRelease
            ? { name: sentryRelease, inject: true, finalize: true }
            : undefined,
          sourcemaps: {
            // Upload then DELETE shipped .map files — the bundle never
            // carries sourcemap content (spec §5.1 'types: hid' analog in
            // the v11 bundler-plugin API); resolution happens Sentry-side
            // via debug ids + uploaded artifacts.
            filesToDeleteAfterUpload: "./dist/**/*.map",
          },
        })
      : []),
    {
      name: "wasm-serve",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          // Block multi-threaded web-ifc paths -> 404 forces single-threaded
          if (req.url.startsWith("/web-ifc-mt")) {
            res.statusCode = 404;
            res.end();
            return;
          }
          // Serve known .wasm files directly from disk so Content-Type and
          // response status are fully under our control
          if (req.url === "/web-ifc.wasm" || req.url === "/web-ifc-node.wasm") {
            const filePath = path.resolve(__dirname, "public", req.url.slice(1));
            try {
              const data = fs.readFileSync(filePath);
              res.writeHead(200, {
                "Content-Type": "application/wasm",
                "Content-Length": data.length,
              });
              res.end(data);
            } catch {
              res.statusCode = 404;
              res.end();
            }
            return; // do NOT call next()
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@components": path.resolve(__dirname, "src/components"),
      "@hooks": path.resolve(__dirname, "src/hooks"),
      "@store": path.resolve(__dirname, "src/store"),
      "@calibration": path.resolve(__dirname, "src/calibration"),
      "@shell": path.resolve(__dirname, "src/shell"),
      "@ff/auth": path.resolve(__dirname, "../../packages/ff-auth/src"),
      "@ff/firestore": path.resolve(__dirname, "../../packages/ff-firestore/src"),
      "@free-field/models": path.resolve(__dirname, "../models/src"),
      "@free-field/documents": path.resolve(__dirname, "../documents/src"),
      "@free-field/linkview": path.resolve(__dirname, "../linkview/src"),
      "@free-field/users": path.resolve(__dirname, "../users/src"),
      // Task 20 §1.8.5: the @viewer alias is gone — the viewer
      // components live in @ff/viewer-react (the React shell)
      // and @ff/viewer (the headless core). The workspace
      // aliases come from @ff/tooling (one source of truth).
      // ffToolingAlias takes the MONOREPO root, not the app's __dirname —
      // it computes paths like {monorepo-root}/packages/ff-viewer-react/src.
      ...ffToolingAlias(path.resolve(__dirname, "../..")),
    },
  },
  // Task 20 §1.8.6: shared optimizeDeps preset from
  // @ff/tooling. The spread keeps Settings's own entries
  // (none today) in addition to the @thatopen/fragments
  // exclude the library needs to ship its own Web Worker.
  optimizeDeps: {
    ...(ffViewerOptimizeDeps ?? {}),
    exclude: [
      ...(ffViewerOptimizeDeps?.exclude ?? []),
    ],
  },
  build: {
    // Maps exist only in gated-upload builds (uploaded + deleted above;
    // `hidden` would still ship nothing referenced). Non-upload builds
    // keep the v1 default (no maps at all).
    ...(sentryUploadEnabled ? { sourcemap: true } : {}),
  },
  server: {
    // COOP/COEP dropped: we use single-threaded web-ifc and the
    // ground-truth example loads WASM from unpkg CDN. COEP require-corp
    // would block cross-origin CDN responses, breaking the example pattern.
    // Remote test access: allow the Tailscale MagicDNS host(s) so a
    // tailscale-serve tunnel (or funnel) can reach the dev server without
    // vite's host-allowlist 403. Suffix form covers any node under the
    // tailnet domain.
    allowedHosts: [".tail919556.ts.net"],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./__tests__/setup.ts"],
    globals: true,
    // Heavier Dexie/pipeline tests (e.g. replaceIfcVersion ~2.3 s) blow
    // the 5 s default under turbo parallel load; flake-free at 20 s.
    testTimeout: 20000,
    // three.webgpu.js crashes in jsdom (no WebGPU/WebGL). Redirect to
    // no-op stubs for component tests. Tests that exercise the actual
    // viewer (in packages/ff-viewer-react) use their own vitest config.
    alias: {
      three:
        fileURLToPath(new URL("./__tests__/__mocks__/three.ts", import.meta.url)),
      "@thatopen/components-front":
        fileURLToPath(new URL("./__tests__/__mocks__/obc-front.ts", import.meta.url)),
    },
  },
});
