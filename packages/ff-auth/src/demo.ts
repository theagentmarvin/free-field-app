/**
 * Demo mode — the mocked sign-in for the thesis demo.
 *
 * Per plan v4 (amendment v4.1, maintainer 2026-10-31 17:07):
 * "We need to mock the sign in for now and I need the functionality but no
 *  sign in needed — it's more like the role functionality that is important.
 *  Non-registered user will have no admin role but will be able to see the app."
 *
 * So the demo has exactly two roles and NO auth wall:
 *
 *   viewer (default) → read access to Documents / Models / Linkview
 *   admin            → + uploads, Settings, Users
 *
 * The admin role is unlocked with a one-click "View as" toggle (see
 * <LeftRail> in apps/settings), not with a sign-in form. The real Firebase
 * email-link auth stays in the codebase but is bypassed entirely while
 * `VITE_FF_DEMO_AUTH=true` — Wave B's claims/rules work is deferred,
 * not cancelled.
 *
 * Nothing in this module touches the network or Firebase.
 */

import { LEGACY_DEFAULT_PROJECT_ID } from '@ff/types';

/** The two roles the demo exposes. */
export type DemoRole = 'viewer' | 'admin';

/** localStorage key holding the demo role. */
export const DEMO_ROLE_STORAGE_KEY = 'ff-demo-role';

/** Window event fired whenever the demo role changes. */
export const DEMO_ROLE_CHANGED_EVENT = 'ff-demo-role-changed';

/**
 * Project id the demo pretends to be signed in to. It IS the legacy
 * local project id (`LEGACY_DEFAULT_PROJECT_ID`, @ff/types), so the
 * demo surfaces the locally-seeded Documents / Models / Linkview data
 * instead of an empty project. The one-time local re-key never runs in
 * demo mode, so this data is never moved away.
 */
export const DEMO_PROJECT_ID: string = LEGACY_DEFAULT_PROJECT_ID;

/**
 * Demo mode on/off. Single accessor — every demo branch in the codebase
 * goes through this so there is exactly one place to look.
 */
export function isDemoAuth(): boolean {
  return import.meta.env?.VITE_FF_DEMO_AUTH === 'true';
}

/**
 * Read-only demo. With `VITE_FF_DEMO_READONLY=true` (and demo mode on) the
 * "View as" switch is hidden and the role is always 'viewer', whatever is in
 * localStorage, so a public demo never offers uploads, Settings or Users.
 * Off by default: forks keep the switch unless they opt in.
 */
export function isDemoReadOnly(): boolean {
  return isDemoAuth() && import.meta.env?.VITE_FF_DEMO_READONLY === 'true';
}

/**
 * Current demo role. Defaults to 'viewer' (an unregistered visitor) when
 * nothing is stored — the demo must never start with admin rights.
 */
export function getDemoRole(): DemoRole {
  if (isDemoReadOnly()) return 'viewer';
  try {
    const stored = globalThis.localStorage?.getItem(DEMO_ROLE_STORAGE_KEY);
    return stored === 'admin' ? 'admin' : 'viewer';
  } catch {
    // Private mode / disabled storage — fall back to the safe default.
    return 'viewer';
  }
}

/**
 * Switch the demo role. Persists to localStorage and notifies every
 * subscriber (guards, nav, role-aware UI) via the
 * `ff-demo-role-changed` window event.
 */
export function setDemoRole(role: DemoRole): void {
  try {
    globalThis.localStorage?.setItem(DEMO_ROLE_STORAGE_KEY, role);
  } catch {
    // Storage unavailable — the in-memory role change still applies.
  }
  dispatchDemoRoleChanged();
}

/**
 * Subscribe to demo-role changes. Returns the unsubscribe function.
 * The callback receives the *new* role.
 */
export function subscribeDemoRole(cb: (role: DemoRole) => void): () => void {
  const target = globalThis.window;
  if (!target?.addEventListener) {
    return () => undefined;
  }
  const handler = () => cb(getDemoRole());
  target.addEventListener(DEMO_ROLE_CHANGED_EVENT, handler);
  return () => target.removeEventListener(DEMO_ROLE_CHANGED_EVENT, handler);
}

function dispatchDemoRoleChanged(): void {
  const target = globalThis.window;
  if (!target?.dispatchEvent) {
    return;
  }
  target.dispatchEvent(new Event(DEMO_ROLE_CHANGED_EVENT));
}
