import { useSyncExternalStore } from 'react';

import { getDemoRole, subscribeDemoRole, type DemoRole } from '../demo';

/**
 * Subscribe to the demo role.
 *
 * `useSyncExternalStore` gives us the store semantics we want: the
 * component re-renders whenever `setDemoRole()` fires the
 * `ff-demo-role-changed` event, and the value is read fresh on every
 * render (never a stale closure).
 *
 * The subscribe callback is wrapped so it matches the
 * `useSyncExternalStore` signature (no arguments) while
 * `subscribeDemoRole` hands us the new role.
 */
function subscribeToDemoRole(onStoreChange: () => void): () => void {
  return subscribeDemoRole(() => onStoreChange());
}

/**
 * Current demo role as React state. Outside demo mode this simply mirrors
 * `getDemoRole()` (always 'viewer' unless something set it) — callers
 * gate on `isDemoAuth()` before treating it as meaningful.
 */
export function useDemoRole(): DemoRole {
  return useSyncExternalStore(subscribeToDemoRole, getDemoRole, getDemoRole);
}
