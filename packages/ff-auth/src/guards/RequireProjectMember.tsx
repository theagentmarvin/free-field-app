import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isDemoAuth } from '../demo';
import { useAuth } from '../hooks/useAuth';
import { useAuthContext } from '../AuthProvider';
import { useCurrentProjectState } from '../hooks/useCurrentProject';
import { BootLoading } from './BootLoading';

/**
 * Gates member-consumption routes (documents, models, linkview).
 * States:
 *  1. signed-out → /sign-in
 *  2. signed-in without any membership (no invitation accepted yet) → /needs-invitation
 *  3. project listener failed → error screen with a Retry button
 *  4. memberships but no project chosen yet → nothing (the shell shows
 *     the project picker; wave 65)
 *  5. current project chosen → render children
 *
 * Demo mode (plan v4 amendment v4.1): the demo viewer IS a valid member
 * of the demo project, so this guard always lets the children through —
 * there is no sign-in wall in the demo.
 */
export function RequireProjectMember({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { project, error, retry } = useCurrentProjectState();
  const { memberships } = useAuthContext();

  if (isDemoAuth()) {
    return <>{children}</>;
  }

  if (loading) {
    return <BootLoading label="Signing you in…" />;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  if (error) {
    return <ProjectLoadError error={error} onRetry={retry} />;
  }

  // undefined means the Firestore listener hasn't fired yet.
  if (project === undefined || memberships === undefined) {
    return <BootLoading />;
  }

  if (memberships.length === 0) {
    return <Navigate to="/needs-invitation" replace />;
  }

  if (!project) {
    return null;
  }

  return <>{children}</>;
}

/** Shown when the current project document can't be read. */
export function ProjectLoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="project-load-error"
      style={{
        padding: 24,
        maxWidth: 480,
        margin: '10vh auto',
        fontFamily: 'var(--ff-font-stack, system-ui, sans-serif)',
        color: 'var(--ff-text-primary, #111)',
      }}
    >
      <h2 style={{ fontSize: 18, marginBottom: 8 }}>
        {(error as { code?: string }).code === 'membership-timeout'
          ? 'Can’t reach the server'
          : 'Couldn’t load your project'}
      </h2>
      <p style={{ marginBottom: 12, color: 'var(--ff-text-secondary, #555)' }}>{error.message}</p>
      <button
        type="button"
        data-testid="project-load-retry"
        onClick={onRetry}
        style={{ padding: '6px 14px', fontSize: 14, cursor: 'pointer' }}
      >
        Retry
      </button>
    </div>
  );
}
