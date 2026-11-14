# FreeField Architecture — Scaling Rules

Status: **draft v1** — Architect (2026-06-19). To be ratified after first n>3 app lands.

This document captures the architectural rules that govern FreeField as it grows beyond the current three apps (settings / models / hybrid) and the upcoming Capacitor Android target. The intent is that adding an app or package in three months should be unambiguous — no archaeology, no re-litigation.

---

## 1. App Boundary Discipline

### Rule 1.1 — One app = one deployment target
Each `apps/*` is a separately deployable artifact. The current mapping:

| App | Target | Status |
|---|---|---|
| `apps/settings` | Web (Settings module) | live |
| `apps/models` | Web (Models module) | in development (Task 20) |
| `apps/hybrid` | Android + Web (Capacitor shell) | Phase 3 placeholder |
| `apps/docs` | Web (documentation) | planned, not created |

A new app is justified when there's a distinct deploy target (e.g. `apps/admin-web`, `apps/embed-widget`) OR a team that needs its own release cadence. **Do not create a new app to "isolate" concerns that a shared package would solve.**

### Rule 1.2 — Apps don't import each other's source
Two apps cannot `import` from `apps/<other>/*`. They communicate through:
- **Shared packages** (`packages/*`) — code reuse.
- **Dexie / Firestore / a server** — shared state across apps.
- **Deep links / cross-app nav** — see §3.

If two apps need to share a component, **extract it to `packages/*` first**.

### Rule 1.3 — One agent owns one app at a time
When two agents work the same repo in parallel (Architect + Butler, etc.), each takes one app as their primary domain. Cross-cutting work (shared package edits, root configs) is **serialized** — one agent at a time, with a clear hand-off.

### Rule 1.4 — Apps have their own dev server, but a single turbo pipeline
Each app boots with `pnpm --filter @free-field/<name> dev`. `pnpm dev` at the root runs `turbo run dev --parallel` which boots every app's dev server on its own port (5173, 5174, 5175, …). When n > 4 apps, prefer `turbo run dev --filter=@free-field/<name>` to keep laptop fans quiet.

---

## 2. Package Extraction Policy (YAGNI)

### Rule 2.1 — Extract a package when **two** apps need it
Do not extract on first use. The current `packages/`:

- `ff-viewer` — extracted because Settings AND Models both need headless 3D (Phase 1-lite, 2026-06-19).
- `ff-viewer-react` — same reason, React shell.
- `ff-tooling` — Vite/tsconfig snippets shared by all Vite apps.

Phase 1-proper is on hold. The candidates `ff-core`, `ff-types`, `ff-state`, `ff-design-system` only get extracted when a **second** consumer appears. The design critic flagged premature extraction as the #1 risk.

### Rule 2.2 — Headless first, React second
When extracting a viewer-style capability:
1. `packages/ff-<name>` — headless, no React, no DOM assumptions. Tests run in Node.
2. `packages/ff-<name>-react` — React shell on top. Tests run in jsdom.

This split is what let us move IfcViewer out of Settings without freezing the entire app.

### Rule 2.3 — Packages expose stable contracts, not implementations
- Public surface = typed `index.ts` exports.
- Internal refactors (file moves, helper renames) are free.
- Adding a new export is a **minor** change; removing or renaming is a **major** change and requires a migration note in CHANGELOG.md.

---

## 3. Cross-App Navigation

### Rule 3.1 — No shared router across apps
Each app owns its own React Router (or none). Apps do not embed each other as routes.

### Rule 3.2 — Cross-app links use absolute URLs
`<a href="/settings/calibration">` from Models points to Settings in production. In dev, this is `http://localhost:5173/settings/calibration`. Cross-app links are **hard navigation** (full page load), not client-side router transitions.

### Rule 3.3 — The Hybrid shell is the only place that hosts multiple apps
`apps/hybrid` (Capacitor) is the production shell that mounts Settings + Models + Docs as routes under a single origin. Web deployments keep apps separate.

---

## 4. Mobile / Capacitor Rules (Android + future iOS)

### Rule 4.1 — Pointer events, not mouse events
All interactive surface code in `packages/*` uses **Pointer Events** (`pointerdown`, `pointermove`, `pointerup`). Mouse and Touch are special cases of Pointer — code that targets mouse breaks on touch. Applied in commit `95db037`+`a1c8f1a` to `IfcViewer.tsx`.

### Rule 4.2 — `touch-action: none` on interactive canvases
Containers with custom gesture handling MUST set `touch-action: none` to prevent the WebView from interpreting swipes as scroll/zoom. OrbitControls requires this; our mapping tool now requires it too.

