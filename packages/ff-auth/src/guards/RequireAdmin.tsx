import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isDemoAuth } from '../demo';
import { useAuth } from '../hooks/useAuth';
import { useAuthContext } from '../AuthProvider';
import { useDemoRole } from '../hooks/useDemoRole';

/**
 * Per plan v3 §2: settings (/) and users (/users) are admin-only routes.
 * Non-admins are redirected to /models (the app's entry module).
 *
 * Waits for auth + the membership listener before deciding — avoids the race where
 * the role hasn't arrived yet and the guard bounces a valid admin to
 * /models → /needs-invitation.
 *
 * Demo mode (plan v4 amendment v4.1): there is no sign-in, so the role
 * comes from the mocked "View as" toggle. A demo viewer is bounced to
 * /models exactly like a signed-in non-admin would be; a demo admin
 * passes straight through.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { project, memberships } = useAuthContext();
  const demoRole = useDemoRole();

  if (isDemoAuth()) {
    if (demoRole !== 'admin') {
      return <Navigate to="/models" replace />;
    }
    return <>{children}</>;
  }

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  // Phase 1b: the role is the membership role in the CURRENT project.
  // Still resolving → render nothing (never bounce a valid admin).
  if (memberships === undefined || project === undefined) {
    return null;
  }

  if (project?.role !== 'admin') {
    return <Navigate to="/models" replace />;
  }

  return <>{children}</>;
}
