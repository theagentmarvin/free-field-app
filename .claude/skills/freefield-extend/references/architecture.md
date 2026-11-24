# FreeField architecture map (for extending it)

Read this before you plan a change. Every path below exists in this repo. When code and this file disagree, the code wins. Fix this file in the same change.

## Contents
1. [The big picture](#1-the-big-picture)
2. [Workspaces](#2-workspaces)
3. [Where the UI lives](#3-where-the-ui-lives)
4. [Where data lives: the decision that matters most](#4-where-data-lives)
5. [Who may write what (roles and rules)](#5-who-may-write-what)
6. [Local or synced? A decision guide](#6-local-or-synced)
7. [Boundaries and lint rules](#7-boundaries-and-lint-rules)
8. [Demo mode and the demo seed](#8-demo-mode-and-the-demo-seed)
9. [Environment flags](#9-environment-flags)
10. [Cloud Functions](#10-cloud-functions)
11. [Known drift and gaps](#11-known-drift-and-gaps)

---

## 1. The big picture

- **One web app, many modules.** `apps/settings` is the *host*. Its Vite build bundles every module (Models, Documents, LinkView, Tasks, Users, Settings) into a single origin, and that is what gets deployed (`firebase.json` → hosting `public: apps/settings/dist`).
- **Local-first.** IFC models, PDFs, calibrations and saved views start in the browser (IndexedDB via Dexie, database name `free-field`). IFC is converted to `.frag` in a Web Worker in the browser.
- **Publishing.** In a signed-in project, an admin can **publish** buildings through `ProjectSyncMount` (`packages/ff-tasks-react/src/ProjectSyncMount.tsx`, running `@ff/sync`). From then on, the converted models, PDFs and calibrations (plus folders and saved views) sync to the company's Firestore + Storage for the whole team (§4b). Tasks, projects and members always live in Firestore. Demo mode keeps everything in the browser. The original `.ifc` is not uploaded.
- **Optional backend.** Each company runs its own Firebase project: Auth (email link), Firestore, Storage, Functions and Hosting. Without one, the app runs in **demo mode** (`VITE_FF_DEMO_AUTH=true`) with no sign-in and no backend.
- **Stack.** TypeScript 5.6 strict, React 18, Vite 5, pnpm 10 workspaces + Turborepo, Vitest, Dexie 4, Firebase 11, zod. The 3D stack is `@thatopen/components` / `@thatopen/fragments` 3.6.0 (pinned exactly and patched via `patches/`) on three.js, plus `web-ifc` WASM served locally.

## 2. Workspaces

`pnpm-workspace.yaml` includes `apps/*` and `packages/*`. Short names work with `--filter` (`pnpm --filter settings …`, `pnpm --filter tasks-react …`). Full names are safer.

### Apps

| Path | Package | What it is |
|---|---|---|
| `apps/settings` | `@free-field/settings` | **Host app.** Routing shell, left rail, demo mode, demo seed, and the Settings module itself: buildings, IFC/PDF upload, Get Levels, calibration wizard, `.ffbundle` import from the Revit exporter (`src/bundle/`). It owns `dev`, `build`, `lint:drift`. |
| `apps/models` | `@free-field/models` | 3D viewer module (`ModelsApp`) and the persistent viewer surface the shell keeps alive across routes. |
| `apps/documents` | `@free-field/documents` | PDF reader (`DocumentsApp`), plan measuring, tasks on plans, and **Compare revisions** in `src/compare/`. Compare is the best example of a self-contained feature: a pure `engine/`, a `compareStore.ts`, `ui/`, `viewer/`, `csv.ts`, and tests in `__tests__/compare/`. |
| `apps/linkview` | `@free-field/linkview` | Plan ↔ 3D split view (`LinkviewApp`). |
| `apps/users` | `@free-field/users` | Members/invites admin UI (`UsersApp`) and the public auth pages (`SignInPage`, `FinishSignInPage`, `NeedsInvitationPage`). Callable wrappers live in `src/api.ts`. |
| `apps/hybrid` | `@free-field/hybrid` | Placeholder for a future mobile shell. It has no tests and isn't used by the web app. |

The module apps have no dev server of their own. They are imported by `apps/settings` (see `apps/settings/vite.config.ts` aliases and `apps/settings/tsconfig.json` paths).

### Packages

| Path | Package | What it holds | Notes |
|---|---|---|---|
| `packages/ff-types` | `@ff/types` | Shared record types for the Dexie rows (`src/project.ts`), outbox/draft/sync types (`src/tasks.ts`), filter presets, viewpoints, `LEGACY_DEFAULT_PROJECT_ID`. | Types only, no deps. |
| `packages/ff-data` | `@ff/data` | **The Dexie database** (`src/db/database.ts`), table accessors (`src/db/tables/*.ts`), the IFC pipeline (`src/ifc/`, `src/pipeline/`), calibration math, and React hooks (`@ff/data/hooks`). | One app-wide `db` singleton. |
| `packages/ff-firestore` | `@ff/firestore` | **Firestore zod schemas** (`src/schema/*.ts`), typed refs (`src/refs/`), **security rules** (`firestore.rules`), indexes (`firestore.indexes.json`), Storage path helpers, and **Cloud Functions** (`functions/src/`, own `package.json`, Node 22). | Rules tests live in `__tests__/rules*.test.ts` and need the emulator. Storage rules are at repo root `storage.rules`. |
| `packages/ff-tasks` | `@ff/tasks` | Headless task data plane: **status machine** (`status.ts`), actions (`action.ts`), field model and edit diff (`taskFields.ts`), outbox engine (`outbox.ts`), cloud repository (`repository.ts`), optimistic merge (`merge.ts`), drafts (`drafts.ts`), demo task store (`demoTaskDb.ts`, `demoTaskSource.ts`), demo seed (`demoSeed.ts`), **BCF writer** (`bcf/`). | No React. |
| `packages/ff-tasks-react` | `@ff/tasks-react` | All Tasks UI: `TasksApp.tsx`, list/table/board (`TasksListPanel`, `TaskTablePanel`, `TaskBoardPanel`), detail (`TaskDetailHost` + `TaskDetailView`), compose (`TaskComposeSheet` + `composeModel.ts`), **table columns** (`tableColumns.ts`), **CSV + printed report** (`exportTasks.ts`, `printDocument.ts`), BCF glue (`bcfExport.ts`), status labels and type list (`logic.ts`), task palette (`formStyles.ts`), capability flags (`capabilities.ts`), and `ProjectSyncMount.tsx` (starts the sync engine). | **No `lint` script**, so ESLint doesn't cover it. Typecheck and tests do. |
| `packages/ff-sync` | `@ff/sync` | Headless sync engine for the local-first content: Dexie ↔ Firestore/Storage, outbox drain, down-sync listeners, blob transfer. Table map in `src/tables.ts`. | No `lint` script. Emulator suite in `__tests__/emulator`. |
| `packages/ff-auth` | `@ff/auth` | `AuthProvider` (initialises Firebase once and runs the tenant check), `useRole`, `useIsAdmin`, `useProjectId` / `useRequiredProjectId` / `requireProjectId`, guards (`RequireAdmin`, `RequireProjectMember`), and demo helpers (`isDemoAuth`, `DEMO_PROJECT_ID`, demo role). | |
| `packages/ff-viewer` | `@ff/viewer` | Headless 3D core plus PDF page rendering. | The engine is allowed to use three.js. |
| `packages/ff-viewer-react` | `@ff/viewer-react` | `<IfcViewer>`, `<PdfOverlay>`, picking, perf, measure. | |
| `packages/ff-viewer-tools` | `@ff/viewer-tools` | Selection, filters, properties panel, plan measure (`./pdf-measure`), shared tool stores, `useIsMobile`. | |
| `packages/ff-telemetry` | `@ff/telemetry` | Local crash forensics and optional error reporting (only if a DSN is configured). | |
| `packages/ff-tooling` | `@ff/tooling` | Shared Vite snippets (`vite.config.base.js`). | |

## 3. Where the UI lives

- **Entry:** `apps/settings/src/main.tsx` mounts `MainShell`, redirects `/` to `/models` on first load (`shell/entryRoute.ts`), and imports `styles/global.css`, which pulls in `styles/tokens.css`.
- **Routes:** `apps/settings/src/shell/MainShell.tsx`. Each module is a `lazy(() => import(...))` wrapped in `<ModuleRoute label="…">` and a guard:
  - `/` Settings and `/users/*` Users are behind `RequireAdmin`.
  - `/models`, `/documents`, `/linkview`, `/tasks` are behind `RequireProjectMember`.
  - `/sign-in`, `/finish-sign-in`, `/needs-invitation` are public. In demo mode they redirect to `/`.
- **Left rail / phone tab bar:** `apps/settings/src/shell/LeftRail.tsx`. The `ITEMS` array holds `to`, `label`, an `iconoir-react` icon, and `adminOnly`. The `ActiveRoute` type and the `activeRoute` `useMemo` decide which icon lights up, by comparing against `item.label.toLowerCase()`. The demo "View as: Viewer | Admin" switch lives here too.
- **Header / logo:** `apps/settings/src/components/Header.tsx` and `apps/settings/src/shell/FreeFieldMark.tsx`. Brand files are in `apps/settings/public/brand/`. Favicons are `apps/settings/public/favicon.svg`, `favicon-32.png` and `apple-touch-icon.png`, referenced by `apps/settings/index.html` (`<title>FreeField</title>`). The sign-in page uses `/brand/freefield-mark.svg` (`apps/users/src/auth/SignInPage.tsx`).
- **Styling:** CSS custom properties in `apps/settings/src/styles/tokens.css` (`--ff-*`). The Tasks UI uses a separate TS palette, `tokens` and `STATUS_HEX` in `packages/ff-tasks-react/src/formStyles.ts`. The chip tones (`PRIORITY_TONE`, `DEADLINE_TONE`) are in `TaskChips.tsx`. Task types have no colour map. Much of the UI uses inline `style={{…}}` objects, and there are roughly 350 hard-coded hex colours in `src/` across workspaces. There is no CSS framework and no theme switch.
- **Text:** inline English strings in components. There is **no i18n library**, and `apps/settings/index.html` has `lang="en"`.
- **Mobile:** the same components. `useIsMobile()` (`@ff/viewer-tools`) switches layouts at 767px, and the rail becomes a bottom tab bar.

## 4. Where data lives

There are three stores. Most design mistakes come from picking the wrong one.

### 4a. Local browser database (Dexie, `packages/ff-data/src/db/database.ts`)

DB name `free-field`. Tables by schema version:

| Version | Tables |
|---|---|
| v1 | `projects`, `buildings`, `ifcFiles`, `ifcVersions`, `storeys`, `extractedStoreys`, `fragBlobs` |
| v2 | `buildingLevelSelection` |
| v3 | `pdfFiles`, `pdfVersions`, `pdfBlobs` |
| v4 | `calibrations` |
| v5 | `propertyCatalog` |
| v6 | `filterPresets` |
| v8 | `pdfFolders`, `pdfFolderAssignments` (v7 unused) |
| v9 | `outbox` (queued task actions + sync jobs), `drafts` (task compose crash-recovery) |
| v10 | `viewerViewpoints` |
| v11 | `syncState` (sync cursors; local only) |

Rules for changing it:
- A new table or a new **index** means adding `this.version(12).stores({...})`, then 13, and so on. **Never edit an existing version block.** A new *non-indexed* field on an existing table needs no Dexie change at all, only the TypeScript type in `@ff/types`.
- Row types live in `packages/ff-types/src/project.ts`. Accessors live in `packages/ff-data/src/db/tables/<table>.ts`.
- If another tab has an older schema open, `installDatabaseLifecycle` shows a reload banner (`apps/settings/src/shell/DatabaseUpdateBanner.tsx`).
- Clearing the site data wipes everything local.

### 4b. Synced project content (Phase 1c/1d, `packages/ff-sync`)

When signed in, `ProjectSyncMount` (`packages/ff-tasks-react/src/ProjectSyncMount.tsx`, mounted in `MainShell.tsx` outside demo mode) runs the sync engine for the current project. An admin gets a one-time "Publish N local buildings" prompt. After that, these Dexie tables mirror to `projects/{pid}/<collection>` in Firestore, and their blobs go to Storage under `projects/{pid}/{ifc,frag,pdf}/…`:

| Dexie table | Firestore collection | zod schema |
|---|---|---|
| `buildings` | `buildings` | `src/schema/building.ts` |
| `pdfFolders` / `pdfFolderAssignments` | `folders` / `folderAssignments` | `src/schema/folder.ts` |
| `ifcFiles`, `ifcVersions`, `storeys`, `extractedStoreys`, `pdfFiles`, `pdfVersions`, `calibrations`, `viewerViewpoints` | same names (`viewerViewpoints` → `viewpoints`) | `src/schema/sync.ts` |

The mapping is `packages/ff-sync/src/tables.ts`. Field names are identical between the Dexie row and the Firestore doc, plus the server-owned base `updatedAt`/`updatedBy`/`deletedAt`/`schema` (`src/schema/syncBase.ts`). A compile-time parity check, `packages/ff-firestore/__tests__/rowParity.types.ts`, fails `pnpm typecheck` when a row type and its doc schema drift apart.

**Strict rules.** Each synced collection's rule uses `hasExactly(keys())`: the doc must carry *all* listed keys and no others. Adding a field therefore means updating the `@ff/types` row type, the zod schema, the `keys()` list and `valid()` in `firestore.rules`, and possibly `defaults` in `ff-sync/src/tables.ts`. Rules and client must also be deployed together, because old clients will be denied. Prefer existing escape hatches: `BuildingRecord.metadata` is a free `Record<string, unknown>` that the rules only check is a map.

Hard deletes are denied. Deletes are tombstones (`deletedAt`).

### 4c. Tasks (cloud-first, `packages/ff-tasks` + `packages/ff-tasks-react`)

Tasks are **not** in the `free-field` Dexie DB.
- **Signed in:** each user action becomes an outbox row (Dexie `outbox`). `commitTaskAction` (`packages/ff-tasks/src/repository.ts`) then commits it in one Firestore transaction: the task doc `projects/{pid}/tasks/{taskId}`, an append-only entry in `…/entries/{clientGuid}`, and the counter `projects/{pid}/taskCounters/tasks` on create. Reads come from Firestore's own offline cache. Photos and location snapshots go to Storage at `projects/{pid}/tasks/{taskId}/…`.
- **Demo:** the same actions commit into a **separate** Dexie DB (`DemoTaskDatabase`, `packages/ff-tasks/src/demoTaskDb.ts`). Each row stores the whole task object, so a new field needs no change there.
- **Shape:** `TaskSchema` in `packages/ff-firestore/src/schema/task.ts`, which is the `Task` type everyone uses. Optional additive fields (`priority`, `checklist`, `watchers`, `sheetRefs`) are the pattern to copy.
- **Edits are verbs, not raw writes.** The client sends `create`, `comment`, `edit`, `assign`, `complete`, `reject`, `approve`, `followup` or `discontinue` (`status.ts`). `edit` carries a sparse `patch` built by `buildEditPatch()` (`taskFields.ts`). Every action appends exactly one timeline entry, and the rules check `entryCount` grows by one.
- **Statuses:** 10 Inbox, 20 Ongoing, 30 Rejected (reserved, unreachable), 40 Awaiting approval, 60 Follow-up, 65 Approved (terminal), 80 Discontinued (terminal). Legal moves are listed in `PAIRS` in `status.ts` **and** in `legalTaskTransition()` in `firestore.rules`. A test (`packages/ff-tasks/__tests__/status.test.ts`) reads the rules file and checks they match.
- **Types:** a free string on the doc. The UI vocabulary is `TYPE_OPTIONS` in `packages/ff-tasks-react/src/logic.ts` (Defect, RFI, Snag, Safety, Info, Other). Changing it needs no rules change.

### 4d. Members, invitations, projects, audit log

Firestore under `projects/{pid}/members`, `invitations`, `auditLog`, plus `/users/{uid}` profiles. **All writes go through Cloud Functions** (Admin SDK). Client writes are `allow write: if false`. Don't add client writes here. Add or extend a callable instead.

### 4e. Browser-only preferences (`localStorage`)

Examples: `ff-demo-role`, `ff-project-choice` (a hint only), `ff-task-columns` (table column picker), `ff-demo-seeded-v2`. Use `localStorage` for per-person UI preferences that nobody else needs. Wrap reads in try/catch, as the existing code does.

## 5. Who may write what

From `packages/ff-firestore/firestore.rules` and `storage.rules`:

| Data | Read | Write |
|---|---|---|
| `projects/{pid}` doc and synced content collections | any active member | **admin only**, exact keys, tombstone deletes |
| `tasks`, `tasks/*/entries`, `taskCounters` | any active member | **any active member** (legal transitions, allowlisted keys, immutable `num`/`createdBy*`/`createdAt`, no delete) |
| `members`, `invitations`, `auditLog`, `meta` | member / admin | Cloud Functions only |
| Storage task photos | member | member creates (images only), admin deletes |
| Storage `ifc`/`frag`/`pdf` blobs | member | admin creates, immutable |

Roles come from the member doc (`role: 'admin' | 'member'`), read client-side by `useRole()` / `useIsAdmin()` in `@ff/auth`. Demo mode fakes the role with "View as". A rule that limits one task field to admins can look like this:

```
&& (isAdmin(pid) || !request.resource.data.diff(resource.data).affectedKeys().hasAny(['myField']))
```

Add it to the `allow update` of `match /tasks/{taskId}`, and hide the editor in the UI for non-admins.

## 6. Local or synced

| The user says… | Store | Why |
|---|---|---|
| "The team should see it", "on site on the tablet too", "the manager approves it" | **Synced**: a task field (4c), or a synced collection (4b) when it belongs to a building/plan/model | Other people and devices need it |
| "Just for me", "my view", "remember my columns" | `localStorage` (4e) | Personal and per device |
| "Attach to the model/plan, stays on this PC until we publish" | Dexie (4a). It syncs automatically once published, if it's in a synced table | Local-first content |
| "Send to / receive from our ERP" | A Cloud Function (section 10) reading or writing Firestore | Secrets and network access belong server-side |

Default to the smallest store that meets the need, and tell the user the trade-off in one sentence.

## 7. Boundaries and lint rules

- **No raw three.js outside the engine.** Every ESLint config has `no-restricted-imports` for `three` and `three/*` (for example `apps/settings/.eslintrc.json`). Use the viewer packages' APIs.
- **Engine drift check** (`lint:drift`): `apps/settings/scripts/toe-drift-check.js` greps for patterns that bypass the 3D engine (raw renderer/camera/raycaster creation, private picker internals outside `packages/ff-viewer-react/src/picking/idPassInterop.ts`, and so on). The script exists in `apps/settings`, `apps/users`, `ff-auth`, `ff-data`, `ff-telemetry`, `ff-viewer`, `ff-viewer-react` and `ff-viewer-tools`. **Caveat:** it silently does nothing on Windows or on paths with spaces (see verify.md for the workaround), and CI doesn't run it.
- **Apps don't import each other's source.** Shared code goes in `packages/*` (`docs/architecture/scaling-rules.md` §1.2, §2). The host `apps/settings` imports module apps by design. `apps/documents` also depends on `@free-field/models` for the shared viewer surface, but don't add new cross-app imports.
- **Headless first, React second** (`scaling-rules.md` §2.2): logic goes in a non-React package or file with Node tests, and UI goes in the `-react` package.
- **Exact pins** checked by `apps/settings/__tests__/workspacePins.test.ts`: `typescript` must be exactly `5.6.3` and `@thatopen/fragments` exactly `3.6.0` in every `package.json`.
- **Project id:** writes must use `useRequiredProjectId()` / `requireProjectId()` from `@ff/auth`. Never hard-code `"default-project"`. The shared constant is `LEGACY_DEFAULT_PROJECT_ID` (`@ff/types`).
- **Touch:** use Pointer Events, not mouse events, give interactive canvases `touch-action: none`, and keep touch targets at least 40px (`--ff-touch-target`) (`scaling-rules.md` §4).

## 8. Demo mode and the demo seed

- `apps/settings/.env.development` sets `VITE_FF_DEMO_AUTH=true`, so `pnpm --filter settings dev` starts in demo mode with no sign-in. Visitors are Viewers. "View as → Admin" at the bottom of the rail unlocks Settings/Users and editing. `isDemoAuth()` in `packages/ff-auth/src/demo.ts` is the single switch.
- **Building seed:** `apps/settings/src/seed/demoSeed.ts` injects a pre-parsed bundle from `apps/settings/public/seed/manifest.json`. **That folder is not in the public repo**, so in a fresh clone the seed reports "unavailable" and the app starts empty. Users load `apps/settings/public/samples/sample.ifc` by hand (README Quick start). `?ff-export-seed=1` (`src/seed/seedExport.ts`) exports the current demo data as a seed ZIP.
- **Task seed:** `runDemoTasksSeedIfEmpty()` (`packages/ff-tasks-react/src/demoTaskSeedRunner.ts`) runs after the building seed on page load. It writes a handful of sample tasks (6–8) from `packages/ff-tasks/src/demoSeed.ts`, but **only when the demo project's first building has both an IFC and a PDF**. To see sample tasks in a fresh clone: create a building, load `sample.ifc` and any PDF, then reload.
- `pnpm build:selfhost` strips `seed/` and `samples/` from `dist` (`scripts/prune-demo-assets.mjs`).

## 9. Environment flags

All `VITE_*` values are baked in at build time (Vite). Files: `.env.example` (root template), `apps/settings/.env.development` (demo on), `apps/settings/.env.production.example` (copy to the git-ignored `.env.production`), and your own `apps/settings/.env.local` (git-ignored, overrides in dev).

| Flag | Values | Effect |
|---|---|---|
| `VITE_FF_DEMO_AUTH` | `true` / `false` | Demo mode (no backend). Must be `false` for a real deployment. |
| `VITE_FF_DEMO_READONLY` | `true` | With demo on, hides "View as" and locks the role to viewer, for a public read-only demo (`isDemoReadOnly()` in `packages/ff-auth/src/demo.ts`). |
| `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID` | from the Firebase console | Client config (public by design). |
| `VITE_EXPECTED_FIREBASE_PROJECT_ID` | project id | Tenant check: the app refuses to start against a different project. |
| `VITE_FIREBASE_FUNCTIONS_REGION` | for example `us-central1` | Region of the callables. |
| `VITE_FIREBASE_USE_EMULATOR` | `true` / `false` | Connects to local emulators (Auth 9099, Firestore 8080, Functions 5001, Storage 9199). |
| `VITE_FIREBASE_EMULATOR_HOST` | host, default `localhost` | Emulator host. |
| `VITE_TASKS_EXTENDED_FIELDS` | `1` | Shows priority/checklist/watchers/attached sheets when signed in. They are always on in demo mode. The rules already allow them. |
| `VITE_TASKS_HARD_DELETE` | `1` | Shows admin hard-delete of tasks. **The rules still deny task deletes** (`allow delete: if false`), so this also needs a rules change. |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_RELEASE` (+ CI-only `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`) | optional | Error reporting. Off when absent. |

Server-side function params are **not** `VITE_` vars. `APP_ORIGIN` and `BOOTSTRAP_ADMIN_EMAILS` go in `packages/ff-firestore/functions/.env.<project-id>` (template `.env.example`). The secret `BOOTSTRAP_SECRET` is set with `firebase functions:secrets:set`.

The hosting **Content-Security-Policy** in `firebase.json` limits where the browser may connect (`connect-src`). If browser code must call a new external host, it needs a CSP change. Calling it from a Cloud Function instead avoids that.

## 10. Cloud Functions

- Source is `packages/ff-firestore/functions/src/*.ts`, and each function is exported from `functions/src/index.ts`. It is a separate npm package (`@free-field/functions`, Node 22, `firebase-functions` v6 / `firebase-admin` v12) with its own `package-lock.json`. Install it once with `npm ci --prefix packages/ff-firestore/functions`.
- `firebase.json` deploys it as codebase `free-field-user-module` and compiles it on predeploy. The compile check is `pnpm --filter @ff/firestore build:functions`.
- Patterns to copy:
  - **callable:** `onCall` from `firebase-functions/v2/https`, which checks `request.auth` and the caller's member doc (see `setActiveProject.ts`). The client side uses `httpsCallable(getFunctions(app, region), 'name')` (see `apps/users/src/api.ts`).
  - **Firestore trigger:** `onDocumentCreated` from `firebase-functions/v2/firestore` (see `onCreateUser.ts`).
  - **params and secrets:** `defineString` / `defineSecret` from `firebase-functions/params` (see `bootstrapFirstAdmin.ts`).
- Tests are in `functions/__tests__/`. They run only under the emulator (`pnpm --filter @ff/firestore test:emulator`).
- Functions require the Firebase Blaze plan, which a real deployment already has.

## 11. Known drift and gaps

Tell the user about these when they matter. Don't silently work around them.
- `docs/architecture/scaling-rules.md` is a June draft. Its app table is out of date: documents, linkview and users exist, and `apps/docs` doesn't.
- Code comments cite `docs/integration/*`, `docs/ux/*`, `docs/SPEC-PHASE-1.md`, `docs/STYLING.md` and `docs/migration/dexie-v9.md`. None are in the public repo.
- `lint:drift` is a no-op on Windows and on paths with spaces. Run for real, `packages/ff-viewer-react` already has pre-existing Rule 14 findings.
- `packages/ff-tasks/src/bcf/labels.ts` says it is pinned by `__tests__/bcf/labels.test.ts`, but that test doesn't exist. Keep `BCF_STATUS_LABELS` and `STATUS_LABELS` in sync by hand.
- `packages/ff-tasks-react` and `packages/ff-sync` have no ESLint script.
- `packages/ff-tasks/src/taskFields.ts` contains literal NUL characters (key separators), so Grep/ripgrep treat it as binary and skip its matches. Read it directly, or use `grep -a`.
- `apps/settings/vite.config.ts` `server.allowedHosts` names a specific private tunnel host, a leftover that is harmless locally.
- `scripts/e2e/` is an internal harness that writes to `docs/qa/`, which doesn't exist. Don't rely on it.
