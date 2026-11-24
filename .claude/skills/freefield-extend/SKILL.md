---
name: freefield-extend
description: >-
  Change how FreeField works or add something new to it, guided step by step for
  people who are not programmers. Use this whenever the user wants to modify,
  customise or extend FreeField in any way, in Spanish or English, even if they
  never say "code": "agregar un campo a las tareas", "quiero que FreeField haga X",
  "add a feature", "nuevo tipo de tarea", "add a status", "change the workflow",
  "cambiar el flujo de aprobación", "add a column to the table / CSV / BCF export",
  "un módulo nuevo en el menú", "connect FreeField to our ERP / SAP / webhook",
  "integrar con otro sistema", "personalizar", "cambiar colores/logo", "poner
  nuestra marca", "traducir / cambiar textos", "add a report". Also use it when
  someone asks whether FreeField *can* do something it doesn't do yet. For
  putting FreeField online or asking IT for resources, use freefield-deploy instead.
---

# Extending FreeField

You are helping someone change FreeField, usually a BIM/VDC manager, field engineer or ops lead who knows the job site well and does not write code. You do the engineering. They make the decisions. Your job is to turn "I want X on site" into a small, safe change that their company's fork can keep, and to explain each step in plain words in their language (often Spanish).

Before you start, read `CLAUDE.md` at the repo root for the house rules. Use these references when you need them:

| Read | When |
|---|---|
| `references/architecture.md` | Before planning any change. It maps every app/package, the three data stores, who may write what, the lint boundaries, the demo seed and the env flags. |
| `references/recipes.md` | When the request matches a recipe: task field, task type/status, table/CSV column, new left-rail module, external system via Cloud Function, branding/colours, UI text. Each recipe lists the real files. |
| `references/verify.md` | Before saying "done": the exact typecheck, lint, drift, test and emulator commands, how to run the app in demo mode, and how to read failures. |

## How to talk to the user

- Use their words, not ours. Say "the team will see it on their phones too" rather than "it syncs through Firestore". Bring in a technical term only when they need it to decide something or to tell IT, and explain it in one line.
- Tell them what you are about to do and why before each step, then do it yourself. Don't hand them commands to run unless they ask.
- Ask before anything that costs money, touches a live Firebase project, deploys, pushes to a remote, or deletes data. Demo mode on their laptop is always safe.
- Never ask for passwords, API keys or service-account files in the chat. If a secret is needed, tell them which command will prompt for it (for example `firebase functions:secrets:set NAME`) and let them type it there.
- Never name third-party BIM or construction platforms in code, comments, commits or docs. Describe behaviour in FreeField's own terms. Mentioning Revit is fine only when talking about the Revit exporter.

## The flow

### 1. Understand the request in field terms

Restate what they asked for as a site scenario, for example: "So when the safety officer opens a task, they should pick which subcontractor is responsible, and that name should show in the table and in the Excel export. Is that right?"

Then ask only the 2 or 3 questions whose answers change the design. These are the usual ones:

1. **Who needs to see it?** Only the person on this computer, or the whole team on every device? This decides between local and synced (see step 2), and it is the most important question.
2. **Who may change it?** Anyone on the project, or only admins? Members can already edit tasks. Restricting one field to admins needs a security-rule line.
3. **Where must it appear?** Detail panel, table, board, CSV, printed report, BCF export? Each one is a separate small edit, so only do the ones they need.
4. For a field with choices: **a fixed list, or one an admin edits in the app?** Ask for the actual values. **Is it required?** That usually means required for new tasks only, because old tasks don't have it. Recipe 1 covers the trade-offs.
5. For integrations: **what triggers it and which way does data flow?** For example "when a task is approved, send it to the ERP" (outbound, simple) or "the ERP creates tasks in FreeField" (inbound, much harder).

The app's screens are **English only** (there's no translation system). A Spanish-speaking user will see their new label among English ones. Tell them in the plan (see the template below) and let them choose the label language.

If FreeField already does it, say so and show them how instead of writing code. Examples: the custom filter builder in Models, task type "Other", building `metadata`, the CSV export of the current filtered view.

### 2. Map it to the architecture

Open `references/architecture.md` and decide on four things.

