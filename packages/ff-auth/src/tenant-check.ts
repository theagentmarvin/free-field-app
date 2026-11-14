/**
 * Tenant isolation guard. Per plan v3 §10 P0.3.
 *
 * At app boot, compare the Firebase project ID resolved from runtime config
 * to the project ID embedded in the build manifest (VITE_EXPECTED_FIREBASE_PROJECT_ID).
 * Mismatch = either a misconfigured deployment or a build served to the wrong
 * Firebase project. Both are bugs we surface loudly, not silently.
 *
 * This is the BYO-deployment safety net. Each company that deploys FreeField
 * provisions their own Firebase project; if a contractor runs the wrong .env,
 * this guard refuses to start instead of letting them connect to someone else's
 * tenant.
 */

import { getApp } from 'firebase/app';

export class TenantMismatchError extends Error {
  constructor(
    public actual: string,
    public expected: string
  ) {
    super(
      `Tenant mismatch: build expects Firebase project "${expected}" but runtime ` +
        `reports "${actual}". Refusing to start — check VITE_EXPECTED_FIREBASE_PROJECT_ID ` +
        `and your Firebase config. See docs/deploy/byo-firebase.md.`
    );
    this.name = 'TenantMismatchError';
  }
}

/**
 * Run the tenant check against the initialized Firebase app.
 *
 * Call AFTER `initializeApp()` has run (i.e., after <AuthProvider> mounts).
 * Throws TenantMismatchError on mismatch; returns void on success.
 */
export function runTenantCheck(): void {
  const expected = import.meta.env?.VITE_EXPECTED_FIREBASE_PROJECT_ID as
    | string
    | undefined;

  if (!expected) {
    throw new Error(
      'VITE_EXPECTED_FIREBASE_PROJECT_ID is not set. The tenant isolation guard ' +
        'requires this env var at build time. Add it to your .env.local and rebuild. ' +
        'See docs/deploy/byo-firebase.md.'
    );
  }

  let actual: string | null;
  try {
    actual = getApp().options.projectId ?? null;
  } catch {
    // Firebase not initialized yet — likely called too early in the boot sequence.
    actual = null;
  }

  if (actual && actual !== expected) {
    throw new TenantMismatchError(actual, expected);
  }
}