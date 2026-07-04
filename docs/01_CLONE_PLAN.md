# 01 — RWR/mvp → Report.Farm Clone Plan

> **Goal.** Turn `D:\Projects\RWR\mvp` into `D:\Projects\FarmReport\app` (the Report.Farm application), keeping the multi-tenant / RBAC / RLS / migration / AlphaGeo-relay scaffolding intact, and re-skinning the domain from *utility-leak recovery* to *farm intelligence*. This is a **clone + re-skin**, not a rewrite.

> **Owner:** Clone Engineer (A1), with A5 (frontend re-skin) and A4 (data model).

---

## 0. Target layout

```
D:\Projects\FarmReport\
├── deep-research-report.md        # (exists) product source of truth — DO NOT touch
├── CLAUDE.md                      # (exists) — DO NOT touch
├── BOOTSTRAP.md                   # (exists) index
├── docs\                          # (exists) these planning docs
└── app\                           # ← THE CLONE lands here (was RWR/mvp)
    ├── package.json               # renamed rwr-mvp → report-farm
    ├── vite.config.js
    ├── api\                       # Node API + api/v1 routes + migrations
    ├── src\                       # React app
    ├── infra\                     # docker-compose: postgis + minio (+ optional geoserver)
    ├── scripts\                   # seed / qa / audit
    └── *.html                     # marketing/console pages (re-skin or drop)
```

Keeping the clone under `app/` leaves the four existing top-level files (`deep-research-report.md`, `CLAUDE.md`, `BOOTSTRAP.md`, `docs/`) untouched and unambiguous.

## 1. What to COPY verbatim (the scaffolding — inherit, don't rebuild)

These are domain-neutral platform mechanics. Copy them, then re-point/rename only where the domain shows through.

| Path (in RWR/mvp) | Why keep it | Re-skin needed? |
|---|---|---|
| `api/v1/db/migrate.mjs` | Idempotent SQL migration runner (records applied files in `public._migrations`). | No — mechanism only. |
| `api/v1/db/pool.mjs` | The pool + **`withTenantConn(req, fn)`** that binds `app.tenant_id`/`rwr.tenant_id`/`app.clearance`/`app.actor_id` GUCs per tx for RLS. | No — the RLS spine. |
| `api/v1/db/resolve-datasource.mjs` | Per-tenant DSN routing for `isolation_mode='dedicated'`. | No. |
| `api/v1/db/sql/001_iam.sql`, `005_iam_teams.sql`, `110–120_iam_*`, `111_rls_iam.sql` | The whole IAM/tenancy/RBAC/RLS foundation (`iam.tenant`, `iam.user_profile`, RBAC, invites, token revocation, tenant flags/aliases/suspension). | No — foundation. Farm tables reference `iam.tenant`. |
| `api/v1/middleware/*` (`auth.mjs`, `tenant.mjs`, `revocation.mjs`, `flags.mjs`, `policy.mjs`, `accessGate.mjs`) | The request middleware chain: auth → tenant → revocation → flags → permissions. | No — mechanism. RBAC *permission strings* get renamed (see §4). |
| `api/v1/auth*.mjs`, `api/v1/iam/*` | Login (dev + OIDC), registration, users/roles/teams/orgs. | Light — copy text, farm domain terms only. |
| `api/v1/email/*` | Outbox + templates + Resend send + prefs — reused for report/alert delivery. | Templates re-skinned (A6). |
| `infra/docker-compose.yml`, `infra/init-db/*` | postgis (16-3.4) + minio + (optional) geoserver + init SQL. | Rename buckets/db/user (see §3). |
| `scripts/qa-rls.mjs`, `smoke-rbac-matrix.mjs`, `audit-tenant-id.mjs`, `audit-mutation-coverage.mjs`, `seed-postgis.mjs`, `seed-minio.mjs` | The isolation/RBAC/seed test harness. | Re-point at farm tables (A7). |
| `api/server.mjs` **harvest relay section** (lines ~208–680) + `api/ingest-alphageo.mjs` + `api/v1/crm/ingest-core.mjs` | **The AlphaGeo relay + ingest pattern** — the exact template for the farm pipeline. | Re-point + rename (A2 — see `02_ALPHAGEO_INTEGRATION.md`). |
| `src/config`, `src/engines`, `src/features`, `src/dashboard`, dashboard/marketing token CSS | React app shell, map engines, feature modules. | Re-skin heavily (A5). |

## 2. What to RE-SKIN (domain rename — keep the code, change the meaning)

