# Deploy steps (verified against the repo)

Read this before running any deploy command. It is also the hand-over document when IT deploys (`planning.md` §3): it is self-contained. Sources: `docs/deploy/self-hosting.md`, `docs/deploy/README.md`, `firebase.json`, `package.json`, `.github/workflows/ci.yml`, `packages/ff-firestore/functions/src/*`. Where the docs leave a step out, it's marked **(not in the docs)** along with where it was verified.

Conventions: run everything from the repo root. `<alias>` is a name from `.firebaserc` (`default`, `staging`, `prod`…), and `<project-id>` is the Firebase project id. Each command works in Git Bash, macOS/Linux shells and PowerShell unless noted.

## Contents
1. One-time machine setup
2. One-time project setup
3. Every deploy (the sequence)
4. First admin
5. Custom domain
6. Public demo build
7. Troubleshooting
8. Update, rollback, backup

---

## 1. One-time machine setup

| Step | Command | Why |
|---|---|---|
| pnpm (if missing) | `corepack enable` | Uses the pnpm version pinned in `package.json` (`pnpm@10.30.1`). Fallback: `npm i -g pnpm@10.30.1` |
| Firebase CLI | `npm i -g firebase-tools` | The deploy tool. The repo also pins `firebase-tools` 15.x inside `packages/ff-firestore` for tests |
| Sign in | `firebase login` | **The user runs this in a VS Code terminal.** It opens a browser for a Google sign-in. On a remote machine with no browser: `firebase login --no-localhost` |
| Confirm access | `firebase projects:list` | The company project should be listed. If it isn't, the account lacks access (IT: IAM roles) |

Java 21 is needed **only** for `pnpm test:emulator`. Building and deploying don't need it.

## 2. One-time project setup

The Console steps (`self-hosting.md` §2), done by the user or IT:
1. Create the project; note the **project id**.
2. Authentication → Sign-in method → Email/Password → enable **Email link (passwordless sign-in)**. Settings → Authorized domains: `localhost`, `<project-id>.firebaseapp.com` and `<project-id>.web.app` are there by default. Add the custom domain later (§5).
3. Firestore Database → Create, in **production mode**, in the agreed **location**. The location can't be changed later.
4. Storage → create the default bucket. Its location can't be changed either.
5. Upgrade to **Blaze** (Cloud Functions require it). Do this only with the user's/IT's explicit approval.
6. Project settings → Your apps → add a **Web app**. Or, with the CLI: `firebase apps:create WEB "FreeField" --project <project-id>` (ask first; it creates a resource).

Repo files:
```bash
# .firebaserc: edit so "default" (and optionally "staging"/"prod") hold real project ids.
cp apps/settings/.env.production.example apps/settings/.env.production
cp packages/ff-firestore/functions/.env.example packages/ff-firestore/functions/.env.<project-id>
```
PowerShell: `Copy-Item apps/settings/.env.production.example apps/settings/.env.production` (and the same for the functions file).

Filling `apps/settings/.env.production` without copy-paste:
```bash
firebase apps:list WEB --project <alias>
firebase apps:sdkconfig WEB <appId> --project <alias>
```
Map `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId` and `appId` to the matching `VITE_FIREBASE_*` keys. Set `VITE_EXPECTED_FIREBASE_PROJECT_ID` to the project id too, plus `VITE_FIREBASE_USE_EMULATOR=false` and `VITE_FF_DEMO_AUTH=false`. Leave `VITE_FIREBASE_FUNCTIONS_REGION` unset: the functions code sets no region, so it deploys to `us-central1`, which is also the client default.

The functions file `.env.<project-id>`:
- `APP_ORIGIN=https://<final-site-address>`, with no trailing slash. Use the custom domain if there is one, else `https://<project-id>.web.app`.
- `BOOTSTRAP_ADMIN_EMAILS=<first-admin-email>`, comma-separated if more than one.

Then: `node .claude/skills/freefield-deploy/scripts/check-setup.mjs --deploy`.

## 3. Every deploy (the sequence)

Ask for explicit approval before step 5. Ask again for `prod`.

```bash
# 1. Workspace dependencies (exact versions from the lockfile)
pnpm install --frozen-lockfile

# 2. Cloud Functions dependencies. (not in the docs' deploy section)
#    The functions folder is NOT a pnpm workspace; it has its own package-lock.json.
#    Without this, the functions predeploy build (tsc) and the deploy fail.
#    Verified: .github/workflows/ci.yml, CONTRIBUTING.md.
npm ci --prefix packages/ff-firestore/functions

# 3. Bootstrap secret, first deploy per project only. (the README says "after deploying";
#    it must exist BEFORE the functions deploy, because bootstrapFirstAdmin declares
#    secrets: [BOOTSTRAP_SECRET]. Verified in functions/src/bootstrapFirstAdmin.ts.)
#    This generates a random value and pipes it straight in: it is never printed or shown in chat.
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | firebase functions:secrets:set BOOTSTRAP_SECRET --data-file - --project <alias>
#    Alternative: the user runs `firebase functions:secrets:set BOOTSTRAP_SECRET --project <alias>`
#    in their own terminal and types any long random value at the hidden prompt.

# 4. Build the website without the ~150 MB demo seed/samples -> apps/settings/dist
pnpm build:selfhost

# 5. Database + storage security rules and indexes
firebase deploy --only firestore:rules,firestore:indexes,storage --project <alias> --non-interactive

# 6. Cloud Functions (predeploy compiles packages/ff-firestore/functions)
firebase deploy --only functions --project <alias> --non-interactive

# 7. Website
firebase deploy --only hosting --project <alias> --non-interactive
```

