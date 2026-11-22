# Contributing to FreeField

Thanks for your interest! Bug reports, fixes, docs and features are welcome.

## Setup

Requirements: Node.js 20+, pnpm 10 (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm --filter settings dev
```

Use `VITE_FF_DEMO_AUTH=true` to run without a Firebase project.

## Checks before opening a PR

```bash
pnpm test                          # Vitest, all workspaces
pnpm typecheck                     # tests are not gated on type errors, run this too
pnpm --filter settings lint        # ESLint (raw `three` imports are banned outside @thatopen/components)
pnpm --filter settings lint:drift  # module boundary check
pnpm build
```

`pnpm test` runs unit tests only and needs no emulator. The `@ff/firestore` rules/functions suites and the `@ff/sync` emulator suite run with `pnpm test:emulator`: they need JDK 21 (the Firestore emulator refuses older Java) and the Cloud Functions package's own dependencies (run `npm ci --prefix packages/ff-firestore/functions` once). Pure schema tests run with `npx vitest run __tests__/schema-*.test.ts` inside `packages/ff-firestore`. A few UI tests can be flaky in a full run; re-run the single test before reporting.

## Pull requests

- Fork, then branch from `main`: `git checkout -b feature/<short-name>`. One feature or fix per branch.
- Keep PRs focused; add or update tests for behavior changes.
- Stage exact files (avoid `git add -A`) so unrelated or local files are never committed.
- Do not commit secrets or local config (`.env*` other than `.env.example` templates). Firebase config for your own project belongs in git-ignored `.env.local` / `.env.production`.
- `@thatopen/fragments` is pinned exactly and patched via `patches/`; keep the pin and patch in sync.
- Describe what changed and why, and how you tested it.

## Reporting bugs and security issues

Open an issue with reproduction steps and the IFC/PDF characteristics if relevant (do not attach confidential models). For vulnerabilities see [SECURITY.md](SECURITY.md).
