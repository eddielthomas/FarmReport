# 05 — Bootstrap Sequence (the literal first-session runbook)

> **Goal.** The exact ordered steps a fresh agent team runs to go from zero to a **booting Report.Farm skeleton wired to AlphaGeo**: clone → rename → infra up → migrate → seed → first farm onboarded → first AlphaGeo farm-scan round-trips.

> **Owners:** DevOps (A8) + Clone Engineer (A1). Commands are Windows/Git-Bash flavored (the RWR host is Windows 11; `npm run infra:*` uses `docker compose`). Adjust ports if RWR must run alongside.

---

## Pre-flight (5 min)

1. Confirm read access to `D:\Projects\RWR\mvp` and `D:\Projects\AlphaGeoCore`.
2. Confirm Docker Desktop / Rancher Desktop is running (`docker version`).
3. Confirm the AlphaGeo gateway reachability + the shared bearer token (`ALPHAGEO_HARVEST_TOKEN`) — needed for P2, not P0. If unreachable, P0/P1 still proceed; P2 uses a mock gateway (the relay test) until egress is available.
4. Confirm `D:\Projects\FarmReport\` contains only `deep-research-report.md`, `CLAUDE.md`, `BOOTSTRAP.md`, `docs/`. **Do not overwrite the first two.**

## Step 1 — Clone RWR/mvp → FarmReport/app  (A1)

Exclude `node_modules`, build output, QA binaries, and RWR seed/demo artifacts (`01_CLONE_PLAN.md` §1, §5, §8):

```bash
# Git Bash / robocopy via cmd. /E = recurse incl. empty; /XD dirs; /XF files.
robocopy "D:\\Projects\\RWR\\mvp" "D:\\Projects\\FarmReport\\app" /E \
  /XD node_modules dist .qa-proof .qa-s7b-snapshots .mempalace .git \
  /XF "*.zip" "*.png" "*.fig" "_qa_*.json" "leads.json" "*.legacy.bak" "package-lock.json"
```

Then remove RWR-specific seed migrations so the first `migrate` does not inject leak/utility demo rows:

```bash
cd "D:/Projects/FarmReport/app/api/v1/db/sql"
rm -f 099_seed_demo.sql 100_demo_accounts.sql 152_demo_customer_seed.sql \
      168_clients_projects_seed.sql 171_project_asterra.sql
# quarantine RWR sales/vendor modules (optional reference), or delete:
mkdir -p ../../../_rwr_legacy
mv ../../sales ../../vendor-pool ../../../_rwr_legacy/ 2>/dev/null || true
```

## Step 2 — Apply the rename map  (A1)

Per `01_CLONE_PLAN.md` §3. Minimum for boot:

- `app/package.json`: `"name": "rwr-mvp"` → `"report-farm"`.
- `app/infra/docker-compose.yml`: rename containers/db/user/buckets `rwr*` → `farm*` (or keep `rwr` DB name and drive it purely via env — simpler for Phase 0; **decide once**).
- `app/.env.example` → `app/.env.local`: set `PGUSER/PGPASSWORD/PGDATABASE`, `MINIO_*`, and add the AlphaGeo env:
  ```ini
  PGHOST=localhost
  PGPORT=5434
  PGUSER=farm
  PGPASSWORD=farm
  PGDATABASE=farm
  # AlphaGeo farm relay (P2). Leave BASE unset in P0 → relay is 'local'/stubbed.
  ALPHAGEO_FARM_BASE=
  ALPHAGEO_HARVEST_TOKEN=
  ALPHAGEO_GATEWAY_ORIGIN=
  ALPHAGEO_FARM_AUTO_INGEST=0
  ```
- Sweep brand strings in the console shells (`login.html`, `register.html`, `customer.html`, `dashboard-react.html`) — RWR/SpectraCore/leak copy → Report.Farm/farm copy. Marketing pages can be deferred (P4).
- **Do NOT rename the `app.tenant_id` / `rwr.tenant_id` GUCs** in P0 (`01_CLONE_PLAN.md` §3 warning) — they are internal strings referenced by every RLS policy.

> **GUC note.** RWR's `pool.mjs` binds both `app.tenant_id` and `rwr.tenant_id`; policies read `app.tenant_id`. Keep verbatim.

## Step 3 — Install + infra up  (A8)

```bash
cd "D:/Projects/FarmReport/app"
npm install
npm run infra:up          # postgis + minio (+ geoserver if kept) with renamed db/buckets
docker compose -f infra/docker-compose.yml ps    # wait for postgis healthy
```

## Step 4 — First migrate (IAM foundation only)  (A4)

At this point only the kept IAM/RBAC/RLS foundation migrations (`001`–`120`ish) exist; the farm migrations (`200`+) are added in Step 6.

```bash
npm run migrate           # node api/v1/db/migrate.mjs — idempotent; records public._migrations
```

Expect: `[migrate] applying 001_iam.sql … applied … done`. Re-running is a no-op (proves idempotency).

## Step 5 — Boot the skeleton + prove tenancy survived  (A1, A7)

```bash
npm run api:dev &         # node api/server.mjs  (harvest→farm relay in 'local'/stub mode)
npm run dev               # vite — re-skinned console shell
# in another shell — the inherited isolation harness must pass on the clone:
npm run qa:rls
npm run smoke:rbac
npm run audit:tenant
```

**P0 gate:** login works, shell is farm-branded, all three isolation checks pass. (See `04_WORKSTREAMS.md` P0.)

## Step 6 — Add the farm data model  (A4)

Author `200`–`299` per `03_DATA_MODEL.md`, drop them in `app/api/v1/db/sql/`, then:

```bash
npm run migrate           # applies 200_farm_schema … 299_farm_seed_demo, idempotently
npm run qa:rls            # extend the harness to assert farm.* RLS (P1 gate)
```

`299_farm_seed_demo.sql` creates ONE demo tenant + ONE demo farm with a **real** bbox (pick a known Sentinel-2-covered AOI) and **zero** observations.

## Step 7 — First farm onboarded (map)  (A5)

Bring up the onboarding copilot (P1): draw/import a boundary → save FarmProfile → add a zone with intent (e.g. a barn: `standingWaterAllowed:false`). Reuse RWR's `shpjs`/`@tmcw/togeojson`/`gis` upload path. Reject a self-intersecting polygon with a geometry error (research-doc test case).

**P1 gate:** a FarmProfile with parcels + intent-tagged zones is persisted, tenant-scoped, and rendered with out-of-farm context de-emphasized.

## Step 8 — Wire + deploy the AlphaGeo farm surface  (A3, A2)

**8a. Gateway side (A3)** — additive router, per `02_ALPHAGEO_INTEGRATION.md` §4:
```bash
# author src/alphageocore/api/routers/farm.py (delegates to existing scan/indicator pipeline)
docker cp farm.py alphageo-api-gateway:/app/alphageocore/api/routers/farm.py
# INSERT the import-guarded farm block into the running phase41_api_gateway.py (never overwrite)
docker commit alphageo-api-gateway alphageo-api-gateway:farm
docker compose up -d --force-recreate alphageo-api-gateway
docker logs alphageo-api-gateway 2>&1 | grep farm_surfaces_mounted   # verify
curl -s "http://<gateway>/api/farm/signals-by-bbox?west=..&south=..&east=..&north=.." | head
```

**8b. Report.Farm side (A2)** — set the env and prove the relay:
```bash
cd "D:/Projects/FarmReport/app"
# .env.local:
#   ALPHAGEO_FARM_BASE=http://<gateway>/api/farm
#   ALPHAGEO_HARVEST_TOKEN=<shared bearer>
#   ALPHAGEO_GATEWAY_ORIGIN=http://<gateway>
#   ALPHAGEO_FARM_AUTO_INGEST=1
node .qa-farm-relay-test.mjs      # ported from .qa-harvest-relay-test.mjs (mock gateway path)
npm run api:dev                    # now in 'relay' mode → logs: [api] farm mode=relay base=…
```

## Step 9 — First real farm-scan round-trip  (A2)  ⇦ THE GO/NO-GO

```bash
# kick a scan for the demo farm's AOI:
curl -s -XPOST localhost:5180/api/farm/refresh \
  -H 'content-type: application/json' \
  -d '{"farm_id":"<demo>","bbox":[W,S,E,N],"signals":["ndvi","water_stress"]}'