Why this order: the website goes last, so a new web build never meets old rules or functions (`self-hosting.md` §6). After step 5 on a fresh project, the collection-group index on `members` takes a few minutes to build. Until it shows **Enabled/READY** (Console → Firestore → Indexes), signed-in users may see "needs invitation" or permission errors. Wait for it before the smoke test.

After step 7 the CLI prints the Hosting URL (`https://<project-id>.web.app`).

If `.env.production` changes (new project, new keys), **rebuild (step 4) and redeploy hosting**. Vite bakes the values in at build time. If the functions `.env.<project-id>` changes (e.g. `APP_ORIGIN`), **redeploy functions** (step 6).

## 4. First admin

Recommended (no credential files):
1. Make sure the email is in `BOOTSTRAP_ADMIN_EMAILS` and the functions were deployed after that.
2. Open the site and sign in with that email. Click the link in the email, in the same browser.
3. The "needs invitation" screen appears. Press **Bootstrap as First Admin**. The page reloads as admin of the project `default-project`.
4. Invite everyone else from **Users**. Invite links are shown to the admin to copy; FreeField doesn't send invitation emails itself.

Headless alternative (developers only; needs a service-account key or Application Default Credentials; the user must have signed in once):
```bash
npx tsx scripts/bootstrap-admin.ts <email> [project-id] [firebase-project]
```
With `GOOGLE_APPLICATION_CREDENTIALS` pointing to a key file. Never paste or open that key in chat. Many organisations block key creation, and the in-app path avoids it.

`scripts/set-custom-claims.mjs` and `scripts/check-claims.mjs` are **emulator-only** helpers (they hard-code `localhost:9099`). Don't use them against a real project.

## 5. Custom domain

1. Console → Hosting → **Add custom domain** → enter e.g. `field.company.com`.
2. The Console shows the DNS records to create. Usually that's a **TXT** record (ownership) and **A** record(s) for the hosting IPs; use the exact values shown and don't copy them from anywhere else. IT creates them at the company DNS provider. Conflicting old A/AAAA/CNAME records on that name must be removed.
3. Wait for verification and the automatic TLS certificate (minutes to hours; Google says it can take up to 24 h).
4. Authentication → Settings → Authorized domains → add `field.company.com`. Without this, email-link sign-in from that domain fails.
5. Set `APP_ORIGIN=https://field.company.com` in `packages/ff-firestore/functions/.env.<project-id>`, then redeploy functions.
6. Optional hardening (`self-hosting.md` §8): restrict the browser API key to the HTTP referrers `https://field.company.com/*`, `https://<project-id>.web.app/*` and `https://<project-id>.firebaseapp.com/*`.

Keep `VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com`. Email links complete through Firebase's handler there.

## 6. Public demo build (path D)

A no-login showcase. Anyone can browse; nobody signs in.
- `apps/settings/.env.production`: `VITE_FF_DEMO_AUTH=true`. If `apps/settings/src/vite-env.d.ts` declares `VITE_FF_DEMO_READONLY`, also set `VITE_FF_DEMO_READONLY=true`, which hides the "View as" switch and locks visitors to the viewer role. Older copies don't have this flag, and then visitors can switch to Admin (data still stays in their own browser).
- Build with `pnpm build`, **not** `build:selfhost`: the demo needs the seed and sample files that `build:selfhost` deletes.
- Deploy only hosting: `firebase deploy --only hosting --project <alias>`.
- Never reuse a demo `.env.production` for a real deployment. The checker's `--public-demo` mode validates this setup.

