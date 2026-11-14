// postMortem/forensics.ts — stale-boot-flag detection + next-boot
// upload of the last persisted bundle (the "post-mortem" of a crashed
// session).
//
// On boot the seam calls `runPostMortem(deps)`. If the boot flag is
// STILL up (`ff.boot.v1` present — meaning the previous process died
// before clearing it), the last persisted bundle is read (IDB first,
// localStorage fallback), shipped through an injected reporter EXACTLY
// ONCE, and — only on a successful ack — the flag + bundle are cleared.
// On any failure the flag + bundle are left in place so the NEXT boot
// retries the upload (spec §5.3).
//
// The reporter is injected to keep this module Sentry-free and
// unit-testable: the U1/U7 seam wires a reporter that forwards the
// payload to `Sentry.captureMessage("launch-crash-last-run", { level:
// "error", attachments: [...] })`. No `@sentry/browser` import here.
//
// Survivability law: every body is safe()-wrapped or an explicit
// try/catch (safe() cannot catch async rejections), the returned
// Promise NEVER rejects, and there is no DOM / `three` at module load.

import { safe } from "../safe";
import { getRendererReport, type ModelBuffers } from "../modelBuffers";
import type { TelemetryBundle } from "../telemetry";
import {
  BOOT_FLAG_KEY,
  type BundleStorage,
  type TelemetryStorage,
} from "../boot";

/** The injected post-mortem upload sink. The U1 seam implements this
 *  as a Sentry `captureMessage` (level `error`) carrying the bundle +
 *  renderer report as attachments. */
export interface PostMortemReporter {
  report(bundle: TelemetryBundle, rendererReport: string): Promise<void> | void;
}

/** Dependencies for {@link runPostMortem} — every side-effect is
 *  injected so the unit test stays deterministic and Sentry-free. */
export interface PostMortemDeps {
  /** Synchronous boot-flag read (localStorage — spec §5.3). */
  readFlag(): string | null;
  /** Read the last persisted bundle (IDB → localStorage fallback). */
  readBundle(): Promise<TelemetryBundle | null>;
  /** Clear the boot flag. */
  clearFlag(): void;
  /** Clear the persisted bundle (IDB + localStorage). */
  clearBundle(): Promise<void> | void;
  /** Build the renderer report text from the bundle. Optional — a
   *  default (header + snapshots) is provided. */
  buildReport?(bundle: TelemetryBundle): string;
  /** The injected reporter. */
  reporter: PostMortemReporter;
}

/** An inert empty ModelBuffers registry so `getRendererReport` can be
 *  reused against a persisted bundle (which has snapshots but no live
 *  per-model ring buffers — those are in-memory only by design). */
const EMPTY_BUFFERS: ModelBuffers = {
  open: () => {
    /* no-op */
  },
  close: () => {
    /* no-op */
  },
  has: () => false,
  record: () => {
    /* no-op */
  },
  get: () => undefined,
  openModelIds: () => [],
  count: () => 0,
};

/** Render the post-mortem renderer-report analog from a persisted
 *  bundle (deviceLostCount + snapshots; per-model buffers are absent).
 *  Byte-stable via the shared `getRendererReport` formatter. */
export function buildRendererReportFromBundle(
  bundle: TelemetryBundle,
): string {
  return (
    safe(() => {
      return getRendererReport({
        deviceLostCount: bundle?.deviceLostCount ?? 0,
        buffers: EMPTY_BUFFERS,
        snapshots: bundle?.snapshots ?? [],
      });
    }, "buildRendererReportFromBundle failed") ?? ""
  );
}

/** Read the last bundle from a `BundleStorage` as a parsed bundle (or
 *  null). The returned Promise NEVER rejects — parse failures resolve
 *  to null (spec §9 risk 1: no unhandled rejections in the IDB path). */
export function readBundleFromStorage(
  storage: BundleStorage,
): Promise<TelemetryBundle | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: TelemetryBundle | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      storage.read((json) => {
        if (typeof json !== "string" || json.length === 0) {
          done(null);
          return;
        }
        const parsed = safe(
          () => JSON.parse(json) as TelemetryBundle,
          "parse last bundle failed",
        );
        done(parsed ?? null);
      });
    } catch {
      // A throwing read (bad injected storage) resolves as "no bundle".
      done(null);
    }
  });
}

/** Clear the persisted bundle from a `BundleStorage`, never throwing. */
export async function clearBundleFromStorage(
  storage: BundleStorage,
): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        storage.clear(done);
      } catch {
        done();
      }
    });
  } catch {
    // never throws
  }
}

/** Build the full post-mortem deps from the two storage layers + a
 *  reporter. Convenience for the initTelemetry/U7 seam. */
export function createPostMortemDeps(
  flagStore: TelemetryStorage,
  bundleStorage: BundleStorage,
  reporter: PostMortemReporter,
  buildReport?: (bundle: TelemetryBundle) => string,
): PostMortemDeps {
  return {
    readFlag: () => flagStore.getItem(BOOT_FLAG_KEY),
    readBundle: () => readBundleFromStorage(bundleStorage),
    clearFlag: () => {
      if (typeof flagStore.removeItem === "function") {
        flagStore.removeItem(BOOT_FLAG_KEY);
      } else {
        flagStore.setItem(BOOT_FLAG_KEY, "");
      }
    },
    clearBundle: () => clearBundleFromStorage(bundleStorage),
    ...(buildReport ? { buildReport } : {}),
    reporter,
  };
}

/** Await a maybe-async result (Promise or void), never throwing. */
async function settle(result: Promise<void> | void): Promise<void> {
  try {
    await result;
  } catch {
    // swallow — the caller's outer guard also covers this
  }
}

/**
 * Run the launch-crash post-mortem.
 *
 * - Clean boot (flag cleared) → no-op.
 * - Stale flag, no bundle → clear the flag (nothing to upload — avoid
 *   a re-upload of "nothing" on every subsequent boot).
 * - Stale flag + bundle → `reporter.report(bundle, report)` exactly
 *   once; on ack clear flag + bundle; on any failure leave both for the
 *   next boot's retry.
 *
 * Never throws: the returned Promise always resolves.
 */
export async function runPostMortem(deps: PostMortemDeps): Promise<void> {
  try {
    const flag = safe(() => deps.readFlag(), "postMortem readFlag failed");
    if (!flag) return; // clean boot

    const bundle = await deps.readBundle();
    if (!bundle) {
      safe(() => deps.clearFlag(), "postMortem clearFlag (no bundle) failed");
      return;
    }

    const report =
      safe(
        () => (deps.buildReport ?? buildRendererReportFromBundle)(bundle),
        "postMortem buildReport failed",
      ) ?? "";

    // Exactly-once upload: ack = reporter resolved (returned void or a
    // fulfilled Promise). Any sync throw or rejected Promise leaves the
    // flag + bundle for the next boot.
    let acknowledged = false;
    try {
      await deps.reporter.report(bundle, report);
      acknowledged = true;
    } catch {
      acknowledged = false;
    }

    if (acknowledged) {
      safe(() => deps.clearFlag(), "postMortem clearFlag failed");
      await settle(deps.clearBundle());
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[ff-telemetry] runPostMortem failed:", err);
  }
}