<!--
Notes for Claude (delete this comment block before handing over):
- Two deliverables: PART 1 (cover email, max 15 lines) and PART 2 (technical annex). Send both, or the email with the annex attached.
- Fill every {{PLACEHOLDER}}. If the value is unknown, write "TBC" rather than guessing. Never invent names, emails, ids or amounts.
- Delete what doesn't apply: blocks marked [WORKSPACE] unless the user mentioned Google Workspace/Gmail; [DOMAIN] for a *.web.app pilot;
  [STAGING] for a prod-only setup; [IT-DEPLOYS] / [USER-DEPLOYS] according to who deploys (references/planning.md §3).
- Never insert prices, totals or currency amounts. Keep the cost formula, the drivers and the official links.
- No secrets anywhere: this is meant to be emailed.
-->

# PART 1. Cover email

**Subject:** Request: Google Cloud/Firebase project to host FreeField ({{pilot for ~N users / company rollout}})

Hi {{IT_CONTACT}},

We'd like to run **FreeField**, an open-source (MIT) web app that brings together IFC models, PDF plans and site issues, for {{TEAM}} (~{{N_USERS}} users). It has no vendor-hosted service: each company runs it in **its own Google Cloud/Firebase project**, so data, users and billing stay with us.

What we need from you (details in the attached annex):
1. A Firebase project (`{{PROJECT_ID_SUGGESTION}}`) with an owner{{[STAGING] ", plus a staging project"}}.
2. Billing linked (Blaze pay-as-you-go) and a monthly budget alert.
3. The data region: we propose {{REGION}}. It's permanent.
4. Access for {{DEPLOYER}}: Owner or Firebase Admin on the project. {{[IT-DEPLOYS] "Or you deploy it, following the attached steps."}}
5. Sign-in emails allowed through our mail filters{{", the proxy hosts listed"}}{{[DOMAIN] ", and DNS records for {{CUSTOM_DOMAIN}}"}}.

Questions for you: {{e.g. Do we already have a Google Cloud billing account? Do org policies restrict regions or public functions? Who should own the project?}}

Cost is pay-as-you-go with free quotas; the annex has the formula and the official pricing links. Thanks!
{{REQUESTER_NAME}}, {{REQUESTER_ROLE}}

---

# PART 2. Technical annex