RWR's business domain is **utility leak recovery / field investigation**. Report.Farm's is **farm intelligence**. Map the concepts:

| RWR concept | Report.Farm concept | Notes |
|---|---|---|
| `crm.project` (an AOI to scan for leaks) | **FarmProfile / Parcel** (a farm AOI to monitor) | Same "AOI + tenant + bbox" spine; new farm fields. See `03_DATA_MODEL.md`. |
| `crm.scan` (a leak-detection run) | **farm scan** (an EO monitoring run) | Same run lifecycle (`running`→`complete`, `result_summary`). |
| `crm.detection` (a leak candidate POI) | **Observation / DerivedSignal** (an NDVI/water/stress reading) | Same upsert-by-`(project_id, external_id)` idempotency; new measurement fields. |
| `leak_type`, `verification_result`, `era_score`, `risk_score` | `measurement.name` (ndvi/evi/water_stress), `confidence`, zone-intent status | Re-map in the ingest core (A2). |
| Field investigation / case / dispatch | **Recommendation / ActionFeedback** | Reuse the field/ops modules as the "recommended action + feedback loop." |
| Sales/CRM/vendor-pool modules | **Marketplace** (P4) or **DROP** | RWR's sales pipeline is not core to farm MVP — see §5. |

**Rule:** re-skinning renames *labels, tables, and permission strings*. It does **not** change *how* tenancy, RLS, migrations, auth, or the relay work.

## 3. The rename map (mechanical find/replace + config)

