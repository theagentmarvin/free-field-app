import { isDemoAuth } from '../demo';
import { useAuthContext } from '../AuthProvider';
import { useDemoRole } from './useDemoRole';

/**
 * Effective role of the current session.
 *
 * - 'admin'    → may upload, open Settings and Users
 * - 'viewer'   → read-only consumption (Documents / Models / Linkview)
 * - 'anonymous'→ signed out in the real (non-demo) app
 *
 * Demo mode (VITE_FF_DEMO_AUTH=true): the role comes from the mocked
 * sign-in toggle (`getDemoRole()`), never from Firebase.
 *
 * Real mode (Phase 1b): the role is the user's membership role IN THE
 * CURRENT PROJECT (the member doc, via the provider's membership
 * listener) — not a token claim, so it is per project and follows a
 * project switch or a demotion immediately. Admin stays admin; anybody
 * else who is signed in (including while the project is still resolving
 * or not yet chosen) is a 'viewer'.
 */
export type Role = 'admin' | 'viewer' | 'anonymous';

export function useRole(): Role {
  const demoRole = useDemoRole();
  const { user, project } = useAuthContext();

  if (isDemoAuth()) {
    return demoRole;
  }

  if (!user) {
    return 'anonymous';
  }

  return project?.role === 'admin' ? 'admin' : 'viewer';
}