## 7. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `pnpm: command not found` | `corepack enable` (on Windows it may need an administrator terminal), or `npm i -g pnpm@10.30.1` |
| `pnpm install` fails with EPERM/EBUSY on Windows | The repo is in OneDrive/Dropbox/Google Drive, or an editor is locking files. Move or re-clone it to a plain folder like `C:\dev\free-field-app` (SKILL.md step 2), then reinstall |
| Functions deploy: `tsc: not found` / cannot find `firebase-functions` | Step 2 was skipped: `npm ci --prefix packages/ff-firestore/functions` |
| Functions predeploy fails on Windows with a path containing `PWD` | The predeploy in `firebase.json` uses `${PWD}`. The CLI translates it to `%PWD%`, but PowerShell/cmd don't set `PWD`. Run the deploy from **Git Bash** (which sets `PWD`) or WSL, from the repo root. Report it upstream rather than editing `firebase.json` |
| Deploy asks to enable an API, or says "API … has not been used / is disabled" | The deployer can enable APIs (Service Usage Admin) or IT enables it. Wait 1–2 minutes and retry |
| First functions deploy: "we need a little bit longer to finish setting everything up" / Eventarc permission errors | Normal on the first 2nd-gen deploy with a Firestore trigger. Wait a few minutes and rerun step 6 |
| Functions deploy ends with an error about a **cleanup policy** for container images | The functions deployed. The CLI wants a retention policy for old build images (they cost storage). Show the user the exact command or `--force` option the error names, and ask before applying it |
| `secrets:set` fails / Secret Manager API disabled | Needs the Secret Manager API and a role that can create secrets (see the IT request) |
| Callables fail with 403 / CORS errors right after deploy; deploy warned about setting IAM policy for `allUsers` | An org policy (Domain Restricted Sharing, `iam.allowedPolicyMemberDomains`) blocks public invokers. The functions do their own auth checks but must be publicly invokable. IT adds a project exception and you redeploy functions |
| Deploy fails on location / region policy | Org policy `gcp.resourceLocations` doesn't allow `us-central1` (where the functions deploy). IT allows it, or the code needs a region change (freefield-extend) |
| App shows a configuration error at boot | `VITE_EXPECTED_FIREBASE_PROJECT_ID` ≠ `VITE_FIREBASE_PROJECT_ID`, or a `VITE_FIREBASE_*` key is empty. Fix, **rebuild**, redeploy hosting |
| Site still shows the demo / "View as" switch | `VITE_FF_DEMO_AUTH=true` in `.env.production`, `.env.production.local` or `.env.local`. Run the checker, fix, rebuild, redeploy |
| Sign-in email never arrives | Check spam. Firebase sends from `noreply@<project-id>.firebaseapp.com`; IT may need to allow that sender. Firebase also has daily email limits (https://firebase.google.com/docs/auth/limits) |
| Email link says invalid/expired at first click | Corporate link scanners can open one-time links before the user does. IT can exempt the sender/links. Also make sure the link opens in the same browser that requested it, or re-enter the email when asked |
| `auth/unauthorized-continue-uri` or `unauthorized-domain` | The site's domain isn't in Authentication → Authorized domains |
| Invitation links point at localhost | `APP_ORIGIN` not set in `packages/ff-firestore/functions/.env.<project-id>`. Set it and redeploy functions |
| "Needs invitation" for a user who should be a member | The index from step 5 isn't READY yet, or the user wasn't invited. Wait, or re-invite |
| "Bootstrap as First Admin" says not allowed | The signed-in email isn't in `BOOTSTRAP_ADMIN_EMAILS` for that project, or the functions weren't redeployed after editing it |
| Published models/PDFs fail to download in other browsers with a CORS error | The bucket has no CORS policy for browser downloads (the docs don't cover this). Google's documented fix is `gcloud storage buckets update gs://<bucket> --cors-file=cors.json`. Ask IT/a developer; don't improvise |
| `firebase-tools no longer supports Java version before 21` | Only for emulator tests: install JDK 21 |

## 8. Update, rollback, backup

**Update from upstream** (a fork that tracks the public repo):
```bash
git status                      # must be clean; commit local changes first
git fetch upstream              # once: git remote add upstream https://github.com/theagentmarvin/free-field-app.git
git merge upstream/main
```
Then run §3 steps 1–2 and 4–7 against **staging** first, smoke-test, then repeat for `prod`. Read the upstream changelog/commits for rules or data changes. If a release ships a migration note under `docs/`, follow it in that order.

**Preview before going live** (optional): `firebase hosting:channel:deploy preview --project <alias>` gives a temporary URL (it expires after 7 days by default). The CLI adds the preview domain to Auth's authorized domains automatically. Invite links still point at `APP_ORIGIN`, so test invitations on the live site.

**Rollback:**
- Website: Console → Hosting → release history → **Rollback** on the previous release. It's instant and needs no rebuild.
- Rules / functions: check out the previous good commit, then redeploy only what changed (`firebase deploy --only firestore:rules,storage` or `--only functions`). Return to the current branch afterwards.

**Backup:**
- Firestore (tasks, members, projects, building metadata): enable **scheduled backups** or **point-in-time recovery** in Console → Firestore → Disaster recovery, or follow https://cloud.google.com/firestore/docs/backups. A manual export: `gcloud firestore export gs://<backup-bucket>` (needs `gcloud` and an IT-approved bucket). Backups are billed storage.
- Storage (task photos, published models/PDFs): objects are immutable and clients can't delete them; for copies, IT can use bucket replication or a scheduled transfer.
- Local-only data (models/PDFs never published by an admin) lives in each user's browser and isn't backed up.

**Who to call:** there's no SLA. FreeField issues go to GitHub issues. Firebase/Google Cloud outages and billing go through the company's Google Cloud support contract, if any (status page: https://status.firebase.google.com).
