// apps/settings/src/shell/projectChoice.ts
//
// Project access for the shell (wave 9 spec §B, rewired in wave 65).
//
// The current project is owned by <AuthProvider> (@ff/auth): ONE
// provider-level `currentProjectId`, validated against the user's
// memberships, cleared on sign-out. This module is now only the
// shell-side adapter: the picker/switcher option list and stable names
// for the existing call sites. `ff-project-choice` in localStorage is a
// hint the provider reads once per sign-in — never the source of truth.
//
// Demo mode: one membership (DEMO_PROJECT_ID) that the provider
// auto-selects, so the entry picker only appears after "Leave project".

import {
  DEMO_PROJECT_ID,
  PROJECT_CHOICE_KEY,
  clearProjectHint,
  isDemoAuth,
  readProjectHint,
  useProjectSelection,
  writeProjectHint,
} from "@ff/auth";

export { PROJECT_CHOICE_KEY };

export interface ProjectOption {
  id: string;
  name: string;
  /** two-letter avatar swatch */
  initials: string;
  /** one-line meta ("9 floors · 8 open tasks") when computable */
  meta: string | null;
}

// ── hint storage (re-exported from @ff/auth under the old names) ──────

export const readProjectChoice = readProjectHint;
export const writeProjectChoice = writeProjectHint;
export const clearProjectChoice = clearProjectHint;

/**
 * THE current project id (from @ff/auth): undefined while loading,
 * null when nothing is chosen (→ entry picker), the id otherwise.
 */
export function useProjectChoice(): string | null | undefined {
  return useProjectSelection().currentProjectId;
}

// ── initials ───────────────────────────────────────────────────────────

export function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** The projects the user can pick/switch to: the provider's
 *  memberships. Demo keeps its "Demo Tower" display name. */
export function useAvailableProjects(): ProjectOption[] {
  const { memberships } = useProjectSelection();
  if (!memberships) return [];
  const demo = isDemoAuth();
  return memberships.map((m) => {
    const name = demo && m.id === DEMO_PROJECT_ID ? "Demo Tower" : (m.name ?? "Project");
    return { id: m.id, name, initials: projectInitials(name), meta: null };
  });
}
