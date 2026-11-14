/**
 * Current-project selection (wave 65, Phase 1 foundation).
 *
 * <AuthProvider> owns ONE `currentProjectId` for the whole app. It is
 * chosen from the user's memberships and is the only source of truth
 * for "which project am I working in". localStorage keeps the last
 * choice as a HINT only: it is read once per signed-in uid, validated
 * against the memberships, and ignored when it does not match one.
 *
 * Resolution (see `resolveCurrentProjectId`):
 *   - memberships unknown (loading / listener error) → undefined
 *   - signed out                                     → null
 *   - selected id is a membership                    → that id
 *   - nothing explicitly chosen and exactly ONE
 *     membership                                     → that membership
 *   - otherwise                                      → null (picker)
 *
 * "Leave project" is an explicit null choice: it disables the
 * single-membership auto-pick until the next sign-in or reload.
 *
 * See docs/SPEC-PHASE-1.md §2.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** localStorage key holding the last chosen project id (a hint only). */
export const PROJECT_CHOICE_KEY = 'ff-project-choice';

/** One project the signed-in user belongs to. */
export interface ProjectMembership {
  id: string;
  role: string;
  /** Display name when known (project doc / membership index). */
  name?: string;
}

/** Selection state, keyed by uid so it can never leak across users. */
export interface ProjectSelection {
  uid: string | null;
  /** The id the user asked for (or the stored hint). */
  id: string | null;
  /** True once the user chose (or left) in this session. */
  explicit: boolean;
}

// ── hint storage (never throws — private mode kills localStorage) ────

export function readProjectHint(): string | null {
  try {
    return globalThis.localStorage?.getItem(PROJECT_CHOICE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeProjectHint(id: string): void {
  try {
    globalThis.localStorage?.setItem(PROJECT_CHOICE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function clearProjectHint(): void {
  try {
    globalThis.localStorage?.removeItem(PROJECT_CHOICE_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ── pure resolution ──────────────────────────────────────────────────

export function resolveCurrentProjectId(
  selection: ProjectSelection,
  memberships: readonly ProjectMembership[] | undefined
): string | null | undefined {
  if (selection.uid === null) return null;
  if (memberships === undefined) return undefined;
  if (selection.id !== null && memberships.some((m) => m.id === selection.id)) {
    return selection.id;
  }
  if (!selection.explicit && memberships.length === 1) return memberships[0].id;
  return null;
}

/** Thrown by `useRequiredProjectId()` / `requireProjectId()` on a write path with no project. */
export class NoActiveProjectError extends Error {
  constructor(message = 'No active project: choose a project before writing data.') {
    super(message);
    this.name = 'NoActiveProjectError';
  }
}

/**
 * Assert a project id for a write. Use inside event handlers / async
 * write paths that captured `useProjectId()` at render time.
 */
export function requireProjectId(projectId: string | null | undefined): string {
  if (!projectId) throw new NoActiveProjectError();
  return projectId;
}

// ── provider-side state hook ─────────────────────────────────────────

export interface ProjectSelectionApi {
  currentProjectId: string | null | undefined;
  /** Choose a project (or null = leave). Returns false when not a member. */
  setCurrentProject: (id: string | null) => boolean;
  /** Switch to another project the user belongs to. Returns false when not a member. */
  switchProject: (id: string) => boolean;
}

/**
 * The selection state machine shared by the demo and Firebase
 * providers. `uid` null = signed out. A uid change (sign-in, account
 * switch, demo role toggle) starts a fresh selection from the hint; a
 * sign-out (uid → null) also deletes the hint.
 */
export function useProjectSelectionState(
  uid: string | null,
  memberships: readonly ProjectMembership[] | undefined
): ProjectSelectionApi {
  const [selection, setSelection] = useState<ProjectSelection>(() => ({
    uid,
    id: uid ? readProjectHint() : null,
    explicit: false,
  }));

  let current = selection;
  if (selection.uid !== uid) {
    // Derived-state reset during render (React-sanctioned): the old
    // uid's choice must never be visible for the new uid.
    current = { uid, id: uid ? readProjectHint() : null, explicit: false };
    setSelection(current);
  }

  // Sign-out: forget the hint so the next user of a shared device
  // never inherits it.
  const prevUid = useRef(uid);
  useEffect(() => {
    if (prevUid.current !== null && uid === null) clearProjectHint();
    prevUid.current = uid;
  }, [uid]);

  // Cross-tab: another tab chose / left a project.
  useEffect(() => {
    if (uid === null) return;
    const target = globalThis.window;
    if (!target?.addEventListener) return;
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== null && e.key !== PROJECT_CHOICE_KEY) return;
      setSelection({ uid, id: readProjectHint(), explicit: true });
    };
    target.addEventListener('storage', onStorage);
    return () => target.removeEventListener('storage', onStorage);
  }, [uid]);

  const setCurrentProject = useCallback(
    (id: string | null): boolean => {
      if (uid === null) return false;
      if (id === null) {
        clearProjectHint();
        setSelection({ uid, id: null, explicit: true });
        return true;
      }
      if (!memberships?.some((m) => m.id === id)) {
        console.warn(`[ff-auth] refusing to select project "${id}": not a membership`);
        return false;
      }
      writeProjectHint(id);
      setSelection({ uid, id, explicit: true });
      return true;
    },
    [uid, memberships]
  );

  const switchProject = useCallback((id: string) => setCurrentProject(id), [setCurrentProject]);

  return {
    currentProjectId: resolveCurrentProjectId(current, memberships),
    setCurrentProject,
    switchProject,
  };
}
