# `@ff/auth`

Firebase Auth wrapper for FreeField. Email-link sign-in + custom claims + route guards.

**Phase 0 status:** scaffolded. Full integration pending Architect dep wiring (see below).

## What this package owns

- Firebase initialization (`<AuthProvider>`)
- Current user + custom claims (`useAuth`, `useIsAdmin`, `useCurrentProject`)
- Route guards (`RequireAuth`, `RequireAdmin`, `RequireProjectMember`)
- Tenant isolation guard (`runTenantCheck`, per plan v3 §10 P0.3)

## What Architect needs to add during integration

Per `ORCHESTRATION-RULES.md` rule #1 (Architect owns shared config), the following dependencies must be added at integration time:

1. **Cross-package refs in `apps/settings/package.json`:**
   ```json
   "@ff/auth": "workspace:*"
   ```
2. **Cross-package refs in `apps/settings/tsconfig.json` + `apps/settings/vite.config.ts`:**
   ```json
   "paths": {
     "@ff/auth": ["../../packages/ff-auth/src"]
   }
   ```
3. **Firebase peer-dep** at apps/settings: `firebase: ^11.0.0` (already there if Architect chose so; confirm version alignment).

## Files in Phase 0 scaffold

| File | Purpose |
|---|---|
| `src/AuthProvider.tsx` | Firebase init from VITE_FIREBASE_* env vars |
| `src/hooks/useAuth.ts` | Current user + custom claims, refreshed on sign-in |
| `src/hooks/useIsAdmin.ts` | Convenience: `currentRole === 'admin'` |
| `src/hooks/useCurrentProject.ts` | Resolves `currentProject` claim + real-time project doc listener |
| `src/guards/RequireAuth.tsx` | Redirects signed-out to `/sign-in` |
| `src/guards/RequireAdmin.tsx` | Redirects non-admin to `/documents` |
| `src/guards/RequireProjectMember.tsx` | Three-state gate (signed-out / no-invitation / member) |
| `src/tenant-check.ts` | Compares runtime Firebase project ID to build manifest (P0.3) |

## v3 plan refs

- §5 — Auth flows (email-link only)
- §6.1 — Package layout (this package)
- §10 P0.3 — Tenant isolation guard
- §10 P0.5 — Custom claims token refresh