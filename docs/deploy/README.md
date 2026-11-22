# Self-hosting FreeField on your own Firebase project

> Full step-by-step guide (Firebase setup, every env variable, `APP_ORIGIN`, first admin, App Check, API-key restriction, trimming demo assets, CI): **[self-hosting.md](self-hosting.md)**. This page is the short runbook.

Each organisation runs its own Firebase project (Auth, Firestore, Storage, Functions, Hosting). The web app is a static Vite build. Models, PDFs and calibrations stay in each user's browser; only tasks, members and projects live in Firestore.

## Prerequisites

- A Firebase project (Blaze plan is required for Cloud Functions)
- `firebase-tools` (`npm i -g firebase-tools`), `firebase login`
- Node.js 20+, pnpm 10; Java on PATH if you run emulator tests
- Auth: enable the Email link (passwordless) provider; add your hosting domain to Authorized domains

## Configure

1. Set your project id: `firebase use --add` (or edit `.firebaserc`, replacing the placeholder).
2. Client config: copy `apps/settings/.env.production.example` to `apps/settings/.env.production` and fill in the values from Firebase Console, Project settings, Your apps. `VITE_EXPECTED_FIREBASE_PROJECT_ID` must equal `VITE_FIREBASE_PROJECT_ID`; the app refuses to boot on a mismatch. Keep `VITE_FF_DEMO_AUTH=false`. These files are git-ignored.
3. Functions params: copy `packages/ff-firestore/functions/.env.example` to `.env.<your-project-id>` and set `BOOTSTRAP_ADMIN_EMAILS` (emails allowed to create the first admin).
4. Optional telemetry: set `VITE_SENTRY_DSN` (see `apps/settings/.env.example`); without it telemetry stays local-only.

## Deploy

```bash
pnpm install
pnpm build:selfhost                                # builds, then drops demo seed/samples; outputs apps/settings/dist
firebase deploy --only firestore:rules,firestore:indexes,storage
firebase deploy --only functions                   # builds packages/ff-firestore/functions
firebase deploy --only hosting
```

## Layout (firebase.json)

- Firestore rules/indexes: `packages/ff-firestore/firestore.rules`, `firestore.indexes.json`
- Storage rules: `storage.rules`
- Functions: `packages/ff-firestore/functions` (bootstrap, invitations, roles, projects)
- Hosting: `apps/settings/dist` (SPA rewrite to `index.html`)

## First admin

After deploying, set the bootstrap secret (`firebase functions:secrets:set BOOTSTRAP_SECRET`), then sign in with an email listed in `BOOTSTRAP_ADMIN_EMAILS` and use the one-time "claim first admin" action on the invitation page.

## Local emulators

```bash
firebase emulators:start      # Auth 9099, Firestore 8080, UI 4000
pnpm test:emulator          # needs JDK 21; runs the @ff/firestore rules + functions and @ff/sync suites
```

## Not included

Custom-domain wiring, automated deploys (CI for tests/build is in `.github/workflows/ci.yml`), scheduled Firestore backups and a custom email provider (Resend/SendGrid) are left to the operator.
