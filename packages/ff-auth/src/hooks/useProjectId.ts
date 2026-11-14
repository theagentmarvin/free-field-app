import { useAuthContext } from '../AuthProvider';
import { NoActiveProjectError } from '../projectSelection';

/**
 * The current project id — THE one provider-level `currentProjectId`
 * owned by <AuthProvider> (wave 65) — or undefined while loading,
 * signed out, or before a project is chosen.
 *
 * Use it for READS (Dexie live queries, Firestore listeners): render
 * an empty state while it is undefined. For WRITES use
 * `useRequiredProjectId()` (render-time) or `requireProjectId(id)`
 * (inside a handler) — no project, no writes.
 *
 * Migration: the remaining `DEFAULT_PROJECT_ID = "default-project"`
 * sites are listed per file in docs/migration/dexie-v9.md.
 */
export function useProjectId(): string | undefined {
  return useAuthContext().currentProjectId ?? undefined;
}

/**
 * The current project id for a WRITE path. Throws `NoActiveProjectError`
 * when no project is active (caught by the module error boundary), so a
 * write can never fall back to a default / legacy project.
 *
 * Only use it in components rendered behind the shell's project gate;
 * components that also render without a project should read
 * `useProjectId()` and call `requireProjectId(id)` in the handler.
 */
export function useRequiredProjectId(): string {
  const id = useAuthContext().currentProjectId;
  if (!id) throw new NoActiveProjectError();
  return id;
}
