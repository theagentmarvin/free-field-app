# Planning decisions (read before steps 1 and 3)

The answers that shape the IT request and the deploy: defaults to use when you can't ask, the prerequisites, who deploys, how many environments, the region, and cost. Each section ends with what to write in the IT annex.

## Contents
1. Quick-answer defaults (when you can't ask)
2. Prerequisites: organisation, billing account, roles
3. Who deploys
4. Environments: staging + prod, or prod only
5. Region and data residency
6. Cost drivers

---

## 1. Quick-answer defaults (when you can't ask)

Sometimes the user can't answer questions (a one-shot request, a scripted run) or asks for "just the email" / "solo dime qué pedir". Don't stall. Open your reply with a short **"Assumptions / Supuestos"** list, proceed with the defaults below, and close by inviting corrections. Mark unknown values `{{…}}` / "Por confirmar (TBC)" in the documents; never invent names, emails, ids or amounts.

| Decision | Default | Change it when… |
|---|---|---|
| Path | **B, team pilot** | They say "company-wide", mention a custom domain, or have more than ~50 users → C |
| Environments | **One project (prod only)**, see §4 | They say "rollout", "governance" or "testing first" → staging + prod |
| Address | Free `https://<project-id>.web.app` | They name a domain |
| Region | The nearest region to the users, **to be confirmed by IT** (Chile → `southamerica-west1`), see §5 | They state a residency rule |
| Who deploys | **The user, with Claude** (§3, option 1) | They say IT or a contractor will do it, or the user can't get project roles → §3, option 2 |
| Google Workspace content | **Leave it out** | The user mentions Workspace / Gmail / "Google corporativo" |
| Budget amount | `{{set by IT/finance}}` | Never fill it yourself |

If the intent is clear (e.g. "write the email to IT"), skip the step-1 question and go straight there.

## 2. Prerequisites: organisation, billing account, roles

Three things must exist before anyone can deploy. Check which ones the company already has:

1. **A place for the project.** Companies on Google Workspace or Cloud Identity usually already have a Google Cloud **organisation** (it appears when an admin first opens console.cloud.google.com). If the company has never used Google Cloud, IT sets that up first, or creates the project outside an organisation (fine for a pilot, weaker governance).
2. **A Cloud Billing account** with a payment method, owned by finance/IT. Without it, the project stays on the free Spark plan, which **can't run Cloud Functions**, so FreeField's sign-in, invitations and roles won't work.
3. **The right roles for the deployer** on the project.

**An existing Google Cloud project is fine.** Firebase can be added to it: Firebase Console → Add project → pick the existing Google Cloud project, or `firebase projects:addfirebase <project-id>`.

**Being only *Editor* isn't enough.** A user with only the Editor role on an existing project can't, on their own:
- add Firebase to it reliably, or grant roles (IAM changes need Owner or an IAM admin);
- link billing (that needs *Billing Account User* on the billing account, **plus** *Project Billing Manager* or Owner on the project; usually finance does it);
- make the callable functions publicly invokable (deploying them sets an IAM policy, which Editor can't do);
- change organisation policies.

**What to request, exactly** (copy into the annex):
- On the project: **Owner** during setup, *or* **Firebase Admin** (`roles/firebase.admin`) + **Cloud Functions Admin** (`roles/cloudfunctions.admin`) + **Service Account User** (`roles/iam.serviceAccountUser`) + **Secret Manager Admin** (`roles/secretmanager.admin`) + **Service Usage Admin** (`roles/serviceusage.serviceUsageAdmin`).
- From finance: **link the project to the billing account** (they need *Billing Account User* on the account). The deployer needs no billing rights.
- From the organisation admin, if policies apply: the exceptions listed in the annex (public invoker for this project's functions; allowed locations).

## 3. Who deploys

Ask, or use the default from §1. There are two options.

**Option 1: the user deploys, with Claude** (default). This is the normal flow in SKILL.md: Claude types, the user signs in (`firebase login`) and approves each costly or production step. The user needs the roles in §2.

**Option 2: IT (or a contractor) deploys.** Pick this when IT won't grant Owner/Firebase Admin to a business user, or prefers to run production itself. Claude becomes the **coordinator**:
1. Prepare the hand-over package for IT:
   - the cover email + technical annex (the IT template), with "IT deploys" stated;
   - `references/deploy-steps.md`, which is self-contained: commands, order, troubleshooting;
   - the values IT needs from the business: `APP_ORIGIN` (site address) and `BOOTSTRAP_ADMIN_EMAILS` (the first admin, normally the user);
   - the smoke checklist (SKILL.md step 6).
2. Don't run deploy commands against the company project yourself. Help the user answer IT's questions, interpret errors IT reports back (troubleshooting table), and prepare the repo if IT deploys from the user's clone.
3. After IT says it's live: guide the user through the first-admin bootstrap and the smoke test, then invitations.

A mixed setup works too: IT creates the project, billing and roles, and the user deploys (option 1). That's the most common outcome.

## 4. Environments: staging + prod, or prod only

- **Staging + prod** (recommended for a company rollout): updates are tried on staging first. That's two Firebase projects, two `.env.production` builds, two functions env files, and `.firebaserc` aliases:
  ```json
  { "projects": { "default": "acme-field-staging", "staging": "acme-field-staging", "prod": "acme-field" } }
  ```
- **Prod only** (acceptable for a pilot, or when IT gives one project). Use `.firebaserc` with `"default"` (and optionally `"prod"`) both pointing at the one project. Take extra care:
  - Before every deploy, run `pnpm typecheck && pnpm test && pnpm build:selfhost` locally, and run through the demo locally (`pnpm --filter settings dev`) to spot obvious breakage.
  - Deploy outside working hours, and tell users first.
  - Note the current Hosting release (Console → Hosting → release history) so a one-click **rollback** is ready.
  - Enable Firestore backups (or point-in-time recovery) **before** the first update, not after a problem.
  - For a risky update, use a Hosting preview channel first (`deploy-steps.md` §8). Rules and functions still change in prod, so deploy those only after reading what changed.
  - Plan to add a staging project when the pilot becomes a rollout.

## 5. Region and data residency

What's regional in FreeField:

| Piece | Where | Changeable? |
|---|---|---|
| Firestore (shared data) | The location chosen when the database is created | **No.** Permanent |
| Storage bucket (photos, published files) | The location chosen when the bucket is created | **No.** Permanent |
| Cloud Functions | **`us-central1` (Iowa, USA), always, today.** The code sets no region | Only with a code change (see below) |
| Hosting | Google's global CDN (static files only, no company data) | n/a |
| Authentication | Global Firebase service | n/a |

**Latin American options** (Google Cloud region ids):
- `southamerica-west1`: Santiago, Chile
- `southamerica-east1`: São Paulo, Brazil
- `northamerica-south1`: Querétaro, Mexico (newer; check that Firestore offers it)

Also common: `us-central1`, `us-east1`, the multi-region `nam5` (US), and `eur3` (Europe).

**Verify current availability:** don't rely on this list.
- Firestore: `firebase firestore:locations --project <id>` lists the locations the project can use. Also see https://firebase.google.com/docs/firestore/locations
- Storage: https://cloud.google.com/storage/docs/locations, and the location picker when the bucket is created. Some no-cost Storage usage applies only to certain US regions; check https://firebase.google.com/pricing
- The Console's dropdown at creation time is the final word.

**Functions are pinned to `us-central1`, and that matters for residency.** Every server action (sign-in completion, invitations, role changes) runs in the USA and reads/writes the database from there, even if Firestore is in Santiago. Many companies accept that for a pilot. If a residency rule requires in-region processing, say so plainly in the IT request. Moving them is a code change: a region in the functions' global options plus `VITE_FIREBASE_FUNCTIONS_REGION` in the build. That's freefield-extend work, done and tested before go-live, not a setting. A distant database region also adds some latency to those server actions; the app's everyday reads and writes go straight from the browser to Firestore.

## 6. Cost drivers

Rules: **no prices, totals or currency amounts**, ever. Prices change by region and over time, and the company's account terms vary. Give the formula (in the IT template), the official links, and this qualitative ranking:

1. **Storage and downloads (egress).** This is usually the biggest and least predictable item. Task **photos** and **published models/PDFs** are large, and every teammate who opens them downloads them. More people × bigger files × more opens = more cost.
2. **Firestore operations.** Driven by **tasks/incidencias**: every task created, edited, commented on or synced to a device is document reads and writes. It grows with active users and task volume, not file size.
3. **Cloud Functions.** Invitations, role changes, sign-in completion: low volume, so usually small.
4. **Hosting.** The app download (~tens of MB after `build:selfhost`, cached by browsers). Small unless thousands of users.
5. **Artifact Registry and Secret Manager.** Small. Old function build images accumulate (set the cleanup policy when the deploy offers it).
6. **Backups, if enabled.** Proportional to database size.

Also:
- **Every product has a free monthly quota** on Blaze. A small team is often within it or near it, but only the calculator says so.
- **A custom domain costs money at the domain registrar** (yearly registration, sometimes DNS hosting). Firebase charges nothing to connect it. If the company already owns the domain, a subdomain like `field.company.com` costs nothing extra.
- **A staging project** has its own (usually tiny) usage.
- A **budget alert** warns; it doesn't stop spending.

Links: https://firebase.google.com/pricing · https://cloud.google.com/products/calculator