| From | To |
|---|---|
| package name `rwr-mvp` | `report-farm` |
| DB user/pass/db `rwr` / `rwr` / `rwr` | `farm` / `farm` / `farm` (env-driven — `PGUSER`/`PGPASSWORD`/`PGDATABASE`) |
| MinIO buckets `rwr-harvest`, `rwr-derived` | `farm-imagery`, `farm-derived` |
| MinIO root `rwr-admin` / `rwr-admin-secret` | `farm-admin` / `farm-admin-secret` |
| bypass role `rwr_platform` | `farm_platform` |
| tenant GUC alias `rwr.tenant_id` | keep `rwr.tenant_id` **OR** rename to `farm.tenant_id` — **decision: keep `rwr.tenant_id` verbatim** to avoid touching every RLS policy; it is just a namespace string. Document as "GUC namespace inherited from clone base." |
| Env `ALPHAGEO_HARVEST_BASE` / `_TOKEN` / `_GATEWAY_ORIGIN` | `ALPHAGEO_FARM_BASE` / keep `ALPHAGEO_HARVEST_TOKEN` (shared gateway token) / `ALPHAGEO_GATEWAY_ORIGIN` |
| Brand strings ("RWR", "SpectraCore", "OPERATION RECOVER", "Demoville A", leak copy) | Report.Farm branding + farm copy |
| Ports (dev 5175 / preview 5174 / postgis 5434 / minio 9000/9001) | keep as-is locally (RWR and Report.Farm won't run simultaneously on the same box unless you shift ports; if they must coexist, +10 on each) |

> **Careful with GUC rename.** RWR binds *both* `app.tenant_id` and `rwr.tenant_id` in `pool.mjs` (ADR-0021 convergence), and RLS policies reference `app.tenant_id`. The safest clone keeps both GUC names verbatim — they are internal strings, invisible to end users. Renaming them means touching every `111_rls_iam.sql`-style policy and the pool. **Do not rename them in Phase 0.** Optionally rename post-MVP behind a full RLS test sweep.

## 4. RBAC permission re-skin

RWR's RBAC seed (`119_iam_rbac.sql` / `120_iam_rbac_seed.sql`) defines permission strings like `dashboard:view`, `field.*`, `sales.*`. For Report.Farm:

- **Keep** the RBAC *machinery* (roles, permissions, prefix gates in `middleware/policy.mjs` + `accessGate.mjs`) untouched.
- **Add** a new farm-domain permission seed migration (`2xx_farm_rbac_seed.sql`) with strings like `farm:view`, `farm:onboard`, `report:generate`, `alert:manage`, `connector:manage`, `copilot:query`. Default new users to `farm:view`.
- **Prune** RWR-specific permission prefixes (`sales:*`, `vendor:*`) from the default role packs, or leave them dormant (no routes mount them once the sales module is dropped).

## 5. What to DROP (RWR-specific, not needed for farm MVP)

Drop or quarantine (move to `app/_rwr_legacy/` if you want a reference, else delete):

- Sales/CRM pipeline routes not reused as marketplace: `api/v1/sales/*`, `api/v1/vendor-pool/*`, `api/v1/crm/{leads,opportunities,proposals,contracts,vendors,revenue}` — **unless** repurposed later for the P4 marketplace/billing.
- RWR marketing HTML that is utility-industry specific: `industries.html`, `solutions.html`, `platform.html`, `company.html`, `contact.html` in their RWR form. Re-skin the small console shells (`customer.html`, `dashboard-react.html`, `login.html`, `register.html`) to farm; regenerate marketing pages fresh for the farm audience (or defer to P4).
- Demo/QA artifacts and captures: `.qa-*.png`, `*.zip`, `RWR_MAP.fig`, `leads.json`, `_qa_*.json`, `dist/` — do not carry these into the clone.
- RWR-specific seed data: `099_seed_demo.sql`, `100_demo_accounts.sql`, `152_demo_customer_seed.sql`, `168_clients_projects_seed.sql`, `171_project_asterra.sql` — **do not copy**; write fresh farm seed migrations (a demo farm, a demo tenant). Keeping RWR seeds would inject leak/utility demo rows (the exact "fabricated demo" footgun from AlphaGeo history).
- The bundled `src/data/harvest/*` leak JSON — replace with farm sample data (or nothing; prefer live round-trips).

## 6. What to KEEP-BUT-REPOINT (the AlphaGeo relay — critical)

These three files ARE the farm pipeline template. Copy, rename, re-point (full detail in `02_ALPHAGEO_INTEGRATION.md`):

1. **`api/server.mjs` harvest control-plane** → farm control-plane. Rename `/api/harvest/*` → `/api/farm/*`; keep the dual-mode (`local` spawn vs `relay` to gateway) design, the SSE normalize/relay, the job registry, the reaper. Re-point `HARVEST_BASE`→`FARM_BASE` env.
2. **`api/ingest-alphageo.mjs`** → farm background ingest. Keep the "per-project, per-tenant-tx, own scan row" loop; re-point `fetchGatewayLeaks`→`fetchFarmSignals` and `crm.scan`/`crm.detection`→ farm scan/observation tables.
3. **`api/v1/crm/ingest-core.mjs`** → farm ingest core. Keep `centroidOf`, the idempotent upsert-by-external-id, the tenant-GUC-in-tx contract; re-map `severityOf`/`verification_result` → NDVI/water measurement + confidence.

## 7. Re-skin checklist (Definition of Done for the clone)

- [ ] `app/` is a copy of RWR/mvp with `node_modules`, `dist`, `.qa-*` binaries, and RWR seed migrations excluded.
- [ ] `package.json` name = `report-farm`; scripts (`dev`, `api:dev`, `migrate`, `seed`, `qa:rls`, `smoke:rbac`, `audit:tenant`, `infra:up`) all present and re-pointed.
- [ ] Rename map (§3) applied; brand/domain strings swept out of the console shells.
- [ ] IAM/RLS/RBAC/migration scaffolding copied **unmodified in mechanism**; only new farm migrations added (append-only numbering after the highest kept number).
- [ ] RWR-specific sales/vendor/leak modules dropped or quarantined; farm RBAC seed added.
- [ ] `infra:up` brings up postgis+minio with renamed db/buckets; `migrate` applies IAM + new farm migrations idempotently; `dev` boots the re-skinned shell.
- [ ] `qa:rls` + `audit:tenant` pass against the (still empty of farm data) schema — proving tenancy survived the clone.
- [ ] The three relay files are copied + renamed to farm names and stubbed to a gateway stub (real wiring is `02_ALPHAGEO_INTEGRATION.md`).
- [ ] No RWR demo/leak data present anywhere (grep for `leak`, `Demoville`, `asterra`, `676251` returns only comments you intend to keep).

## 8. Practical copy command (Phase 0, DevOps/A1)

Use robocopy so `node_modules` / heavy binaries / QA captures are excluded (exact commands in `05_BOOTSTRAP_SEQUENCE.md` §1). The intent:

```
robocopy D:\Projects\RWR\mvp  D:\Projects\FarmReport\app  /E ^
  /XD node_modules dist .qa-proof .qa-s7b-snapshots .mempalace ^
  /XF *.zip *.png *.fig _qa_*.json leads.json *.legacy.bak
```

Then delete the RWR-specific seed SQL and quarantine the sales/vendor modules per §5 before the first `migrate`.