- **Where the code lives.** Shared task logic goes in `packages/ff-tasks`, task UI in `packages/ff-tasks-react`, the Firestore schema and rules in `packages/ff-firestore`, the shell/routing/left rail in `apps/settings/src/shell`, and each module in its own `apps/*`.
- **Where the data lives.** This is the decision that matters most:
  - **Tasks** are cloud documents (Firestore) when signed in, and live in a separate browser database in demo mode. A new task field always needs the zod schema plus the `hasOnlyTaskKeys()` allowlist in `firestore.rules`, otherwise every cloud write that includes it is rejected. In demo mode it simply works, which can hide the problem, so always mention the rules.
  - **Buildings, models, PDFs, calibrations, folders and saved views** are local-first (Dexie / IndexedDB). After an admin publishes a project, they also sync to the company's Firebase. Those synced collections have *exact* key lists in the rules, so a new field there is a bigger change. Per-building extras can often go in the existing `metadata` map instead.
  - **Personal preferences** (column choices, last view) belong in `localStorage`, not in the database.
  - **Members, invitations and projects** are written only by Cloud Functions. Don't add client writes there.
- **Security.** Which rules change, and which rules test proves it.
- **Risk.** Additive optional fields are low risk. New statuses, changed transitions, synced-collection fields and anything inbound from another system are high risk. Say so.

When you are unsure whether data must sync, prefer the smaller option and tell the user what they would gain by syncing later. Moving local data to synced is possible. Un-syncing data the whole team relied on is painful.

### 3. Show a plain-language plan and wait for a yes

Before editing any file, show something like this, in their language:

```
What will change for your team
  - Task detail gets a "Subcontractor" field (pick from a list).
  - It shows in the table (optional column) and in the CSV export.
  - Everyone on the project can see and edit it. It syncs to all devices.

What I'll touch (about 14 files + their tests; a synced task field is
spread out, but each edit is small)
  - Data and security: schema/task.ts, firestore.rules
  - Editing and history: taskFields.ts, merge.ts, drafts.ts
  - Screens: TaskDetailView/Host.tsx, composeModel.ts, TaskComposeSheet.tsx
  - Table and exports: tableColumns.ts, exportTasks.ts, bcf/types.ts,
    bcf/writer.ts, bcfExport.ts
  - Tests: rules, taskFields, table columns, CSV

Language: FreeField's screens are in English (there's no translation
system). The new label will read "Subcontractor" (or "Subcontratista" if
you prefer), and the rest of the app stays in English.

Risk: low (a new optional field; existing tasks are unaffected).
Needs on deploy: security rules first, then the web app (freefield-deploy does this).
How we'll check it: automated checks, then I'll open the app in demo mode and show you.

Shall I go ahead?
```

Use the real file count for the plan you made. Fewer optional parts (for example no compose-time input, no BCF) means fewer files. Wait for an explicit yes. If they change their mind, re-plan and don't patch around it.

### 4. Implement with the house conventions

Work on a branch from the start, after asking. Use `git checkout -b feature/<short-name>`, which is the convention in CONTRIBUTING.md. Then follow these conventions:

- **Small, additive diffs.** The company has a fork and will want to pull upstream updates. New optional fields, new files, and one-line registrations in existing lists merge cleanly. Reformatting files, renaming things or reorganising folders creates conflicts forever. Never reformat code you aren't changing.
- **TypeScript strict, no shortcuts.** Avoid `any`, `as never` and `@ts-ignore`. If the types fight you, the design is usually wrong. Follow the existing patterns: the `normalize*()` readers in `taskFields.ts`, defensive reads of optional fields, and `priorityOf()`-style defaults for old documents that lack the field.
- **Respect the package boundaries.** Apps don't import each other's source; shared code goes in a package. Don't import raw `three` outside the viewer engine (ESLint bans it). Headless logic goes in a non-React package with tests in Node, and React goes in the `-react` package.
- **Data changes travel together.** A synced field means schema + rules + rules test + client code in the same change. A new Dexie table or index means a *new* `this.version(N)` block in `packages/ff-data/src/db/database.ts`. Never edit an existing version.
- **Old data must keep working.** Documents created before your change won't have the field. Treat absent as the default everywhere: in the UI, the sort, the CSV and the BCF export.
- **Tests come with behaviour.** Add or extend a test next to the ones that already cover that file (`__tests__/` in the same workspace). Rules changes always get a case in `packages/ff-firestore/__tests__/rules*.test.ts`.
- **No new dependencies** unless there's no reasonable alternative. If one is needed, explain why and pin it like its neighbours.
- **Feature flags.** If the UI might ship before the rules are deployed, gate it the way `VITE_TASKS_EXTENDED_FIELDS` gates priority and checklist (`packages/ff-tasks-react/src/capabilities.ts`). For a self-hosted fork it's usually simpler to deploy rules first and skip the flag. Ask which they prefer.

