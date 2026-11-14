import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isDemoAuth } from '../demo';
import { useAuth } from '../hooks/useAuth';

/**
 * Redirects unauthenticated users to /sign-in, preserving the intended
 * destination so /finish-sign-in can return them there after sign-in.
 *
 * Demo mode (plan v4 amendment v4.1): the demo has no sign-in at all, so
 * this guard never blocks — it renders its children.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (isDemoAuth()) {
    return <>{children}</>;
  }

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/sign-in" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}
