# Self-hosting guide

FreeField is MIT open source. Each organisation forks it and runs it on its own Firebase project, so your data, users and costs stay with you. This guide is written for your developer, or for an AI coding agent working in your fork. Every command is a stock command; nothing needs a custom loader or environment flag.

The public demo site is a no-login build (`VITE_FF_DEMO_AUTH=true`). Do not copy that setting into a real deployment.

## 1. Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 20 (Cloud Functions declare Node 22; the deployed runtime is chosen by Firebase) | build, tests |
| pnpm | 10.30.1 (pinned in `packageManager`; `corepack enable` picks it up) | install, workspaces |
| firebase-tools | recent (the repo pins 15.x as a dev dependency; `npm i -g firebase-tools` for deploys) | deploy, emulators |
| JDK | 21 (Temurin recommended) | Firestore/Storage emulators only (rules tests) |

Blaze (pay-as-you-go) is required for Cloud Functions. Usage for a small team is normally inside the free quota.

## 2. Create the Firebase project

1. Firebase Console, Add project. Note the **project id** (for example `acme-field`).
2. Build, Authentication, Sign-in method: enable **Email/Password**'s "Email link (passwordless sign-in)" option. Under Settings, Authorized domains, add the domain you will host on.
3. Build, Firestore Database: create in production mode, in the region you want your data in.
4. Build, Storage: create the default bucket.
5. Build, Functions: choose Blaze when prompted. Functions are deployed in step 6.
6. Project settings, Your apps: add a **Web app**. Copy the config values for step 4.

## 3. `.firebaserc` aliases

`.firebaserc` ships with a placeholder. Use one alias per environment:

```json
{
  "projects": {
    "default": "acme-field-staging",
    "staging": "acme-field-staging",
    "prod": "acme-field"
  }
}
```

Select one with `firebase use staging` or `firebase use prod`, or pass `--project` on each command. Run `firebase login` first. Keep one `.env.production` per target build (see below) and rebuild when you switch.

## 4. Web build configuration

```bash
cp apps/settings/.env.production.example apps/settings/.env.production
```

`apps/settings/.env.production` is git-ignored. Fill in:

| Variable | Meaning |
|---|---|
| `VITE_FIREBASE_API_KEY` | Web API key from the web app config. Public by design; restrict it (section 8). |
| `VITE_FIREBASE_AUTH_DOMAIN` | `<project-id>.firebaseapp.com`, or your custom auth domain. |
| `VITE_FIREBASE_PROJECT_ID` | Your project id. |
| `VITE_FIREBASE_STORAGE_BUCKET` | `<project-id>.firebasestorage.app` (or `.appspot.com` on older projects). |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | From the web app config. |
| `VITE_FIREBASE_APP_ID` | From the web app config. |
| `VITE_EXPECTED_FIREBASE_PROJECT_ID` | Must equal `VITE_FIREBASE_PROJECT_ID`. The app refuses to boot on a mismatch, which stops a build for one project being served against another. |
| `VITE_FIREBASE_USE_EMULATOR` | `false` for any deployed build. `true` only for local emulator runs. |
| `VITE_FF_DEMO_AUTH` | **`false`.** `true` turns on the no-login demo (seeded data, role switcher). Never ship it in a real deployment. |
| `VITE_FIREBASE_FUNCTIONS_REGION` | Optional. Region of your Functions; default `us-central1`. |
| `VITE_SENTRY_*` | Optional error reporting. Leave unset to keep telemetry local to the device. |

Functions params are separate and are **not** read by the web build. Copy `packages/ff-firestore/functions/.env.example` to `packages/ff-firestore/functions/.env.<your-project-id>` (git-ignored) and set:

| Variable | Meaning |
|---|---|
| `APP_ORIGIN` | Origin of your deployed web app, no trailing slash, for example `https://field.acme.com`. Invitation and bootstrap emails link back to it, and a `continueUrl` on any other origin is rejected. If unset it falls back to `http://localhost:5173`, so **set it before inviting anyone**. |
| `BOOTSTRAP_ADMIN_EMAILS` | Comma-separated, verified emails allowed to claim the first admin (section 6). |

The secret `BOOTSTRAP_SECRET` is held in Secret Manager: `firebase functions:secrets:set BOOTSTRAP_SECRET`.

## 5. Build

```bash
pnpm install --frozen-lockfile
pnpm build:selfhost
```

`build:selfhost` runs the full Turborepo build and then `scripts/prune-demo-assets.mjs`. The output is `apps/settings/dist` (git-ignored).

### Leave out the demo seed and sample models