### Rule 4.3 — 40px minimum touch target
`--ff-touch-target: 40px` in tokens. All interactive elements respect it. Mouse-only hover affordances are not allowed in shared components.

### Rule 4.4 — Mobile render budget
TOE + Three.js + WebGL on mobile GPUs is the bottleneck. Settings:
- Devicepixelratio cap: `Math.min(window.devicePixelRatio, 2)` — apply in `IfcViewer.tsx` (Phase 3 task).
- Renderer config: prefer `powerPreference: "high-performance"`, antialias off on low-end devices (future: feature-detect).
- Lazy-load fragments: don't load all storeys at once — load on camera focus.

### Rule 4.5 — Native lifecycle events
Capacitor apps fire `appStateChange`, `resume`, `pause`. The viewer MUST pause the render loop on `pause` and resume on `resume`, otherwise the WebGL context is lost on backgrounding. (Future: wire in `apps/hybrid/src/main.tsx`.)

### Rule 4.6 — File access
Web `<input type="file">` works in Capacitor WebView but only reads from the gallery / Documents provider — not from arbitrary storage paths. For full filesystem access, use `@capacitor/filesystem`. Decision deferred until Phase 3 starts.

---

## 5. Critical Fixes Applied (2026-06-19)

These are the latent issues found during the architect review and the diff audit. Listed here so the next agent doesn't re-discover them.

| # | Issue | Fix | Commit |
|---|---|---|---|
| 1 | `OBC.Raycasters.get(world)` returns a `SimpleRaycaster`, not a `THREE.Raycaster`. `setFromCamera` was called on the wrapper → TypeError at every mouse move during mapping. | Access via `.three` accessor (5 sites). | `95db037` |
| 2 | Mouse-only events in `IfcViewer.tsx` mapping tool. Would break Capacitor Android touch. | Migrate `mousemove` → `pointermove`. Add `touch-action: none`. | (pending) |
| 3 | `IfcViewer` infinite create/destroy loop on `registerFragments` dep change. | Stabilize callback identity. | `17c95c0` (Phase 1-lite) |
| 4 | `hasIfc` gate unmounted IfcViewer on building switch. | Gate on `buildingId` only; viewer handles empty files internally. | `179827e` |
| 5 | `PdfOverlay` `getPdfVersion` / `getPdfBlob` inline async defaults would re-allocate per render. | `useRef` stabilization. | `16c278e` |
| 6 | `viewerSlice={{...}}` inline object in `ViewerPanel` would re-allocate per render. | `useMemo` with primitive deps. | `16c278e` |

---

## 6. Open Decisions (Phase 3 prerequisites)

These need resolution before `apps/hybrid` Phase 3 starts. Do not block on them now.

1. **AppId for Capacitor**: `cl.freefield.app` (placeholder). Confirm with Boss.
2. **Single vs multi-package Capacitor bundle**: Hybrid mounts Settings + Models + Docs as one bundle, or three separate WebViews? Single bundle is simpler; multi-WebView is more isolated.
3. **PWA support**: Are we shipping a PWA alongside the native app? Current `apps/hybrid/index.html` doesn't include a manifest.
4. **PocketBase**: The original brief mentioned PocketBase. Has Boss decided yes/no? If yes, where does it live (`packages/ff-platform/`)? If no, remove from the brief.

---

## 7. How To Add a New App (Checklist)

When the time comes:

1. **Justify against Rule 1.1.** Distinct deploy target or release cadence?
2. **Identify shared needs.** Will it import from existing `packages/*`? If yes, verify the package's contract fits. If a gap exists, propose the package change first (Rule 2.1).
3. **Create `apps/<name>/`** with:
   - `package.json` (`name: "@free-field/<name>"`, `private: true`, `version: "0.1.0"`).
   - `tsconfig.json` extending `../../tsconfig.base.json`.
   - `vite.config.ts` extending `../../packages/ff-tooling/vite.config.base.ts`.
   - `index.html`, `src/main.tsx`, `src/App.tsx`.
   - `__tests__/` with at least one smoke test.
4. **Add `lint:drift` script** mirroring `apps/settings/package.json`. Required by `turbo.json`.
5. **Add to `pnpm-workspace.yaml`** (already wildcarded) and `turbo.json` `dev` / `build` tasks.
6. **Document ownership** in this file (§1 mapping table).
7. **Verify** by running `pnpm install && pnpm --filter @free-field/<name> dev`. The dev server should boot on the next free port (5175+).

---

*Last updated: 2026-06-19. Owner: Architect. Review at: first n>3 app landing, or before Phase 3 Capacitor build.*
