# Recipes: common FreeField changes, with the real files

Each recipe was checked against the code in this repo. Line numbers drift over time, so search for the named symbol rather than trusting a line. The most reliable test of whether you found every spot is **`pnpm typecheck`**: many lists are typed `Record<…>` and fail to compile when an entry is missing.

## Contents
1. [Add a field to tasks (synced, with rules and exports)](#1-add-a-field-to-tasks)
2. [Add a task type, or a status / workflow step](#2-add-a-task-type-or-a-status)
3. [Add a column to the task table and CSV](#3-add-a-column-to-the-task-table-and-csv)
4. [Add a new left-rail module (route)](#4-add-a-new-left-rail-module)
5. [Connect to an external system with a Cloud Function](#5-connect-to-an-external-system)
6. [Change branding and colours](#6-change-branding-and-colours)
7. [Add or change UI text](#7-add-or-change-ui-text)

---

## 1. Add a field to tasks

**Example:** "Subcontractor responsible" (`trade`), free text up to 80 characters, visible to and editable by the whole team, and shown in the table, CSV and BCF.

**Why so many files?** A task is a Firestore document written through security rules. The same task also renders in the detail panel, table, board, CSV, printed report and BCF export, and edits travel as queued actions with an optimistic preview. The good news: everything is additive and optional, and old tasks simply don't have the field.

**Which existing field to copy:**
- In the **schema** (`TaskSchema`), the only additive optional field is `sheetRefs`. `priority`, `checklist` and `watchers` are *not* in `TaskSchema`. They exist only in the rules, `taskFields.ts`, `merge.ts` (`TaskView`) and the UI.
- For **everything else**, follow `priority`: rules, field model, merge, detail, table, CSV and print. Search for `priority` to see the touch points.

**Count honestly:** a synced field with detail, compose, table, CSV and BCF touches about 14 source files plus 4–5 test files. Dropping compose and BCF brings it to about 10.

### A. Data contract (required)

1. **Schema:** `packages/ff-firestore/src/schema/task.ts`. Add to `TaskSchema` right after `sheetRefs: z.array(TaskSheetRefSchema).max(20).optional(),`:
   ```ts
   /** Subcontractor responsible (optional; absent on older tasks). */
   trade: z.string().max(80).nullable().optional(),
   ```
   This also adds `trade` to the `Task` type used everywhere. Test it in `packages/ff-firestore/__tests__/schema-task.test.ts`.
2. **Security rules:** `packages/ff-firestore/firestore.rules`.
   - In `hasOnlyTaskKeys()`, add `'trade'` to the list. Without this, **every cloud write that carries the field is denied**, even though demo mode works.
   - In `validTaskExtras()`, add a cheap shape check:
     ```
     && (!('trade' in d) || d.trade == null || (d.trade is string && d.trade.size() <= 80))
     ```
   - Only if admins alone may change it: in `match /tasks/{taskId}` → `allow update`, add
     `&& (isAdmin(pid) || !request.resource.data.diff(resource.data).affectedKeys().hasAny(['trade']))`.
3. **Rules test:** `packages/ff-firestore/__tests__/rules-tasks.test.ts`. Copy the `describe("tasks — additive fields: …")` block style, using its `createTaskWrite(...)` and `edit(n, patch)` helpers. Cover a valid value succeeding, a too-long or wrong-type value failing, and an update setting it. These need the emulator (verify.md).

No Dexie change is needed. Cloud tasks live in Firestore, and the demo store saves whole task objects.

### B. Editing and the activity log

4. `packages/ff-tasks/src/taskFields.ts`. This file contains literal NUL characters, so Grep/ripgrep skip it as binary. Read it directly.
   - In `EditableTaskFields`, add `trade: string | null;`.
   - In `FIELD_LABEL`, add `trade: 'subcontractor',`. This text appears in the activity log as "changed subcontractor from A to B".
   - In `diffTaskFields()`, copy the `locationText` branch:
     `if (next.trade !== undefined && (next.trade ?? null) !== (before.trade ?? null)) push('trade', before.trade || 'none', next.trade || 'none');`
   - In `buildEditPatch()`, add `if (keys.has('trade')) patch.trade = next.trade ?? null;`.
   - Test it in `packages/ff-tasks/__tests__/taskFields.test.ts`.
5. `packages/ff-tasks/src/merge.ts` (optimistic preview while an edit is queued):
   - In `TaskView`, add `trade?: string | null;`.
   - Add `'trade'` to `PATCH_OVERLAY_KEYS`.
   - In the synthesized create inside `mergeTaskViews`, add `trade: (doc.trade as string) ?? null,`.

### C. UI

6. **Detail panel:** `packages/ff-tasks-react/src/TaskDetailView.tsx`.
   - Add the prop `trade?: string | null;` to `TaskDetailViewProps`.
   - Add a `<TaskFieldRow<string>>` copied from the **Level** row (text input, `maxLength={80}`). Use `editable={editable}` as the **Type** row does, so closed tasks stay read-only, and `onSave={(v) => p.onEditFields?.({ trade: v.trim() || null })}`.
7. **Detail host:** `packages/ff-tasks-react/src/TaskDetailHost.tsx`.
   - Pass `trade={liveTask?.trade ?? null}` next to `priority={…}`.
   - In `editFields()`, add `trade: liveTask.trade ?? null` to the `before` object.
   - Don't add it to the `caps.extendedFields` deletions unless you want it behind the `VITE_TASKS_EXTENDED_FIELDS` flag (see SKILL.md step 4).
8. **Set it when creating a task.** This is optional, and skipping it keeps the change much smaller.
   - `packages/ff-tasks-react/src/composeModel.ts`: `ComposeFields`, `emptyCompose()`, the `createDoc` in the create builder, `toDraftFields()`, `draftToCompose()`.
   - `packages/ff-tasks/src/drafts.ts`: `TaskDraftFieldsSchema` (`trade: z.string().nullable().optional()`).
   - The input itself in `packages/ff-tasks-react/src/TaskComposeSheet.tsx`.

### D. Where it shows up

9. **Table column** (recipe 3): `packages/ff-tasks-react/src/tableColumns.ts`.
10. **CSV and printed report:** `packages/ff-tasks-react/src/exportTasks.ts`.
    - Add a header to `CSV_HEADERS` and the value in the same position in `buildCsv()`.
    - In `buildTasksReportHtml()`, add `bits.push(cell("Subcontractor", esc(r.trade ?? "—")))`. If `trade` isn't on `TaskTableRow`, widen the local `Extra` type there.
    - Tests: `packages/ff-tasks-react/__tests__/w69Logic.test.ts` covers `buildCsv`.
11. **BCF export.** BCF has no slot for custom fields, so FreeField writes extras into the topic **Description** block.
    - `packages/ff-tasks/src/bcf/types.ts`: add `trade?: string | null` to `BcfTaskSource`.
    - `packages/ff-tasks/src/bcf/writer.ts`: in `buildDescription()`, add `if (nonBlank(t.trade)) ctx.push(\`Subcontractor: ${t.trade.trim()}\`);`.
    - `packages/ff-tasks-react/src/bcfExport.ts`: where the `BcfTaskSource` is built (next to `priority:`), add `trade: t.trade ?? null`.
    - The BCF tests in `packages/ff-tasks/__tests__/bcf/` validate the XML against the official schema. Run them.
12. **Optional extras:**
    - Demo sample values in `packages/ff-tasks/src/demoSeed.ts`.
    - Bulk edit in `packages/ff-tasks-react/src/bulkLogic.ts` + `TaskBulkBar.tsx`.
    - Board card chip in `TaskBoardPanel.tsx`.

**Verify:**
- Typecheck `@ff/firestore`, `@ff/tasks`, `@ff/tasks-react`.
- Run tests for those three.
- Run the emulator rules tests.
- In demo mode: open a task, set the field, check the activity log line, table column, CSV and BCF.

**Deploy order:** rules (`firebase deploy --only firestore:rules`), then hosting. The freefield-deploy skill handles this.

### E. Variant: a pick-list field (choose from a list)

Ask for the actual values before you build. There are two designs:

| | **Fixed list in code** (recommended first) | **List an admin edits in the app** |
|---|---|---|
| Where | An exported `const` next to `TYPE_OPTIONS` in `packages/ff-tasks-react/src/logic.ts`. If the rules should also validate it, put it next to `TASK_PRIORITIES` in `packages/ff-tasks/src/taskFields.ts`. | No mechanism exists yet. The natural home is a new field on the project doc `projects/{pid}`, which members can read and only admins can write. Its rule has **no key allowlist**, so no rules change is strictly needed, though you could add bounds. Extend `ProjectSchema` (`packages/ff-firestore/src/schema/project.ts`). `useCurrentProject()` only exposes `id`/`role`/`name`, so add a small listener on `projectDoc()` (`packages/ff-firestore/src/refs/collections.ts`). You also need an admin editor screen (Settings or Users), and demo mode has no project doc, so fall back to a code list. |
| Changing the list | A code change plus redeploy | Instant, by an admin |
| Effort | Small: the select editor plus the same files as above | A separate feature, about twice the work |

UI for both: copy the **Type** row in `TaskDetailView.tsx` (a `<select>` inside `TaskFieldRow`; unknown old values are kept as an extra option), and the type picker in `TaskComposeSheet.tsx` (`data-testid="compose-type-…"`).

Rules for both:
- Either keep the lenient string-size check from step 2, so list changes need no rules deploy and old values stay valid.
- Or pin the values with `d.trade in [...]` like `priority`. Then every list change needs a rules deploy, and tasks holding a removed value can no longer be edited until it is changed.

Recommend the lenient version.

### F. Variant: a required field

There are three layers, and the right answer is usually **UI only, for new tasks**:
- **UI (do this):** block "Send" in compose when the field is empty. Add the check where `composeModel.ts` throws `ComposeValidationError("title-required")`, show the message in `TaskComposeSheet.tsx`, and optionally use `validate` on the detail `TaskFieldRow`.
- **Schema:** keep it `.optional()` in `TaskSchema`. Existing tasks, demo seed tasks and tasks queued offline before the update don't have it.
- **Rules (avoid):** you *could* add `'trade' in request.resource.data` to `allow create`. But any client that doesn't know the field, such as an old open tab or the upcoming mobile app, could then no longer create tasks. **Never** require it on `allow update`, because every edit to an old task would be denied.

Existing tasks keep showing "—". Sorting the new table column puts missing values last, which makes old tasks easy to find and fill in.

**Must stay on one device only?** Tasks are shared documents, so a per-person private note on a task is unusual. If it is truly needed, it means a new Dexie table keyed by task id (a new `this.version(12)` in `packages/ff-data/src/db/database.ts`). Talk it through before building.

---

## 2. Add a task type or a status

### 2a. A new task **type** (easy, no rules change)

`type` is a free string on the task. The pick-list is `TYPE_OPTIONS` in `packages/ff-tasks-react/src/logic.ts`: Defect, RFI, Snag, Safety, Info, Other.
- Add or rename entries there. Old tasks keep their old value, and the detail editor shows unknown values as an extra option.
- Update the pinned list in `packages/ff-tasks-react/__tests__/logic.test.ts` ("TYPE_OPTIONS is the validated fixed set").
- BCF writes the type as `TopicType`, and CSV and the table show the text automatically.

**Where the type is displayed today, and its colour:**
- **There is no type → colour map.** The detail panel and compose show the type in one neutral chip style (`chipTypeStyle` in `packages/ff-tasks-react/src/formStyles.ts`). The table prints plain text (`TABLE_COLUMNS` "type" in `tableColumns.ts`). **Board cards don't show the type at all** (`TaskBoardPanel.tsx`).
- If the user wants "its own colour", that is a small, visible design change for *every* type. Say so in the plan. The pattern that works (tested end to end):
  - In `packages/ff-tasks-react/src/TaskChips.tsx`, add a `TYPE_TONE: Record<string, CSSProperties>` next to `PRIORITY_TONE` / `DEADLINE_TONE`, reusing the shared `base` style.
  - Add a `typeToneStyle(type)` with unknown or legacy values falling back to the "Other" tone, and a `TaskTypeChip` component (`className="ff-task-type-chip"`) that renders nothing for an empty type.
  - Render `<TaskTypeChip type={t.type} />` in the board card's top row, next to `formatTaskNum(t.num)` in `TaskBoardPanel.tsx`.
  - Test it in the `describe("TaskBoardPanel")` block of `packages/ff-tasks-react/__tests__/uiRefreshV1.test.tsx`.
- Reuse the same chip in the table, list or detail only if the user asks.

### 2b. A new **status** or a changed approval workflow (high risk)

First ask whether a type, priority, checklist item or assignee change already covers the need. A status change touches the workflow every user relies on, and the server enforces it.

The workflow is defined **twice on purpose** and must match exactly:

| What | File | Symbol |
|---|---|---|
| Client state machine | `packages/ff-tasks/src/status.ts` | `TASK_STATUS`, `ALL_STATUSES`, `TERMINAL_STATUSES`, `STATUS_COLORS`, `PAIRS` (verb → legal [from, to]) |
| Server rules | `packages/ff-firestore/firestore.rules` | `legalTaskTransition(from, to)`. The `allow create` also only accepts status 10 or 20. |
| Firestore schema | `packages/ff-firestore/src/schema/task.ts` | `TaskStatusSchema` (and `TaskActionNameSchema` if you add a verb) |
| Parity test | `packages/ff-tasks/__tests__/status.test.ts` | Reads `firestore.rules` and checks it matches `PAIRS`. It fails until both agree. |

Then update the labels and UI. Typecheck finds most of these, because they are `Record<TaskStatus | TaskVerb, …>`:
- `packages/ff-tasks-react/src/logic.ts`: `STATUS_LABELS`, `OPEN_STATUSES` / `CLOSED_STATUSES`.
- `packages/ff-tasks/src/bcf/labels.ts`: `BCF_STATUS_LABELS`. Keep it identical to `STATUS_LABELS`; no test enforces this.
- `packages/ff-tasks-react/src/TaskBoardPanel.tsx`: `BOARD_COLUMNS` (which column a status sits in). Drag rules are in `boardMove.ts`.
- `packages/ff-tasks-react/src/formStyles.ts`: `STATUS_HEX`, only if you introduce a new colour name in `STATUS_COLORS`.
- For a **new verb** (button), also update:
  - `ALL_VERBS`, `TaskVerb` (`status.ts`)
  - `VERB_ICONS`, `VERB_LABELS`, `ACTION_LABELS`, `ACTION_BAR_VERBS` (`detailLogic.ts`)
  - `MOVE_WORDS` (`TasksApp.tsx`)
  - `VERB_TITLES`, `VERB_DOT` (`printDocument.ts`)
  - `STATUS_VERB_LABELS`, `STATUS_VERBS` (`TaskBulkBar.tsx`)
  - `BULK_STATUS_VERBS`, `INVERSE_VERB` (`taskFields.ts`)
  - `ACTION_WORDS` (`packages/ff-tasks/src/bcf/writer.ts`)
- Rules tests in `packages/ff-firestore/__tests__/rules-tasks.test.ts`: add legal and illegal transition cases next to "legal transition: inbox→ongoing…".

Existing tasks keep their status, so no migration is needed when you *add* states. Removing or renumbering a status would strand existing tasks. Don't, unless you plan a migration.

---

## 3. Add a column to the task table and CSV

**Example:** a computed "Days open" column (no new data).

1. `packages/ff-tasks-react/src/tableColumns.ts`:
   - Add `"daysOpen"` to `COLUMN_IDS`, where the order is the column picker order.
   - Add an entry to `TABLE_COLUMNS`:
     ```ts
     { id: "daysOpen", label: "Days open", width: 90,
       sortValue: (r, now) => (r.createdAt ? Math.floor((now - r.createdAt) / 86_400_000) : null),
       filterKind: "number",
       filterValue: (r) => (r.createdAt ? Math.floor((Date.now() - r.createdAt) / 86_400_000) : null),
       render: (r, ctx) => (r.createdAt ? String(Math.floor((ctx.now - r.createdAt) / 86_400_000)) : "—") },
     ```
   - To show it by default, add it to `DEFAULT_VISIBLE_COLUMNS`. People who already saved a column choice (`localStorage` key `ff-task-columns`) won't see it until they tick it in the column picker. Tell the user.
2. Update `packages/ff-tasks-react/__tests__/tableColumns.test.ts`, which pins the exact `COLUMN_IDS` order.
3. **CSV:** `packages/ff-tasks-react/src/exportTasks.ts`. Add to `CSV_HEADERS` and the value at the same index in `buildCsv()`. Cells already go through `csvCell()`, which escapes them and guards against formula injection. Extend `__tests__/w69Logic.test.ts`.
4. A column for a **new stored field** needs recipe 1 first. The table reads whatever is on the task document.

Rows are `TaskTableRow` (`TaskView` plus passthrough doc fields). A field must be on `TaskView` (`packages/ff-tasks/src/merge.ts`) or `TaskTableRow` for the column to typecheck.

---

## 4. Add a new left-rail module

**Example:** a "Reports" page for every project member. The smallest, most fork-friendly option is a folder inside the host app, not a new workspace.

1. Create `apps/settings/src/modules/reports/ReportsApp.tsx` (the `modules/` folder is new) with a default-exported React component. Read data through existing hooks and packages: `@ff/data` accessors, `useProjectId()` from `@ff/auth`, tasks via `@ff/tasks-react`.
2. **Route:** `apps/settings/src/shell/MainShell.tsx`.
   - Next to the other `lazy(...)` modules: `const ReportsApp = lazy(() => import("../modules/reports/ReportsApp"));`.
   - Inside `<Routes>`, before the catch-all `path="*"`:
     ```tsx
     <Route path="/reports" element={
       <RequireProjectMember>
         <ModuleRoute label="Reports"><ReportsApp /></ModuleRoute>
       </RequireProjectMember>
     } />
     ```
     Use `<RequireAdmin>` instead for an admin-only page.
3. **Rail icon:** `apps/settings/src/shell/LeftRail.tsx`.
   - Import an icon from `iconoir-react`. `StatsReport`, `Calendar` and `Truck` exist, for example. Check the name in `node_modules/iconoir-react` if unsure.
   - Add `{ to: "/reports", label: "Reports", icon: <StatsReport />, adminOnly: false }` to `ITEMS`. Top-group items are `adminOnly: false`. Admin items render in the bottom group.
   - Add `"reports"` to the `ActiveRoute` type.
   - Add `if (pathname === "/reports" || pathname.startsWith("/reports/")) return "reports";` to the `activeRoute` memo.
   - **The icon only highlights if `label.toLowerCase()` equals the `ActiveRoute` key**, so keep the label a single plain word, or adapt the comparison.
4. **Phones:** the same `ITEMS` render as the bottom tab bar, so check that it still fits at about 375px wide. Each rail entry gets `data-testid="left-rail-icon-<label>"`.
5. **Tests:** add a render test under `apps/settings/__tests__/`. The shell tests in `__tests__/shell/` show how to mount with demo auth. If an existing test counts rail icons, update it.
6. **Optional:** make it the landing page via `ENTRY_ROUTE` in `apps/settings/src/shell/entryRoute.ts`. Usually you shouldn't, because Models is first so the viewer loads cleanly.

Create a separate `apps/<name>` workspace only when the module is large or shared. Follow `docs/architecture/scaling-rules.md` §7, and remember the exact pins (`typescript` `5.6.3`) checked by `apps/settings/__tests__/workspacePins.test.ts`. Then register its alias in `apps/settings/vite.config.ts` and `apps/settings/tsconfig.json` like `@free-field/documents`, and add it as a `workspace:*` dependency of `apps/settings`.

---

## 5. Connect to an external system

**Rule of thumb:** the browser never talks to the ERP directly. The ERP's secret would end up in the public bundle, and the CSP in `firebase.json` blocks unknown hosts anyway. A Cloud Function in the company's own Firebase project does the talking. This needs a signed-in deployment (functions don't run in demo mode) and is tested with the emulator.

Functions live in `packages/ff-firestore/functions/src/` and are exported from `functions/src/index.ts` (see architecture.md §10). Install the deps once with `npm ci --prefix packages/ff-firestore/functions`.

### 5a. Outbound webhook: "when a task is approved, send it to the ERP"

Create `packages/ff-firestore/functions/src/notifyErp.ts`. This compiles against the repo's `firebase-functions` 6.x:

```ts
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';

const ERP_WEBHOOK_URL = defineString('ERP_WEBHOOK_URL', { default: '' });
const ERP_WEBHOOK_TOKEN = defineSecret('ERP_WEBHOOK_TOKEN');

const APPROVED = 65;

export const notifyErpOnTaskApproved = onDocumentWritten(
  { document: 'projects/{pid}/tasks/{taskId}', secrets: [ERP_WEBHOOK_TOKEN] },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after) return;
    if (before?.status === after.status || after.status !== APPROVED) return;

    const url = ERP_WEBHOOK_URL.value();
    if (!url) return;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ERP_WEBHOOK_TOKEN.value()}`,
        'idempotency-key': event.id,
      },
      body: JSON.stringify({
        projectId: event.params.pid,
        taskId: event.params.taskId,
        number: after.num,
        title: after.title,
        type: after.type,
        approvedAt: after.updatedAt,
      }),
    });
    if (!res.ok) {
      console.error(`ERP webhook answered ${res.status} for task ${event.params.taskId}`);
    }
  },
);
```

Then:
1. Export it from `functions/src/index.ts`: `export { notifyErpOnTaskApproved } from './notifyErp';`.
2. Configure it. The URL goes in `packages/ff-firestore/functions/.env.<project-id>`, a git-ignored file whose template is `.env.example`. Add a commented `ERP_WEBHOOK_URL=` line to `.env.example`. The token is set by the person deploying with `firebase functions:secrets:set ERP_WEBHOOK_TOKEN`. **Never put the token in a file or in chat.**
3. Compile-check it: `pnpm --filter @ff/firestore build:functions`.
4. Test it: add a case to `packages/ff-firestore/functions/__tests__/` (emulator), or run the emulators and watch the log while approving a task.
5. Deploy with freefield-deploy (`firebase deploy --only functions`). Tell IT which outbound host the function calls, in case they restrict egress.

Notes for the user:
- Triggers can fire more than once, which is why the `idempotency-key` header is there. The ERP should ignore repeats.
- Event functions don't retry by default. If the ERP is down, the call is only logged.
- Don't write back into the task document from the function. The client's invariants (`entryCount`, timeline entries) would break.

### 5b. A button: "Send to ERP now" (callable)

Use `onCall` from `firebase-functions/v2/https`. Check `request.auth` and the caller's member doc exactly as `functions/src/setActiveProject.ts` does, read the task with the Admin SDK, call the ERP, and return `{ ok: true }`. Use separate param names (for example `ERP_TASKS_URL` / `ERP_TASKS_TOKEN`) or share one params module, because each name may only be defined once. On the client, call it like `apps/users/src/api.ts` does:
`httpsCallable(getFunctions(app, FUNCTIONS_REGION), 'sendTaskToErp')`. Put the button in the task detail (`TaskDetailView.tsx`), hidden in demo mode (`isDemoAuth()`).

### 5c. Inbound: "the ERP creates or updates tasks in FreeField"

This is advanced. Plan it separately before writing any code. Task writes must keep the invariants the rules and clients rely on: counter allocation, one timeline entry per change, `entryCount + 1`, and legal transitions. That means reusing the transaction shape of `commitTaskAction` (`packages/ff-tasks/src/repository.ts`) in an HTTP function (`onRequest`) authenticated with a shared secret. Prefer a simpler alternative first: a scheduled export (CSV/BCF) or the outbound webhook above.

---

## 6. Change branding and colours

Set expectations first. The logo, favicon, title and main accent are quick. A full re-theme is not, because there are roughly 350 hard-coded hex colours across `src/` folders.

| What | Where |
|---|---|
| Browser tab title | `apps/settings/index.html` → `<title>FreeField</title>` |
| Favicons | `apps/settings/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (keep the file names, or update `index.html`) |
| Logo in rail and header | `apps/settings/src/shell/FreeFieldMark.tsx`: inline SVG, `FF_BRAND_CORAL` accent. Used by `LeftRail.tsx` and `components/Header.tsx`. |
| Logo on the sign-in page | `apps/users/src/auth/SignInPage.tsx` → `/brand/freefield-mark.svg`. Files are in `apps/settings/public/brand/`. |
| App-wide colours | `apps/settings/src/styles/tokens.css`: `--ff-blue-active` (active/accent), `--ff-bg-*`, `--ff-text-*`, `--ff-border`, folder chip colours. |
| Tasks UI palette | `packages/ff-tasks-react/src/formStyles.ts`: `tokens.color` (`primary`, `focusRing`, …), `STATUS_HEX` (status colours), `chipTypeStyle` |
| Chip tones (priority, deadline) | `packages/ff-tasks-react/src/TaskChips.tsx`: `PRIORITY_TONE`, `DEADLINE_TONE` (fixed hexes) |
| PDF viewer accent | `packages/ff-viewer/src/pdf/pdfViewer.css` (`--pv-blue-active`) |
| Font | `--ff-font-stack` in `tokens.css` and `tokens.font` in `formStyles.ts`. Fonts must be self-hosted, because the CSP has `font-src 'self' data:`. |

To find the remaining hard-coded colours, search `#2563eb` (the default blue) and other hex values with Grep in `apps/*/src` and `packages/*/src`.

For fork-friendliness, change token values rather than call sites. Each token change is a one-line diff that rarely conflicts with upstream. Keep the visible "FreeField" name if the company is just hosting it, since the MIT licence only requires keeping the copyright notice in `LICENSE`. Renaming the product throughout is a larger, conflict-prone change. If they want it, do it as its own planned step.

Verify: run the app and check the rail, Settings, Tasks (table, board, detail), Documents, the sign-in page (only reachable with demo mode off), and a phone-width window.

---

## 7. Add or change UI text

**There is no translation system.** Texts are English string literals in the components, and `<html lang="en">` is set in `apps/settings/index.html`. Say this to the user up front.

- **Change a specific text:**
  1. Find the literal with Grep, for example the label "Awaiting approval".
  2. Change it, and also any other copies. Status names exist in `STATUS_LABELS` (`packages/ff-tasks-react/src/logic.ts`), `BCF_STATUS_LABELS` (`packages/ff-tasks/src/bcf/labels.ts`), and the board in `TaskBoardPanel.tsx`.
  3. Update tests that find elements by that text or `aria-label`.
- **Exports:** CSV headers are `CSV_HEADERS` in `packages/ff-tasks-react/src/exportTasks.ts`. Printed report labels are in `exportTasks.ts` and `printDocument.ts`. Activity-log phrases are `FIELD_LABEL` / `describe()` in `packages/ff-tasks/src/taskFields.ts` and `VERB_LABELS` in `detailLogic.ts`. Dates in the activity log use `en-GB` formatting (`formatDateForLog`).
- **Task type names** are stored on the task, so renaming a type in `TYPE_OPTIONS` doesn't rename existing tasks (recipe 2a).
- **The whole UI in Spanish (or bilingual):** this is a real i18n project. It means adding a library or a small message catalogue, extracting every string across most of the 18 workspaces, and updating hundreds of tests. Changing strings in place in a fork conflicts with every upstream update. Recommend proposing i18n upstream as its own plan. If they only need a handful of field-facing words (statuses, types, CSV headers), changing just those is a reasonable stopgap. Say clearly that it will conflict on updates.