**From:** {{REQUESTER_NAME}}, {{REQUESTER_ROLE}}, {{TEAM_OR_AREA}} · **Date:** {{DATE}} · **Scope:** {{SCOPE}} · **Desired by:** {{TARGET_DATE}}
**Source code (public, MIT):** {{REPO_URL, e.g. https://github.com/theagentmarvin/free-field-app or our fork}}

## 1. Summary

FreeField is a web app for construction field work: 3D IFC models, PDF plans and site issues (tasks). It runs in a browser and needs nothing installed on users' devices. Each company hosts it in its own Firebase project. Expected usage: ~{{N_USERS}} users and {{N_PROJECTS}} active projects/buildings, starting {{START_DATE}}.

## 2. Checklist

- [ ] **Prerequisites:** a Google Cloud organisation (or an approved place for the project) and a **Cloud Billing account**. If we've never used Google Cloud, these come first.
- [ ] **Project:** `{{PROJECT_ID}}` (new, or Firebase added to an existing Google Cloud project), owned by {{PROJECT_OWNER}}.
  - [STAGING] A second project, `{{PROJECT_ID}}-staging`, for testing updates. Otherwise we run production only. That's acceptable for a pilot, with backups and a rollback plan (section 10).
- [ ] **Billing:** link the project to the billing account (Firebase **Blaze** plan). Without it, Cloud Functions can't run and the app can't sign anyone in. Finance links it (needs *Billing Account User* on the account).
- [ ] **Budget alert:** {{BUDGET_AMOUNT, set by IT/finance}} per month, alerts at 50/90/100% to {{ALERT_EMAILS}}. *An alert notifies; it doesn't stop spending.*
- [ ] **Region:** {{REGION}} for the database and files (section 5).
- [ ] **Access** for {{DEPLOYER_NAME_EMAIL}} (section 4), *or* IT deploys (section 9).
- [ ] **Products** enabled (section 3).
- [ ] **Email:** sign-in emails delivered (section 6).
- [ ] **Network:** proxy/firewall hosts allowed, if we filter traffic (section 8).
- [ ] [DOMAIN] **Custom domain** `{{CUSTOM_DOMAIN}}` (section 7). Without it, the app runs at `https://{{PROJECT_ID}}.web.app`.

## 3. Products and why

| Product | Used for | Notes |
|---|---|---|
| Firebase Authentication, **Email link (passwordless)** | Sign-in with a one-time link sent to the work email | No passwords stored; no other providers enabled |
| Cloud Firestore (production mode) | Shared data: projects, members, roles, invitations, tasks, comments, and the metadata of buildings/plans an admin publishes | Security rules versioned in the code (`packages/ff-firestore/firestore.rules`) |
| Cloud Storage for Firebase (default bucket) | Task photos, plus the converted models (.frag) and PDF plans of buildings an admin publishes to the team | Rules in `storage.rules`: members read; files are immutable; clients can't delete |
| Cloud Functions (2nd gen) | Server actions: first-admin setup, invitations, role changes, member removal, project creation | Node.js; deployed to **us-central1** (the code sets no region; see section 5) |
| Firebase Hosting | Serves the web app over HTTPS | CSP, HSTS, X-Frame-Options set in `firebase.json` |
| Secret Manager | One random server secret (`BOOTSTRAP_SECRET`), used only for first-admin setup | Never leaves Google Cloud |

APIs enabled during deploy (IT can pre-enable them if the deployer can't): `firebase`, `identitytoolkit`, `securetoken`, `firestore`, `firebaserules`, `firebasestorage`, `storage`, `firebasehosting`, `cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`, `eventarc`, `pubsub`, `secretmanager` (all `*.googleapis.com`). Optional: `billingbudgets`.

## 4. Access (IAM) for the deployer

The deployer uses the official Firebase CLI (`firebase-tools`) after a browser sign-in (`firebase login`). **No service-account keys are needed.**

- **Simplest:** *Owner* on the FreeField project(s) only, during setup, reduced afterwards.
- **Least privilege** (confirm against Google's current docs): *Firebase Admin* (`roles/firebase.admin`), *Cloud Functions Admin* (`roles/cloudfunctions.admin`), *Service Account User* (`roles/iam.serviceAccountUser`), *Secret Manager Admin* (`roles/secretmanager.admin`), and *Service Usage Admin* (`roles/serviceusage.serviceUsageAdmin`, if the deployer enables APIs).
- **Why *Editor* isn't enough:** Editor can't grant IAM roles, link billing, change org policies, or make the callable functions publicly invokable (the deploy sets an IAM policy on them).
- **Billing link:** finance, with *Billing Account User* on the billing account (plus *Project Billing Manager* or Owner on the project). The deployer needs no billing rights.
- Docs: https://firebase.google.com/docs/projects/iam/roles-predefined-product · https://cloud.google.com/functions/docs/reference/iam/roles

**Organisation policies to check:**
- *Domain restricted sharing* (`constraints/iam.allowedPolicyMemberDomains`): the app's callable functions must allow `allUsers` as invoker. They check the user's sign-in and role themselves. This project needs an exception, or the functions return 403.
- *Resource locations* (`constraints/gcp.resourceLocations`): allow {{REGION}} **and** `us-central1`.
- *Disable service account key creation*: no impact, since no keys are used.

## 5. Region and data residency

- **Firestore** and the **Storage bucket**: {{REGION}}. **The choice is permanent.** Latin American options include `southamerica-west1` (Santiago) and `southamerica-east1` (São Paulo). Confirm availability with `firebase firestore:locations --project {{PROJECT_ID}}` or https://firebase.google.com/docs/firestore/locations, and in the Console's picker.
- **Cloud Functions run in `us-central1` (USA) today.** The code sets no region, so server actions (invitations, role changes, sign-in completion) process data in the USA even if the database is elsewhere. {{If residency requires in-region processing: "This must be changed in code before go-live; please confirm whether it's required."}}
- **Hosting:** Google's global CDN, static files only. **Authentication:** a global Firebase service (https://firebase.google.com/support/privacy).
- Models, PDFs and calibrations stay in each user's browser **unless an admin publishes a building**; then the converted model and the PDFs go to the bucket above. The original IFC file isn't uploaded.

## 6. Sign-in email

- Firebase sends the one-time sign-in link from **`noreply@{{PROJECT_ID}}.firebaseapp.com`**. Please make sure filters don't quarantine it.
- Link scanners that pre-open URLs can **use up the one-time link** before the user clicks. Please exempt `https://{{PROJECT_ID}}.firebaseapp.com/__/auth/action`.
- Optional: send from our own domain (Firebase Console → Authentication → Templates → customise domain; Firebase shows the DNS records).
- Daily sending limits: https://firebase.google.com/docs/auth/limits
- Invitations aren't emailed by FreeField. An admin copies the invitation link and sends it.
- [WORKSPACE] In the Google Admin console: allow the sender above (e.g. an approved-senders list or a spam bypass rule under Gmail → Spam, phishing and malware). If link protection or pre-delivery scanning rewrites or pre-opens links, exempt the URL above. Users sign in with their existing Workspace email; no Workspace changes are needed beyond this.

## 7. [DOMAIN] Custom domain

Address: `{{CUSTOM_DOMAIN}}`.
1. We add it in Firebase Hosting. The Console then shows the exact **TXT** (ownership) and **A** records. **Please create them exactly as shown** and remove conflicting A/AAAA/CNAME records for that name.
2. The TLS certificate is automatic (minutes, up to about 24 h).
3. We add the domain to Authentication → Authorized domains and to the app's configuration.
4. Domain registration is billed by our **registrar**, not Firebase. A subdomain of a domain we already own costs nothing extra.

## 8. Proxy / firewall allowlist (only if outbound traffic is filtered)

**Users' browsers**, HTTPS 443: {{[DOMAIN] `{{CUSTOM_DOMAIN}}`,}} `{{PROJECT_ID}}.web.app`, `{{PROJECT_ID}}.firebaseapp.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com` (long-lived streaming; please don't buffer or cut it), `firebasestorage.googleapis.com`, `us-central1-{{PROJECT_ID}}.cloudfunctions.net`, `*.run.app`. Optional, only if error reporting is enabled (it's off by default): `*.ingest.sentry.io`.

**The deployer's computer** also needs: `registry.npmjs.org`, `github.com`, `accounts.google.com`, `oauth2.googleapis.com`, `*.googleapis.com`, `storage.googleapis.com`.

## 9. Who deploys

- [USER-DEPLOYS] {{DEPLOYER_NAME}} deploys with the official CLI, using the access in section 4. IT keeps ownership and billing.
- [IT-DEPLOYS] IT deploys. The attached **deploy-steps.md** gives the exact commands, their order and troubleshooting. From the business we provide: the site address (`APP_ORIGIN`) and the first admin's email (`BOOTSTRAP_ADMIN_EMAILS` = {{FIRST_ADMIN_EMAIL}}). After go-live, {{REQUESTER_NAME}} does the first-admin sign-in and invites users.

## 10. Security notes for review

- **Open source (MIT):** code, security rules and server functions are public and reviewable.
- **Local-first:** models, PDFs and calibrations are processed in the browser. Only projects, members, roles, invitations, tasks/photos and explicitly published buildings reach our project.
- **Server-side access control:** Firestore/Storage rules check membership and role (admin/member) on every request. Removing a member revokes access immediately. The rules are tested against the Firebase emulator in CI.
- **No passwords:** email-link sign-in only. The first admin is set up once, from an allow-listed email.
- **No third-party trackers or ads.** Error reporting is optional and off by default.
- **Hardened hosting** (CSP, HSTS, X-Frame-Options DENY, nosniff, Permissions-Policy). The public web API key will be restricted to our domains and the needed APIs.
- **Tenant isolation:** each build is pinned to our project id and refuses to start against another.
- **Resilience:** one-click Hosting rollback, plus scheduled Firestore backups (we'll enable them). [If prod only: updates are tested locally and deployed out of hours.]
- **Support:** community open source, **no vendor SLA**. Infrastructure: Google Cloud (https://status.firebase.google.com).

## 11. Cost: how to estimate it

Pay-as-you-go on our own billing account. **Every product includes a free monthly quota.** A small team is often within it or near it, but please estimate with the official calculator, not from this document.

**Monthly cost ≈** Firestore (document reads + writes + deletes + stored GiB) + Cloud Storage (stored GB + downloaded GB + operations) + Cloud Functions (invocations + compute + outbound data) + Hosting (stored + transferred GB) + Artifact Registry (function build images) + Secret Manager (secret versions + accesses) + backups if enabled, **minus each product's free quota**. [DOMAIN] Plus the domain registrar's fee, billed outside Google.

**What drives it, roughly in order:**
1. **Photos and published models/PDFs:** Storage space, and above all downloads (each teammate who opens a file downloads it).
2. **Tasks:** Firestore reads and writes grow with active users and task volume.
3. Functions, Hosting, Artifact Registry and Secret Manager: usually small.

Official pricing: https://firebase.google.com/pricing · https://cloud.google.com/firestore/pricing · https://cloud.google.com/storage/pricing · https://cloud.google.com/functions/pricing · https://cloud.google.com/run/pricing · https://cloud.google.com/artifact-registry/pricing · https://cloud.google.com/secret-manager/pricing · Calculator: https://cloud.google.com/products/calculator

## 12. What IT does **not** need to provide

No servers, VMs, Kubernetes, self-managed databases or VPN. No software licences. No service-account keys, SMTP server or mail relay. No installs on user devices. No ongoing operations beyond billing oversight{{[USER-DEPLOYS] "; {{DEPLOYER_NAME}} deploys updates with the same commands"}}.

## 13. Contacts

Business owner: {{BUSINESS_OWNER}} · Deployer: {{DEPLOYER_NAME_EMAIL}} · Questions: {{REQUESTER_EMAIL}}
