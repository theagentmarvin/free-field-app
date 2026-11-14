// packages/ff-viewer-react/src/worker/fragmentsWorkerUrl.ts
//
// Wave 30: resolves the fragments worker script for
// `FragmentsManager.init()`. Extracted from `IfcViewer.tsx` so the
// caching rules are unit-testable — the bug this file used to carry
// (a rejected Promise cached at module scope forever) was invisible to
// the existing suite precisely because it lived inside a 5,300-line
// component module behind a mount effect.

import fragmentsWorkerAssetUrl from "@thatopen/fragments/worker?url";

// ── The worker script ships INSIDE the app bundle ──────────────────
//
// `@thatopen/fragments` exports the worker as a package subpath
// (`"./worker"` in its exports map → `dist/Worker/worker.mjs`), and
// that file is self-contained — verified against the installed copy:
// zero static imports, zero dynamic `import()`, zero `importScripts`
// — so Vite can emit it as a plain asset and the emitted copy IS the
// whole worker. `?url` hands us its same-origin URL.
//
// This replaces a version-pinned unpkg URL that fetched 3.2 MB across
// the network on every cold mount. Three problems with that, all gone:
//   • **version drift** — the literal `fragments%403.4.5` in the URL
//     was frozen in source while the package is a `^3.4.5` dependency:
//     a routine minor bump would have the main thread speaking one
//     protocol and the worker another, silently;
//   • **mount-time network dependency** — the first model load waited
//     on a third-party CDN round-trip (and paid again after any cache
//     eviction) on field devices that are often on cellular;
//   • **offline / restricted deployments** could never load a model.
export const FRAGMENTS_WORKER_BUNDLE_URL: string = fragmentsWorkerAssetUrl;

// ── Fallback only: unpkg ───────────────────────────────────────────
//
// The @ characters are URL-encoded as %40 to bypass Cloudflare's
// email-obfuscation feature (fragments@<version> gets rewritten to
// "[email protected]" otherwise). The %40 trick also avoids the unpkg
// v1 vs v2 redirect quirks. Kept for hosts that consume this package
// without a Vite asset pipeline — and for the (rare) case where the
// emitted asset itself fails to load.
//
// FragmentsModels.getWorker() (added in @thatopen/fragments 3.4.x)
// fetches from unpkg too, with the literal @ in the URL, so it hits
// the same Cloudflare bug; the %40 form is why we still do this
// ourselves instead of calling that helper.
export const FRAGMENTS_WORKER_CDN =
  "https://unpkg.com/%40thatopen/fragments%403.4.5/dist/worker/worker.mjs";

// Resolution order, exported so tests can pin "bundle first, CDN
// second" without re-deriving it from behavior.
export const FRAGMENTS_WORKER_SOURCES: readonly string[] = [
  FRAGMENTS_WORKER_BUNDLE_URL,
  FRAGMENTS_WORKER_CDN,
];

// ── Why the script is blob-wrapped ─────────────────────────────────
//
// We never hand a source URL straight to the Worker constructor. A
// cross-origin worker (jsdelivr / unpkg) is blocked by the browser's
// CORP check even when the CDN serves `CORP: cross-origin`, because
// the page is not using COEP/COOP. The robust workaround is the
// blob-URL pattern the library's own getWorker() uses internally:
// fetch the script ourselves, wrap it in a Blob, and hand the
// same-origin blob URL to `new Worker(url, { type: "module" })`.
//
// Fetching also doubles as the fallback trigger: if the bundled asset
// is missing (404 / no asset pipeline), we find out HERE, before the
// engine has a wedged worker to blame it on.

let workerBlobUrlPromise: Promise<string> | null = null;

async function fetchWorkerScript(): Promise<string> {
  let lastError: unknown = null;
  for (const url of FRAGMENTS_WORKER_SOURCES) {
    if (!url) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Worker fetch failed: ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("Fragments worker unavailable");
}

/**
 * Same-origin URL for the fragments worker script, safe to pass to
 * `FragmentsManager.init()`. Concurrent callers share one in-flight
 * fetch; a SUCCESSFUL result is reused across remounts.
 *
 * **A rejection is deliberately never cached.** The previous shape
 * cached the Promise before knowing its outcome and cleared it only
 * on success — so one transient network error poisoned the module
 * variable forever: every later mount in that tab awaited the same
 * already-rejected Promise, every model load failed, and the only way
 * back was a page reload. A failed attempt now leaves the slot empty
 * so the next mount retries. The identity check keeps a *concurrent*
 * sibling from clearing a handle that a later successful attempt has
 * already installed.
 */
export function getFragmentsWorkerBlobUrl(): Promise<string> {
  if (workerBlobUrlPromise) return workerBlobUrlPromise;
  const pending = (async () => {
    const text = await fetchWorkerScript();
    const blob = new Blob([text], { type: "application/javascript" });
    return URL.createObjectURL(blob);
  })();
  workerBlobUrlPromise = pending;
  pending.catch(() => {
    if (workerBlobUrlPromise === pending) workerBlobUrlPromise = null;
  });
  return pending;
}

/**
 * Drop the cached worker URL. For tests, and for any future hot-reload
 * path that needs the resolution order re-exercised. Takes no
 * reference on the blob URL, so callers that replace a SUCCESSFUL
 * cache entry should revoke it themselves if they care about it.
 */
export function resetFragmentsWorkerCache(): void {
  workerBlobUrlPromise = null;
}
