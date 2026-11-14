# `@free-field/users`

FreeField user module — admin UI for member management, roles, and read access. Also hosts the public auth pages (`/sign-in`, `/finish-sign-in`, `/needs-invitation`).

**Phase 0 status:** scaffolded. Routes wired in MainShell. Real member/role/audit UI lands in Phase 1.

## What this app owns

**Admin-only routes (`<RequireAdmin>` in MainShell):**
- `/users` — UsersApp root, MemberListPage (Phase 1)
- `/users/invite` — InvitePage (Phase 1)
- `/users/roles` — RolesPage (Phase 1)
- `/users/roles/:roleId` — RoleEditorPage (Phase 1)
- `/users/audit` — AuditLogPage (Phase 1)

**Public routes (no auth required):**
- `/sign-in` — email entry, sends sign-in link
- `/finish-sign-in` — handles `oobCode`, completes sign-in, branches by claims
- `/needs-invitation` — landing for signed-in users without project membership

## What Architect needs to add during integration

Per `ORCHESTRATION-RULES.md` rule #1, the following changes to `apps/settings/` are Architect territory during integration:

1. **`apps/settings/package.json`** — add workspace dep:
   ```json
   "@free-field/users": "workspace:*"
   ```
2. **`apps/settings/tsconfig.json`** — add path alias:
   ```json
   "@free-field/users": ["../users/src"]
   ```
3. **`apps/settings/vite.config.ts`** — same alias as Vite resolve config.
4. **`apps/settings/src/shell/MainShell.tsx`** — Butler already wrote the v3 route structure on the butler branch (this commit). Architect reviews during integration.

## Files in Phase 0 scaffold

| File | Purpose |
|---|---|
| `src/UsersApp.tsx` | Root, mounted at `/users`. Phase 0 placeholder. |
| `src/auth/SignInPage.tsx` | `/sign-in` — email entry + `signInWithEmailLink` |
| `src/auth/FinishSignInPage.tsx` | `/finish-sign-in` — handles `oobCode` + claim-based redirect |
| `src/auth/NeedsInvitationPage.tsx` | `/needs-invitation` — self-invite landing |
| `__tests__/setup.ts` | jsdom + fake-indexeddb + jest-dom |

## v3 plan refs

- §2 — Module structure (admin-only vs public routes)
- §5.1 — Sign-in flow (email-link only)
- §5.2 — Invite flow
- §6.3 — Package layout (this app)
- §7 — UI structure (LeftRail filters by role)