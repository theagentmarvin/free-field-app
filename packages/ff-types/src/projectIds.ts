// packages/ff-types/src/projectIds.ts
//
// The ONE runtime constant in @ff/types (wave 65, Phase 1 foundation).
// It lives here because every layer needs it and @ff/types has no
// dependencies: @ff/auth (demo project id), @ff/data (the one-time
// local re-key) and the apps (until the per-module lift lands).

/**
 * The project id every local Dexie row was written under before
 * Phase 1 (one implicit project per browser). Rows still carrying it
 * are moved to the user's first real project by `rekeyLegacyProjectData`
 * in @ff/data. Demo mode keeps using it as its project id
 * (`DEMO_PROJECT_ID` in @ff/auth) so the seeded demo data stays put.
 *
 * See docs/SPEC-PHASE-1.md §7 (migration of existing local data).
 */
export const LEGACY_DEFAULT_PROJECT_ID = "default-project";
