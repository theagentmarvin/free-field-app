import { useAuthContext, useRole } from "@ff/auth";

/**
 * What the current session may do in the Tasks module.
 *
 *  - `isAdmin`   : membership role in the CURRENT project (useRole).
 *                  Only admins see hard delete; everyone else keeps
 *                  Discontinue.
 *  - `extendedFields`: priority / checklist / watchers. Always on in
 *                  demo; in the cloud they need the rules allowlist
 *                  from docs/integration/w69-tasks-rules.md, so they
 *                  stay off until `VITE_TASKS_EXTENDED_FIELDS=1`.
 *  - `hardDelete`: admin delete needs the rules change in the same doc
 *                  (`VITE_TASKS_HARD_DELETE=1`); demo: on.
 */
export interface TaskCapabilities {
  isAdmin: boolean;
  canWrite: boolean;
  extendedFields: boolean;
  hardDelete: boolean;
}

function envFlag(name: string): boolean {
  try {
    return (import.meta.env as Record<string, string | undefined>)[name] === "1";
  } catch {
    return false;
  }
}

export function resolveTaskCapabilities(
  role: string,
  isDemo: boolean,
  flags: { extended?: boolean; hardDelete?: boolean } = {}
): TaskCapabilities {
  const isAdmin = role === "admin";
  return {
    isAdmin,
    canWrite: role !== "anonymous",
    extendedFields: isDemo || !!flags.extended,
    hardDelete: isAdmin && (isDemo || !!flags.hardDelete),
  };
}

export function useTaskCapabilities(): TaskCapabilities {
  const role = useRole();
  const { isDemo } = useAuthContext();
  return resolveTaskCapabilities(role, isDemo, {
    extended: envFlag("VITE_TASKS_EXTENDED_FIELDS"),
    hardDelete: envFlag("VITE_TASKS_HARD_DELETE"),
  });
}

/**
 * `extendedFields` for components that may render outside an
 * <AuthProvider> (tests, embeds): false there instead of throwing. The
 * throw happens at the same hook position on every render, so hook order
 * stays stable.
 */
export function useExtendedFieldsEnabled(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useTaskCapabilities().extendedFields;
  } catch {
    return false;
  }
}
