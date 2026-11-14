import { useAuthContext } from '../AuthProvider';
import type { ProjectMembership } from '../projectSelection';

/**
 * The project picker / switcher surface (wave 65): the user's
 * memberships, THE current project id, and the actions to change it.
 * Both actions validate against `memberships` and return false for a
 * project the user does not belong to.
 */
export function useProjectSelection(): {
  memberships: ProjectMembership[] | undefined;
  currentProjectId: string | null | undefined;
  setCurrentProject: (id: string | null) => boolean;
  switchProject: (id: string) => boolean;
} {
  const { memberships, currentProjectId, setCurrentProject, switchProject } = useAuthContext();
  return { memberships, currentProjectId, setCurrentProject, switchProject };
}
