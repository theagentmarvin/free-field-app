import { useAuthContext } from '../AuthProvider';
import type { CurrentProject } from '../types';

export type { CurrentProject };

/**
 * The current project: the membership matching the provider's ONE
 * `currentProjectId` (wave 65), with the name from a real-time
 * listener on the project document (one listener for the whole app).
 *
 * Returns:
 *   - undefined: still loading (or the project listener failed — see
 *     `useCurrentProjectState().error`)
 *   - null: user signed out, signed in without any membership
 *     (typically: no invitation accepted yet → /needs-invitation per
 *     plan v3 §5.1), or no project chosen yet (project picker)
 *   - CurrentProject: resolved project with id, role, name
 *
 * Demo mode (plan v4 amendment v4.1): the demo project is a constant,
 * no Firestore at all.
 */
export function useCurrentProject(): CurrentProject | null | undefined {
  return useAuthContext().project;
}

/**
 * The current project plus its listener error and a retry action, for
 * surfaces that need to show an error screen instead of a spinner.
 */
export function useCurrentProjectState(): {
  project: CurrentProject | null | undefined;
  error: Error | null;
  retry: () => void;
} {
  const { project, projectError, retryProject } = useAuthContext();
  return { project, error: projectError, retry: retryProject };
}
