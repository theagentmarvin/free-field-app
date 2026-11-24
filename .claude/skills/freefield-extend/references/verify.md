# Verifying a FreeField change

These are the exact commands to run before telling the user a change works. All of them run from the repo root. They come from the root `package.json`, each workspace's `package.json`, and `.github/workflows/ci.yml`.

## Contents
1. [Setup and baseline](#1-setup-and-baseline)
2. [What each workspace can run](#2-what-each-workspace-can-run)
3. [Typecheck](#3-typecheck)
4. [Lint](#4-lint)
5. [Engine drift check (`lint:drift`)](#5-engine-drift-check)
6. [Unit tests (Vitest)](#6-unit-tests)
7. [Emulator tests: security rules, functions, sync (JDK 21)](#7-emulator-tests)
8. [Build](#8-build)
9. [Run the app and show the user](#9-run-the-app)
10. [Reading failures](#10-reading-failures)

---

## 1. Setup and baseline

- You need Node.js 20+ and pnpm 10 (`packageManager: pnpm@10.30.1`). Check with `node -v` and `pnpm -v`. If pnpm is missing, run `corepack enable`.
- Install with `pnpm install`. The settings app's `postinstall` copies the web-ifc WASM into `apps/settings/public/`.
- **Take a baseline before editing.** Run the checks for the workspaces you will touch *before* the change. Then you can tell the user "this failure was already there" with confidence, instead of chasing someone else's bug.
- `pnpm test` is **not** gated on type errors. Always run typecheck as well.
- **A check fails in a workspace you didn't touch?** Reproduce it on the base commit before blaming your change. Two ways:
  - `git stash`, re-run the failing command, then `git stash pop`. This only works when nothing else is uncommitted.
  - A throwaway worktree: `git worktree add ../ff-base <base-commit>`, then `pnpm install` and the failing command there, then `git worktree remove ../ff-base`.

  If it fails there too, it's pre-existing. Tell the user, carry on with per-workspace checks, and don't fix it as a side job.

## 2. What each workspace can run

From each `package.json`. A dash means the script doesn't exist, so that check doesn't cover the workspace.

| Workspace (`--filter`) | typecheck | lint | lint:drift | test | test:emulator |
|---|---|---|---|---|---|
| `@free-field/settings` | ✓ | ✓ | ✓ | ✓ | – |
| `@free-field/models` | ✓ | ✓ | – | ✓ | – |
| `@free-field/documents` | ✓ | ✓ | – | ✓ | – |
| `@free-field/linkview` | ✓ | ✓ | – | ✓ | – |
| `@free-field/users` | ✓ | ✓ | ✓ | ✓ | – |
| `@free-field/hybrid` | ✓ | ✓ | – | (no tests) | – |
| `@ff/tasks` | ✓ | ✓ | – | ✓ | – |
| `@ff/tasks-react` | ✓ | **–** | – | ✓ | – |
| `@ff/firestore` | ✓ | ✓ | – | ✓ (schema/app only) | ✓ rules + functions |
| `@ff/sync` | ✓ | **–** | – | ✓ | ✓ |
| `@ff/data` | ✓ | ✓ | ✓ | ✓ | – |
| `@ff/auth`, `@ff/telemetry`, `@ff/viewer`, `@ff/viewer-react`, `@ff/viewer-tools` | ✓ | ✓ | ✓ | ✓ | – |
| `@ff/types`, `@ff/tooling` | ✓ | – | – | – | – |

Short filter names also work (`--filter settings`, `--filter tasks-react`). The full names above are unambiguous.

## 3. Typecheck

```bash
pnpm typecheck                              # every workspace (turbo), what CI runs
pnpm typecheck --filter=@ff/tasks-react     # one workspace via turbo
pnpm --filter @ff/tasks typecheck           # one workspace directly
```

- Typecheck also runs the compile-time Dexie↔Firestore parity check (`packages/ff-firestore/__tests__/rowParity.types.ts`) and the `apps/settings` tests folder.
- After changing a shared package (`@ff/tasks`, `@ff/firestore`, `@ff/types`), also typecheck the packages that use it: `@ff/tasks-react`, `@ff/sync` and `@free-field/settings`. Running `pnpm typecheck` covers everything.

## 4. Lint

```bash
pnpm lint                                   # every workspace that has a lint script (turbo; builds deps first)
pnpm --filter @free-field/settings lint     # one workspace
```

- ESLint bans raw `three` / `three/*` imports outside the engine (`no-restricted-imports`). `any` and unused vars are warnings, not errors. Don't add new ones.
- `@ff/tasks-react` and `@ff/sync` have **no** lint script. Rely on typecheck and tests there, and keep to the surrounding style.
- `pnpm lint` (turbo) **builds dependencies first** (`"dependsOn": ["^build"]` in `turbo.json`). A build error in an unrelated workspace (for example `@free-field/users#build`) can therefore fail repo-wide lint before your code is linted. Confirm it on the base commit (§1), then lint the workspaces you touched one by one with `pnpm --filter <ws> lint`.

## 5. Engine drift check

The intended command is:

```bash
pnpm lint:drift                             # turbo: every workspace with the script
pnpm --filter settings lint:drift
```

**Known problem:** `apps/settings/scripts/toe-drift-check.js` only runs its `main()` when `import.meta.url === "file://" + process.argv[1]`. That is never true on **Windows** or when the checkout path contains **spaces** (for example `.../Free field/...`). In those cases it prints nothing and exits 0, so a silent pass means "not run". CI doesn't run it either.

Workaround that really runs it, from inside the workspace folder. It is verified on Windows with a path containing spaces:

```bash
cd apps/settings     # or packages/ff-viewer-react, etc.
node --input-type=module -e "import {pathToFileURL} from 'node:url'; const u=pathToFileURL(process.argv[1]).href; process.argv[1]=u.slice(7); await import(u);" "<repo-root>/apps/settings/scripts/toe-drift-check.js" src
```

Replace `<repo-root>` with the absolute repo path. Exit 1 means violations, which are printed as Markdown with rule numbers and suggestions.

**Baseline:** `packages/ff-viewer-react` already reports 29 Rule 14 findings in two files under `src/` (private picker internals referenced outside `src/picking/idPassInterop.ts`). Every other drift-checked workspace is clean. Only *new* findings in files you touched matter. Tell the user the baseline exists rather than fixing it as a side job.

## 6. Unit tests

```bash
pnpm test                                   # every workspace (turbo), no emulator, no Java
pnpm --filter @ff/tasks test                # one workspace
pnpm --filter @ff/tasks test taskFields     # only files whose path matches "taskFields"
pnpm --filter @ff/firestore test            # schema + app tests (rules/functions suites excluded)
```

- Extra arguments go straight to `vitest run`, so a filename fragment narrows the run. Verified: `pnpm --filter @ff/tasks test taskFields` runs `__tests__/taskFields.test.ts` only.
- UI tests use jsdom and Testing Library, and find elements by text, role, `aria-label` and `data-testid`. Changing visible text often means updating a test.
- Known flake: `LevelChecklistPopover` in a full `apps/settings` run. Re-run that single test before you report it.
- Some tests pin lists on purpose: `TYPE_OPTIONS` (`packages/ff-tasks-react/__tests__/logic.test.ts`), table `COLUMN_IDS` (`__tests__/tableColumns.test.ts`), status parity with the rules (`packages/ff-tasks/__tests__/status.test.ts`), and exact dependency pins (`apps/settings/__tests__/workspacePins.test.ts`). When your change is intentional, update the pin and mention it in the plan.

## 7. Emulator tests

These are required whenever `packages/ff-firestore/firestore.rules`, `storage.rules` or `packages/ff-firestore/functions/src/**` change.

**Requirements:**
- **JDK 21+** on PATH (`java -version`). The Firestore emulator refuses older Java with *"firebase-tools no longer supports Java version before 21"*. JDK 21 is needed *only* for these tests.
- The Cloud Functions package's own dependencies, installed once with `npm ci --prefix packages/ff-firestore/functions`.
- CI uses Node 22 for this job because the functions declare `engines.node: 22`. Locally, Node 20 usually works with a version warning.
- Free ports. The `@ff/firestore` suite uses `firebase.json`: 8080 (Firestore), 9099 (Auth), 5001 (Functions), 9199 (Storage). The `@ff/sync` suite uses `firebase.sync-emulator.json`: 8182, 9201, 4412, 4512. The root `pnpm test:emulator` runs them one at a time (`--concurrency=1`).

**Commands:**

```bash
pnpm test:emulator                          # both suites, sequentially
pnpm --filter @ff/firestore test:emulator   # rules (firestore + storage) + functions
pnpm --filter @ff/sync test:emulator        # sync engine against emulated Firestore/Storage
pnpm --filter @ff/firestore build:functions # compile-check the functions only (no emulator)
```

- The `@ff/firestore` script compiles the functions, then runs `firebase emulators:exec --only auth,firestore,functions,storage --project demo-freefield "vitest run … __tests__/rules functions/__tests__/functions"`, using the repo's own `firebase-tools` dev dependency. Nothing touches a real Firebase project.
- **If JDK 21 isn't available,** don't skip silently. Tell the user: "The security-rule change is written and has tests, but I can't run them on this computer (it needs Java 21). Please install Temurin 21, or let the CI 'emulator' job run on the pull request, before deploying." Never deploy untested rules.

## 8. Build

```bash
pnpm build                                  # full build (turbo)
pnpm --filter @free-field/settings build    # the deployable web app -> apps/settings/dist
pnpm build:selfhost                         # build + strip demo seed/samples (what CI and real deploys use)
```

Builds read `VITE_*` values at build time. A real deployment builds with `apps/settings/.env.production`, which freefield-deploy handles. You don't need a production build to show a change locally.

## 9. Run the app

### Demo mode (default, safe, no backend)

```bash
pnpm --filter settings dev
```

- This runs `setup` (copies the WASM and PDF.js assets), then the Vite dev server at **http://localhost:5173** (Vite's default port; the next free one if taken). `apps/settings/.env.development` sets `VITE_FF_DEMO_AUTH=true`.
- **Choosing a port.** The dev script is `apps/settings/scripts/dev-server.mjs`, which **ignores CLI arguments**, and `vite.config.ts` sets no port. So `pnpm --filter settings dev -- --port 5301` does *not* work. This works (verified, serves on 5301):
  ```bash
  pnpm --filter settings run setup
  cd apps/settings
  node --input-type=module -e "await import('tsx/esm'); const { createServer } = await import('vite'); const s = await createServer({ configFile: './vite.config.ts', server: { port: 5301, strictPort: true } }); await s.listen(); s.printUrls();"
  ```
- It opens in **Models**. At the bottom of the left rail, switch **View as → Admin** to unlock Settings, Users and editing.
- **Quickest way to see a task change:** open **Tasks** → **+ New task** (`.ff-task-new`), type a title, pick a type and **Send**. No building is needed. Then use the **Board** tab (`view-tab-board`) or the table.
- **Sample data:** a fresh clone has no pre-built demo seed (`apps/settings/public/seed/` isn't in the repo). Steps:
  1. Go to Settings → **+** tab to create a building.
  2. **Browse** to `apps/settings/public/samples/sample.ifc`.
  3. Click **Get Levels**.
  4. Optionally upload any PDF and use **Map** to calibrate it.
- **Sample tasks** appear automatically after a **page reload** once the first demo building has both an IFC and a PDF. Otherwise, create tasks by hand in Tasks, or from Models/Documents.
- **Phone layout:** open the browser dev tools and use a width under 768px.
- **Reset:** clear the site data for localhost:5173 in the browser. The demo stores everything in IndexedDB/localStorage.
- To stop the server, press Ctrl+C in its terminal. If you started it in the background, stop that process.

Walk the user through it: say exactly where to click and what they should see. Offer a screenshot if a browser tool is available.

### What demo mode can't show

There are no security rules, no sync between devices, no Cloud Functions and no email sign-in. For changes in those areas, rely on the emulator tests (section 7). An advanced option is to run the app against local emulators: create a git-ignored `apps/settings/.env.local` with `VITE_FF_DEMO_AUTH=false`, `VITE_FIREBASE_USE_EMULATOR=true`, `VITE_FIREBASE_PROJECT_ID` and `VITE_EXPECTED_FIREBASE_PROJECT_ID` set to the same `demo-…` id, and placeholder values for the other `VITE_FIREBASE_*` keys. Then start the emulators with `pnpm --filter @ff/firestore exec firebase emulators:start --project <that id>` (needs JDK 21). The repo doesn't document this flow end to end. Signing in and creating the first admin (`BOOTSTRAP_ADMIN_EMAILS`, see `docs/deploy/self-hosting.md` "First admin") take some trial and error, so set expectations before trying it.

## 10. Reading failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `Property 'x' is missing in type … Record<TaskVerb, string>` (or `TaskStatus`) | You added a verb or status. Every label map must have it. | Add the entry in each file typecheck names (recipe 2b). |
| `Object literal may only specify known properties` on a task | Field not added to `TaskSchema` / `TaskView` | Recipe 1, steps 1 and 5. |
| Rules test `assertSucceeds` fails with `PERMISSION_DENIED` | Key missing from `hasOnlyTaskKeys()`, or failing `validTaskExtras()` | Add the key / loosen the shape check in `firestore.rules`. |
| `status.test.ts` "rules and client agree…" fails | `PAIRS` and `legalTaskTransition()` differ | Make both define the same pairs. |
| `rowParity.types.ts` errors | Dexie row type and synced Firestore schema drifted apart | Add the field to both, or to neither. |
| `tableColumns.test.ts` / `logic.test.ts` expected list differs | Pinned list changed intentionally | Update the expectation. |
| Test can't find text "…" | You changed UI text | Update the test's query. |
| ESLint `no-restricted-imports` on `three` | Raw three.js outside the engine | Use the viewer packages (`@ff/viewer`, `@ff/viewer-react`, `@ff/viewer-tools`). |
| Emulator: "Java version before 21" | Old JDK | Install JDK 21, or rely on CI (section 7). |
| Emulator: port already in use | A previous emulator is still running | Stop it, then re-run. |
| Dev server shows a "database updated in another tab" banner | Dexie version bumped while another tab is open | Close other tabs and reload. |
| Works in demo, "Missing or insufficient permissions" when signed in | Rules not deployed, or the field isn't allowlisted | Recipe 1 step 2, then deploy the rules (freefield-deploy). |

Fix the cause. Never delete or `.skip` a failing test, loosen a rule to `if true`, or add `// @ts-ignore` just to get green. If a failure isn't yours and isn't trivial, tell the user and leave it.
