---
name: freefield-deploy
description: >-
  Guide a non-programmer through running FreeField for real: trying it on their own computer,
  putting it online for a team or the whole company on their own Firebase project, and writing the
  ready-to-send request to IT. Use this skill whenever the user talks about deploying, hosting,
  publishing, "subirlo a la web", "ponerlo en línea / en producción", "instalarlo para mi empresa /
  mi equipo", Firebase (project, Blaze plan, login, Hosting, Firestore, Functions), a custom domain
  ("dominio propio", DNS), sign-in emails not arriving, going from the demo to a real deployment,
  costs ("¿cuánto cuesta?"), data region / residency, updating, rolling back or backing up a deployed
  FreeField, or asks "¿qué necesito pedirle a TI?", "what do I ask IT for?", "write the email to IT".
  Trigger it even when the request is vague ("quiero usarlo con mi equipo", "how do I get this
  running for everyone?"), and in Spanish or English. Not for changing features or code (that is
  freefield-extend).
---

# FreeField deploy: from demo to your company's own site

FreeField is a static web app plus a small Firebase backend. Every company runs it on **its own** Firebase project, so its data, users and bills stay with that company. Your job is to get the user there safely: you do the typing and explain each step in plain words, **in the user's language** (often Spanish).

The user is usually a BIM/VDC manager, field engineer or ops lead, not a developer. So:
- Run commands yourself and say in one sentence what each one does and why, before running it.
- Avoid jargon. Define unavoidable terms once; `references/glossary.es-en.md` has plain definitions (in Spanish, the product says *incidencias* for tasks/issues and *plano* for a PDF plan).
- Show progress as a short checklist, not walls of log output. Summarise errors, then fix them.

## Ground rules (and why)