# → 202 {"jobId":"…","mode":"relay"}
# stream progress:
curl -N localhost:5180/api/farm/jobs/<jobId>/events    # farm.progress … farm.complete
# then confirm a REAL observation persisted:
psql "postgresql://farm:farm@localhost:5434/farm" \
  -c "SELECT measurement,value,confidence,scene_id,acquired_at
        FROM farm.observation ORDER BY detected_at DESC LIMIT 5;"
```

**P2 gate (thesis proven):** a `farm.observation` NDVI row with a real value, confidence, and `scene_id` from a real Sentinel-2 scene — tenant-scoped, idempotent on re-run, honest empty-state if the AOI has no coverage. AlphaGeo `/api/*` core unchanged (additive proven).

## Step 10 — Handoff to P3+  

With a real signal flowing, hand off to Reports+Alerts (A6) and the rest of `04_WORKSTREAMS.md`. Every subsequent merge: working code + migration + isolation test + real round-trip.

---

## Quick reference — inherited scripts (from RWR `package.json`)

| Command | Does |
|---|---|
| `npm run infra:up` / `infra:down` / `infra:nuke` | postgis+minio(+geoserver) up/down/wipe |
| `npm run migrate` | idempotent SQL migration runner |
| `npm run seed` | `seed:postgis` + `seed:minio` (re-point to farm data) |
| `npm run api:dev` | Node API (`api/server.mjs`) — farm relay host |
| `npm run dev` | Vite front end |
| `npm run qa:rls` / `smoke:rbac` / `audit:tenant` | tenant-isolation + RBAC + mutation-coverage checks |

## Failure-mode cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `migrate` fails on a farm `*.sql` | edited an already-applied file, or non-idempotent DDL | new numbered file; use `IF NOT EXISTS` + policy-existence guards |
| relay `POST /refresh` 500 `no_bbox` | didn't send `bbox` | always include `bbox:[W,S,E,N]` (RWR guard) |
| gateway boot missing `farm_surfaces_mounted` | router import raised | check `docker logs` for `farm_surfaces_mount_failed error=…`; fix the import; re-commit + force-recreate |
| cross-tenant row visible in `qa:rls` | missing RLS policy or query bypassed `withTenantConn` | add policy (`210_farm_rls.sql`); route through `withTenantConn` |
| observations duplicated on re-scan | missing/incorrect `UNIQUE (farm_id, external_id)` | add the constraint + `ON CONFLICT` upsert |
| AlphaGeo core route changed | overwrote instead of inserted | revert; re-apply as an additive import-guarded block only |
