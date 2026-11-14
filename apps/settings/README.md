# apps/settings — FreeField host app

The single web app users open. It hosts the routing shell (left rail, project/building switcher, demo mode) and every module behind lazy routes:

| Route | Module | Source |
|---|---|---|
| `/models` | 3D viewer (landing page) | `apps/models` |
| `/linkview` | PDF plan ↔ 3D, first-person walk | `apps/linkview` |
| `/documents` | PDF plans, measuring, tap-to-pin tasks | `apps/documents` |
| `/tasks` | Issues: table, board, reports | `packages/ff-tasks-react` |
| `/` | Settings — IFC/PDF authoring and calibration (admin) | `apps/settings/src` |
| `/users` | Members and invitations (admin) | `apps/users` |

```bash
pnpm --filter settings dev    # demo mode by default (see .env.development)
pnpm --filter settings test
pnpm --filter settings lint   # also bans raw `three` imports outside the viewer engine
pnpm --filter @free-field/settings build
```

Persistence is local-first: buildings, IFC/PDF versions, calibrations and saved views live in IndexedDB (Dexie, `packages/ff-data`). IFC files are converted in the browser with `web-ifc` (WASM served from `public/`) into `.frag` geometry rendered by `@thatopen/components` / `@thatopen/fragments`. See the root [README](../../README.md).