- **Ask before anything that costs money, touches production or deploys.** That covers Blaze, any `firebase deploy`, secrets, DNS changes, and anything aimed at `prod`. A wrong deploy can lock real users out, and billing is the company's call. Say what will happen, then wait for a clear yes.
- **Never ask for secrets in chat**: no passwords, service-account keys, tokens or the bootstrap secret. If one is needed, the user types it into a terminal prompt or a file you never read back. (The Firebase *web config* is public by design, since every visitor's browser downloads it; still, prefer fetching it with the CLI over pasting.)
- **`firebase login` is a browser sign-in, not a password exchange.** Explain it like this: "A browser window opens; you sign in with your company Google account and click Allow. I never see your password." It's interactive, so the user runs it in a VS Code terminal (Terminal → New Terminal).
- **Don't stall.** If you can't ask, or the user wants a quick answer, state your assumptions at the top of the reply and proceed with the defaults in `references/planning.md` §1, then invite corrections. Never invent names, emails, ids or amounts: leave `{{…}}` placeholders.
- **The repo's docs are the source of truth:** `docs/deploy/self-hosting.md` and `docs/deploy/README.md`. `references/deploy-steps.md` is the verified sequence, including two steps the docs omit. Don't invent commands.
- **Don't run `scripts/setup-firebase.sh`.** It's an early-phase script: it needs `python3` and `gcloud`, hard-codes a budget, and references missing files.

## Step 1. Clarify the goal

If the intent is already clear (e.g. "write the email to IT"), skip ahead. Otherwise ask once, "¿Qué quieres lograr?" / "What are you aiming for?", and offer:

| Path | What it is | Needs |
|---|---|---|
| **A. Try it on my computer** | Demo mode: no sign-in, no backend, data stays in this browser | Node 20+, pnpm 10. Nothing from IT |
| **B. Team pilot** | One Firebase project, the free `*.web.app` address, a small team | A Firebase project on Blaze, the right roles, a light IT sign-off |
| **C. Company rollout** | Custom domain, IT governance, staging + prod | The full IT request, two projects |
| **D. Public read-only demo** | A no-login showcase | See `deploy-steps.md` §6 |

Then settle three planning questions; `references/planning.md` has the detail and the defaults:
- **Who deploys?** The user with you (default), or **IT deploys** and you coordinate (§3).
- **Staging + prod, or prod only?** Prod only is acceptable for a pilot, with extra care (§4).
- **Region?** It's permanent for data. Functions run in `us-central1` today, which matters for residency (§5).

**Path A**, the whole thing: `pnpm install`, then `pnpm --filter settings dev`, then open http://localhost:5173. "View as: Admin" at the bottom of the left rail unlocks Settings; the sample model is `apps/settings/public/samples/sample.ifc`. Stop here unless they want more.

## Step 2. Readiness check

```bash
node .claude/skills/freefield-deploy/scripts/check-setup.mjs            # overview
node .claude/skills/freefield-deploy/scripts/check-setup.mjs --deploy   # before a real deployment
```
It checks the tools, dependencies, config files and leftover demo flags, and that the Google/npm/GitHub hosts are reachable. It prints key names only, never `.env` values. Exit code 1 means blockers (❌). Flags: `--offline`, `--ascii` (for old Windows consoles), `--public-demo`.

Translate the result: what's fine, what you'll fix now, and what needs IT (network blocks). Ask before global installs (`npm i -g firebase-tools`).

**If the repo is inside OneDrive, Dropbox, Google Drive or iCloud, strongly recommend moving it before `pnpm install` or any deploy.** These apps sync and lock files while pnpm writes tens of thousands of them into `node_modules`, which causes EPERM/EBUSY failures, half-installed dependencies and very slow installs. They can also upload the git-ignored `.env` files to the cloud, files that hold the company's project settings. Offer to move it to `C:\dev\free-field-app` or `~/dev/free-field-app`. Let the user move the folder (or re-clone there), then reopen VS Code in the new place.

## Step 3. The IT request (paths B and C)

Often the most valuable thing you produce. Read `references/planning.md` first: it covers the prerequisites (organisation, billing account) and **exactly which roles to request**. *Editor* alone isn't enough.

Produce **two pieces** from `references/it-request-template.es.md` or `.en.md`:
1. **A short cover email (at most 15 lines):** what FreeField is, why the company's own project, the 5 asks (project + owner; Blaze billing + budget alert; region; deployer roles; email/network allowances), and the open questions for IT. It's the part people actually read.
2. **The technical annex:** the full template, filled in. Delete sections that don't apply rather than leaving them blank. Include the **Google Workspace** blocks (mail filtering, link protection, org-policy wording) only if the user mentions Workspace/Gmail.

Before writing, gather (or assume, per the ground rules): company, requester, pilot or rollout, number of users, address/domain, region, who deploys, proxy or strict email filtering. Save the files where the user wants them (default: `IT-request-FreeField.md` in the repo root, which is not committed unless they choose to). Then summarise in five lines. Remind them it contains no secrets.

**Cost:** a formula, the drivers ranking and links to official pricing (`planning.md` §6). **Never quote prices or totals**: they vary by region and over time, and a wrong number in an IT request damages trust.

## Step 4. Configure

Once the project exists (created by IT or the user); details in `references/deploy-steps.md` §1–2:
1. The user runs `firebase login`; you check with `firebase projects:list`.
2. **`.firebaserc`:** replace the placeholder with the project id (and `staging`/`prod` aliases if there are two projects).
3. **Console clicks** (the user or IT, guided by you): Email-link sign-in; Firestore in production mode **in the agreed region**; the Storage bucket; Blaze; a Web app.
4. **`apps/settings/.env.production`** from the example, filled via `firebase apps:sdkconfig` (no pasting). `VITE_EXPECTED_FIREBASE_PROJECT_ID` must equal `VITE_FIREBASE_PROJECT_ID`, because the app refuses to boot otherwise; that guard stops one company's build from talking to another's project. **`VITE_FF_DEMO_AUTH=false`**: with `true`, anyone could switch to Admin.
5. **`packages/ff-firestore/functions/.env.<project-id>`:** `APP_ORIGIN` (the site address; invite links use it) and `BOOTSTRAP_ADMIN_EMAILS` (the first admin).
6. Re-run `check-setup.mjs --deploy`.

These files are git-ignored. Tell the user to keep a copy in the company password manager.

## Step 5. Deploy

If **IT deploys** (planning §3, option 2), hand them the annex and `references/deploy-steps.md`, and act as coordinator: don't run deploy commands yourself.

Otherwise follow `references/deploy-steps.md` §3 exactly: install → functions dependencies → bootstrap secret → `pnpm build:selfhost` → rules + indexes + storage → functions → hosting. **Server rules and functions go first, the website last**, so a new web build never meets old rules.

Before the first `firebase deploy`, ask: "This publishes to project `<id>` (`<alias>`). It may enable Google Cloud APIs, and usage is billed to the company's Blaze account. Shall I go ahead?" For `prod`, ask again even if staging went fine. Always pass `--project <alias>` and `--non-interactive`. On Windows, run deploys from Git Bash, because the functions predeploy relies on `PWD`. The first functions deploy often fails once while Google finishes setting up; wait a few minutes and retry (troubleshooting table).

**First admin:** open the site, sign in with the `BOOTSTRAP_ADMIN_EMAILS` address, click the email link in the same browser, then press **"Bootstrap as First Admin"**. No keys needed.

## Step 6. Verify (smoke test with the user)

1. The site loads over HTTPS with no configuration error.
2. The sign-in email arrives (check spam) and the link works.
3. The first admin sees Settings and Users.
4. Invite a colleague: Users → invite → **copy link**. FreeField doesn't email invitations; the admin sends the link. The colleague joins as Member.
5. Change the colleague's role, then change it back.
6. A task created in one browser appears in a second browser signed in as the colleague.
7. Load an IFC in Settings, run Get Levels, open Models.
8. Sign out on a shared device; local data is cleared.

## Step 7. Operate

Explain in plain words; the commands are in `deploy-steps.md` §8:
- **Updates:** pull, reinstall, rebuild, deploy in the same order. Staging first, if it exists.
- **Rollback:** the website rolls back in one click (Hosting → release history). Rules and functions roll back by redeploying the previous commit.
- **Backups:** turn on scheduled Firestore backups. Unpublished models live only in users' browsers.
- **Support:** MIT open source, **no SLA**. FreeField issues go to GitHub; Google Cloud outages and billing go through the company's Google support.

## Reference files (read when…)
- `references/planning.md`: before steps 1 and 3. Covers defaults when you can't ask, prerequisites and roles, who deploys, single environment, region (LatAm), cost drivers.
- `references/it-request-template.es.md` / `.en.md`: step 3 (cover email + annex).
- `references/deploy-steps.md`: before any deploy command, on any failure, and for update/rollback/backup/public demo. It's also the hand-over for IT.
- `references/glossary.es-en.md`: plain definitions in both languages.
- `scripts/check-setup.mjs`: step 2, and after every configuration change.
