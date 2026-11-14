# `@ff/firestore`

Firestore schemas, typed collection refs, security rules, indexes, and Cloud Functions for FreeField user module.

**Phase 0 status:** scaffolded. Deploy + integration pending Architect wiring (see below).

## What this package owns

- **Schemas** — Zod-validated record shapes (User, Project, Role, Building, Folder, Member, Invitation, AuditLog)
- **Collection refs** — typed helpers (`usersCollection(db)`, `projectDoc(db, id)`, etc.) used by clients
- **Security rules** — `firestore.rules` (1 `get()` per access check, well under 10-op limit)
- **Indexes** — `firestore.indexes.json` (10 composite indexes for the actual query patterns)
- **Cloud Functions** — `bootstrapFirstAdmin` (Phase 0); `inviteMember`/`acceptInvite`/`onCreateProject` (Phase 1)

## What Architect needs to add during integration

1. **Cross-package refs in `apps/settings/package.json`:**
   ```json
   "@ff/firestore": "workspace:*"
   ```
2. **Cross-package refs in `apps/settings/tsconfig.json` + `vite.config.ts`:**
   ```json
   "paths": {
     "@ff/firestore": ["../../packages/ff-firestore/src"]
   }
   ```
3. **Cloud Functions runtime config** — Firebase project, region (`us-central1` default), Node 20.
4. **`firebase.json`** at repo root with Functions + Firestore + Hosting config (Phase 1+).

## Cloud Functions deploy

```bash
cd packages/ff-firestore/functions
npm run build
firebase deploy --only functions
```

## v3 plan refs

- §3.1-3.9 — Data model
- §4 — Security rules (verbatim in `firestore.rules`)
- §5.3 — Bootstrap flow
- §6.2 — Package layout (this package)
- §6.4 — Indexes (verbatim in `firestore.indexes.json`)
- §10 P0.5 — Audit log writes (server-side, `allow create: if false`)
- §10 P0.7 — Bootstrap singleton gate