Keep the user posted with one short line per milestone ("Schema and rules done; now the detail panel"), not a stream of diffs. Show code only if they ask.

### 5. Verify

Run the checks in `references/verify.md`, in this order:
1. Typecheck the workspaces you touched.
2. Lint.
3. The drift check, only in touched workspaces that have `lint:drift`, using the workaround in verify.md on Windows.
4. Vitest for the touched workspaces.
5. The emulator rules tests whenever `firestore.rules` or `storage.rules` changed. They need JDK 21. If JDK 21 is missing, tell the user plainly that the rules change is untested and must be tested before deploying (CI will run it).

Run a baseline first, so you can tell new failures from old ones. If a check fails in a workspace you didn't touch, reproduce it on the base commit before blaming your change (verify.md §1). When something fails, read the first error, fix the cause, and re-run only that workspace. Don't silence a check to make it pass.

### 6. Run it and show them

Start the app in demo mode with `pnpm --filter settings dev` and open http://localhost:5173. The script takes no `--port`. verify.md §9 shows how to pick a port. Then walk them through exactly where to click: "View as → Admin", which module, which button, what they should now see. Use `references/verify.md` for how to get sample data and tasks into demo mode. If the change only matters when signed in (sync, rules, functions), say that demo mode can't show it and offer the emulator route described in verify.md.

Ask: "Is this what you meant?" Adjust until it is.

### 7. Ship it

- **Commit** on the feature branch. Stage the exact files with `git add <file> <file>`, never `git add -A` or `git add .`. Write a clear message that says what changed for users and why. No secrets and no `.env*` files except `.env.example` templates.
- **Push / PR** only after asking. In their own fork the usual path is a pull request into their `main`, so CI (`.github/workflows/ci.yml`) runs the same checks.
- **Deploy** using the `freefield-deploy` skill. Tell it what changed, because order matters. Rules and indexes go first, then functions, then hosting. A new synced field deployed in the wrong order makes writes from open tabs fail until they reload.
- **Upstream.** If the change would help other companies (not just their branding), offer to prepare a pull request to the public FreeField repo. Keep company-specific bits (names, colours, ERP URLs) out of it.

## Things that commonly go wrong

- **"Works in demo, fails for the team."** Demo mode has no security rules. A new task field needs `hasOnlyTaskKeys()` in `packages/ff-firestore/firestore.rules`, deployed, before cloud writes succeed.
- **New status added in one place only.** The task workflow is defined twice on purpose: in `packages/ff-tasks/src/status.ts` and in `legalTaskTransition()` in the rules. A parity test reads the rules file. Update both, plus labels and board columns (recipe 2).
- **Left-rail item never highlights.** The active state compares `label.toLowerCase()` with the `ActiveRoute` key in `apps/settings/src/shell/LeftRail.tsx` (recipe 4).
- **Changed a visible text and tests broke.** Tests find elements by their text and aria-labels. Update the test along with the text.
- **Search misses `packages/ff-tasks/src/taskFields.ts`.** It contains literal NUL separator characters, so Grep/ripgrep treat it as binary and skip matches. Read the file directly, or use `grep -a`.
- **Drift check "passed" on Windows.** The stock `lint:drift` script silently does nothing on Windows and on paths with spaces. Use the workaround in verify.md.
- **Rebranding misses spots.** Colours are spread across `apps/settings/src/styles/tokens.css`, the tasks palette in `packages/ff-tasks-react/src/formStyles.ts`, and many inline hex values (recipe 6). Set expectations before you start.

## What this repo does not have (say so instead of inventing)

- **No translation (i18n) system.** UI text is inline English in the components. Changing specific strings is easy (recipe 7). Making the whole app bilingual is a large project that touches hundreds of files. Propose it as its own plan, ideally upstream, rather than doing it ad hoc in a fork.
- **No outbound integrations yet.** The Cloud Functions in `packages/ff-firestore/functions/src` handle sign-in, members and projects only. Any ERP/webhook link is new code (recipe 5).
- **No custom-field framework for tasks.** Each new field is a real code change across several files. If they will want many fields, discuss a generic "custom fields" design before adding them one by one.
- Some code comments point at design docs under `docs/integration/`, `docs/ux/` or `docs/SPEC-PHASE-1.md` that are not in the public repo. Don't go looking for them. The code and tests are the source of truth.
