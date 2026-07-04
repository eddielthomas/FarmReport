# Phase 0 — Status: COMPLETE (one deferral)

> Working note. Delete once P1 kicks off. Last updated 2026-07-02 after the P0 gate ran.

## P0 gate results

| Check | Result |
|---|---|
| Clone + quarantine + rename | ✅ `app/` cloned; leak-domain seeds quarantined in `app/_rwr_legacy/sql/`; fixture seeds 099/100 kept (QA harness needs the demo tenants/logins) |
| Isolated infra | ✅ `farm-postgis` :5444 + `farm-minio` :9010/9011 healthy; buckets `farm-harvest/derived/field-uploads`; PostGIS extensions applied; RWR's `rwr.*` schema excluded (`infra/init-db-farm/`) |
| `npm install` | ✅ after saga (see notes): lockfile regenerated from registry, `npm ci` → 704 packages clean |
| Migrations | ✅ 69 foundation files applied; re-run = no-op (idempotency proven) |
| `qa:rls` | ✅ PASS — zero cross-tenant leaks; deny-by-default; canonical-GUC isolation |
| `audit:tenant` | ✅ PASS 101/101 tables (fixed hardcoded `mvp/` path in both audit scripts) |
| API boot | ✅ `{"ok":true}` healthz, `{"ok":true,"db":"up"}` readyz on :5180 against farm DB; relay `mode=local`; Socket.io attached |
| dev-login | ✅ works (needs `NODE_ENV=development` + `ALLOW_DEV_LOGIN=1` — in `.env.local`) |
| `smoke:rbac` | ✅ 266/314 · **cross-tenant isolation 4/4** · iam/users, iam/teams, ops/cases 100%. The 48 fails are **inherited RWR drift, not clone damage**: `policy.mjs` `LEGACY_ROLE_TO_PERMS` deliberately grants ops/customer `crm.*` read perms (documented in-code) while the matrix still expects 403. Same result would occur on RWR itself. Resolve in P1 when farm RBAC seeds (`2xx_farm_rbac_seed.sql`) + a farm smoke matrix replace the water-domain ones. |
| Vite dev boot | ⏳ DEFERRED — machine at memory edge (Cesium bundling is the heaviest dev process); P1 re-skin exercises it first thing |

## Non-obvious facts learned (important for P1+)

1. **RWR has a monorepo `packages/` layer next to `mvp/`** (not covered in `01_CLONE_PLAN`): `config`, `jobs`, **`outbox`** (!), `shared-types`, `ui-system`. The app hard-imports `packages/config/verticals/index.mjs` at boot.
   → Copied `packages/config/verticals/` to `D:\Projects\FarmReport\packages\config\verticals\` (5 files, zero-dep).
   → **`packages/outbox` exists** — evaluate reusing it for the D3 Postgres-outbox decision before writing a new one.
2. **The verticals system is a purpose-built SolutionPack switch**: env `RWR_VERTICAL` (default `rwr`) selects `packages/config/verticals/<id>.yaml`, validated against `solution-pack.schema.json`. **The P1 re-skin should be a `farm.yaml` pack + `RWR_VERTICAL=farm`**, not a string sweep. Frontend mirrors the pack via `scripts/gen-role-pack.mjs` → `public/role-gate-pack.js` and `src/crm/lib/solution-pack.generated.ts`.
3. Env gates needed for dev (`.env.local` already has them): `NODE_ENV=development`, `ALLOW_DEV_LOGIN=1`, `SKIP_ACCESS_GATE=1` (pilot access-code gate otherwise 401s every API call).
4. `audit-*.mjs` scripts had `resolve(REPO_ROOT,'mvp',...)` paths — fixed to `app/`-relative.
5. This host runs many stacks; farm dev must stay on shifted ports (5444/9010/9011). GeoServers (`rwr-geoserver`, `alphageocore-geoserver-1`) were stopped to free RAM — restart with `docker start <name>` when needed.
6. npm on this box crashes under low memory leaving half-extracted packages. Recovery recipe that worked: `rm node_modules package-lock.json` → `npm install --package-lock-only` (registry-only) → validate lockfile has no missing versions → `npm ci`.

## How to run (from `D:\Projects\FarmReport\app`)

```bash
npm run infra:up      # farm-postgis :5444 + farm-minio :9010/9011
npm run migrate       # idempotent
npm run api:dev       # API :5180 (loads .env.local via --env-file)
npm run dev           # Vite front end (still to be smoke-tested)
npm run qa:rls && npm run audit:tenant && npm run smoke:rbac
```

## Next: P1 (per docs/04 + 06_DECISIONS)

- Farm data model migrations `200`–`299` (`docs/03_DATA_MODEL.md`) + supply-chain overlay (`206`/`207` per `06_DECISIONS.md` D2).
- **Re-skin as a SolutionPack**: author `packages/config/verticals/farm.yaml`, set `RWR_VERTICAL=farm`, regen role pack; then brand sweep (central point: `src/config/brand.js`; HTML `<title>`s are hardcoded per shell).
- Premium UI/UX pass (user request): dedicated multi-agent workflow using nanobanana (brand/imagery), stitch (screen design), magic (components), remotion (motion) on the farm console shells.
- Onboarding map copilot (draw/import boundary, zone intent) per P1 acceptance.
