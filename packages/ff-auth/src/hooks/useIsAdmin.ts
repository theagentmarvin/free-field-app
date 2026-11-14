import { useAuthContext } from '../AuthProvider';

/**
 * Convenience hook: returns true if the current user is admin in their
 * CURRENT project (Phase 1b: the membership role of the provider's
 * `currentProjectId`, not a token claim). The 'admin' role bypasses all
 * readRoles checks per plan v3 §4 (implicit admin everywhere).
 */
export function useIsAdmin(): boolean {
  const { project } = useAuthContext();
  return project?.role === 'admin';
}
