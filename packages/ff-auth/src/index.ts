/**
 * @ff/auth — Firebase Auth wrapper for FreeField.
 *
 * Per plan v3:
 * - §5: Email-link only sign-in flow
 * - §6.1: AuthProvider + useAuth + useIsAdmin + guards
 * - §10 P0.3: tenant-check.ts runtime guard
 *
 * Per plan v4 (amendment v4.1) — demo mode:
 * - `demo.ts` + `useRole()`: the mocked sign-in and the two roles
 *   (viewer / admin) used when VITE_FF_DEMO_AUTH=true.
 */

export {
  AuthProvider,
  MembershipTimeoutError,
  MEMBERSHIP_TIMEOUT_MS,
  AuthConfigErrorScreen,
  useAuthContext,
  type AuthContextValue,
} from './AuthProvider';

export { useAuth, type AuthUser, type AuthClaims } from './hooks/useAuth';
export { useIsAdmin } from './hooks/useIsAdmin';
export {
  useCurrentProject,
  useCurrentProjectState,
  type CurrentProject,
} from './hooks/useCurrentProject';
export { useProjectId, useRequiredProjectId } from './hooks/useProjectId';
export { useProjectSelection } from './hooks/useProjectSelection';
export {
  PROJECT_CHOICE_KEY,
  readProjectHint,
  writeProjectHint,
  clearProjectHint,
  resolveCurrentProjectId,
  requireProjectId,
  NoActiveProjectError,
  type ProjectMembership,
  type ProjectSelection,
} from './projectSelection';
export { useRole, type Role } from './hooks/useRole';
export { useDemoRole } from './hooks/useDemoRole';

export { RequireAuth } from './guards/RequireAuth';
export { RequireAdmin } from './guards/RequireAdmin';
export { RequireProjectMember, ProjectLoadError } from './guards/RequireProjectMember';
export { BootLoading } from './guards/BootLoading';

export { runTenantCheck, TenantMismatchError } from './tenant-check';

// Demo mode — mocked sign-in (plan v4 amendment v4.1).
export {
  isDemoAuth,
  getDemoRole,
  setDemoRole,
  subscribeDemoRole,
  DEMO_ROLE_CHANGED_EVENT,
  DEMO_ROLE_STORAGE_KEY,
  DEMO_PROJECT_ID,
  type DemoRole,
} from './demo';