`apps/settings/public/seed` (about 114 MB) and `apps/settings/public/samples` (about 38 MB) are copied into `dist` by Vite. They are used only by the demo seeder (`src/seed/demoSeed.ts` fetches `/seed/manifest.json` and `/seed/blobs/*`) and the dev model picker (`DevPickMultimodel`, `/samples/*.ifc`). With demo auth off nothing requests them, and the seeder reports "unavailable" if they are missing. `pnpm build:selfhost` deletes both folders from `dist`, which cuts the hosting upload by about 150 MB. If you call `vite build` yourself, run `node scripts/prune-demo-assets.mjs` after it. Excluding them at the Vite level (a `publicDir` split) needs a change to the locked `apps/settings/vite.config.ts`; see `docs/integration/launch-build-settings-config.md`.

## 6. Deploy

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
firebase deploy --only functions      # compiles packages/ff-firestore/functions
firebase deploy --only hosting        # serves apps/settings/dist
```

Add `--project staging` or `--project prod` to target an alias. Deploy rules and functions before hosting, so a new web build never meets old rules.

### First admin

A fresh project has no members. Choose one of these:

- **From the app.** Put your email in `BOOTSTRAP_ADMIN_EMAILS` (functions env file), redeploy functions, open the site, sign in with that email link, and use the first-admin bootstrap screen. The email must be verified.
- **With the secret.** Set `BOOTSTRAP_SECRET`, then call `bootstrapFirstAdmin` with it (see `docs/integration/w67-phase1b-deploy.md`).
- **Headless.** `npx tsx scripts/bootstrap-admin.ts <email> [project-id] [firebase-project]` using a service account (`GOOGLE_APPLICATION_CREDENTIALS`). Keep the key secret.

After the first admin exists, invite everyone else from the Users module.

## 7. Optional: App Check

App Check makes Firebase reject traffic that does not come from your app. It is not wired in yet. To add it:

1. Console, App Check: register the web app with reCAPTCHA Enterprise (or v3).
2. Add the site key as `VITE_FIREBASE_APPCHECK_SITE_KEY` in `.env.production`.
3. In `packages/ff-auth/src/AuthProvider.tsx`, where the Firebase app is first created (`initializeApp(config)`), call `initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(key), isTokenAutoRefreshEnabled: true })` from `firebase/app-check`, only when the key is set.
4. Roll out in "monitor" mode, check the metrics, then enforce for Firestore, Storage and Functions.

Tests and emulators run without it because the call is skipped when the key is unset.

## 8. Restrict the Web API key

The Firebase web API key is not a secret, but unrestricted keys can be abused. In Google Cloud Console, APIs & Services, Credentials, open the "Browser key" for your project:

- Application restrictions: HTTP referrers. Add `https://<your-domain>/*`, `https://<project-id>.firebaseapp.com/*` and `https://<project-id>.web.app/*`. Add `http://localhost:*` only for a staging key.
- API restrictions: Identity Toolkit API, Token Service API, Cloud Firestore API, Cloud Storage for Firebase API, Firebase Installations API (and Cloud Functions if you call them via the REST endpoint).

Use a separate key for staging and production.

## 9. Keeping your fork green (CI)

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | Runs | Needs |
|---|---|---|
| `check` | `pnpm install --frozen-lockfile`, `pnpm typecheck` (all workspaces plus `apps/settings`), `pnpm lint`, `pnpm test` | Node 20 |
| `build` | `pnpm build:selfhost` with demo off and placeholder `VITE_*` values; asserts `seed/` and `samples/` are not in `dist` | Node 20, no secrets |
| `emulator` | `pnpm --filter @ff/firestore test:emulator` (rules, storage rules, functions) then `pnpm --filter @ff/sync test:emulator` | JDK 21, Node 22 |

Run the same things locally before you push:

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:emulator            # needs JDK 21 on PATH
```

Guidance for your own changes:

- Add or change Firestore/Storage rules only together with a case in `packages/ff-firestore/__tests__/rules*.test.ts`; the `emulator` job is what proves them.
- Keep `pnpm test` free of emulators: put anything that needs one in the `test:emulator` script of that package.
- Mark the three jobs as required status checks in branch protection.
- To deploy from CI, add a separate workflow gated on a GitHub Environment, with a deploy service account stored as an environment secret. Do not reuse `ci.yml`, which intentionally has read-only permissions.

## Troubleshooting

- *"firebase-tools no longer supports Java version before 21"*: install JDK 21 for the emulator tests only; everything else runs without Java.
- *App shows a configuration error at boot*: `VITE_EXPECTED_FIREBASE_PROJECT_ID` does not equal `VITE_FIREBASE_PROJECT_ID`, or a `VITE_FIREBASE_*` value is empty. Rebuild after fixing.
- *Invitation links point at localhost*: `APP_ORIGIN` is not set in the functions env file for this project. Set it and redeploy functions.
