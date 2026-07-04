# Report.Farm — Bootstrap Documentation Set (INDEX)

> **What this is.** The complete planning + orchestration package to build **Report.Farm** — a second SaaS vertical (autonomous farming reports + alerts) on the **AlphaGeo core** — by **cloning the RWR MVP** and adding a **new request pipeline into AlphaGeo and its gateway**. This is a **documentation/planning deliverable**. No app code has been written yet. These docs let a fresh Claude session hand the build to a team of agents and kick it off.

> **How to use it.** Open `docs/00_MEGAPROMPT.md`, paste it into a fresh session, and launch the agent team. The team then works through `docs/05_BOOTSTRAP_SEQUENCE.md` step by step, referring to the other docs as it goes.

---

## Source-of-truth documents (read-only — DO NOT overwrite)

| File | What it is |
|---|---|
| `deep-research-report.md` | The ~900-line product spec / "developer mega-prompt": product thesis, canonical data model, standards matrix, Kafka taxonomy, report/alert templates, pricing, security, acceptance criteria. **This is the product source of truth.** |
| `CLAUDE.md` | Repo guidance for navigating the research report. |

## The build docs (this deliverable — under `docs/`)

| Doc | Purpose | Primary owner (agent) |
|---|---|---|
| [`docs/00_MEGAPROMPT.md`](docs/00_MEGAPROMPT.md) | **Master multi-agent orchestration prompt.** Defines the agent team, shared invariants, kickoff sequence, coordination protocol. Paste-and-launch. | Orchestrator |
| [`docs/01_CLONE_PLAN.md`](docs/01_CLONE_PLAN.md) | **RWR/mvp → Report.Farm clone procedure.** Directory-by-directory copy/re-skin/keep/drop, rename map, re-skin checklist. | Clone Engineer |
| [`docs/02_ALPHAGEO_INTEGRATION.md`](docs/02_ALPHAGEO_INTEGRATION.md) | **The new Report.Farm → AlphaGeo request pipeline.** New gateway router (import-guarded), the request→worker→result flow mirroring RWR's harvest relay, farm-module → AlphaGeo-capability mapping. | AlphaGeo-Integration + Gateway Engineers |
| [`docs/03_DATA_MODEL.md`](docs/03_DATA_MODEL.md) | **The canonical Report.Farm schema** mapped onto Postgres/PostGIS with RLS, reusing RWR's migration runner; relation to AlphaGeo `app_meta.indicator_*`. | Data-Model Engineer |
| [`docs/04_WORKSTREAMS.md`](docs/04_WORKSTREAMS.md) | **Build broken into agent workstreams** with dependencies, phase sequencing, per-workstream acceptance criteria. | Orchestrator + all |
| [`docs/05_BOOTSTRAP_SEQUENCE.md`](docs/05_BOOTSTRAP_SEQUENCE.md) | **The literal first-session runbook** — exact ordered commands from zero to a booting Report.Farm skeleton wired to AlphaGeo. | DevOps + Clone Engineer |
| [`docs/06_DECISIONS.md`](docs/06_DECISIONS.md) | **Session decisions overlay.** Four product/architecture decisions (thin vertical, supply-chain-first wedge, event backbone, deployment-agnostic) reconciled against `00`–`05`; concrete `03`/`04` additions for the supply-chain wedge. | Orchestrator |

## The two layers (never forget this)

```
┌─────────────────────────────────────────────────────────────┐
│  Report.Farm  (agriculture vertical — THE THING WE BUILD)    │
│  Vite/React/TS front end · Node api/v1 · Postgres/PostGIS ·  │
│  MinIO · docker-compose  ── all CLONED from RWR/mvp           │
└──────────────────────────┬──────────────────────────────────┘
                           │  NEW request pipeline (farm relay)
                           │  mirrors RWR's harvest relay
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  AlphaGeo core  (reusable geospatial intelligence substrate) │
│  FastAPI gateway :7777 · postgis container · MinIO · Redis · │
│  MCP (~130 tools) · scan/EO/indicator pipelines · evidence   │
│  ──  we ADD a /api/farm/* surface, additively. Never modify  │
│      core destructively. Exactly like the Indicator Matrix.  │
└─────────────────────────────────────────────────────────────┘
```

## Non-negotiable invariants (carried into every doc)

1. **Multi-tenant isolation.** Every row is `tenant_id`-scoped; Postgres RLS enforced via `SET LOCAL app.tenant_id` / `rwr.tenant_id` (inherited from RWR). Zero cross-tenant leak tolerance.
2. **Additive to AlphaGeo.** The farm vertical adds a gateway surface and consumes existing pipelines. It never edits the frozen `/api/*` core or drops routers. Deploy pattern: docker cp → docker commit → `up -d --force-recreate`. **INSERT, never overwrite** — the box runs ahead of the repo mirror.
3. **Standards-first.** STAC / OGC API / COG / GeoParquet / Zarr / SensorThings before vendor APIs; ISOBUS/ISOXML/ADAPT/MQTT/OPC UA/LoRaWAN/Modbus for machinery+IoT.
4. **Real-data, no fabrication.** Observations/signals/alerts must be backed by real EO round-trips. Honest empty-states, never invented ticks or findings.
5. **Free-EO-first.** Sentinel-2 / Landsat Collection 2 for routine monitoring; commercial imagery only on user-authorized escalation.

## Grounding note

These docs are grounded in the **actual** RWR and AlphaGeo code, not assumptions. Files analyzed include: `D:\Projects\RWR\mvp\api\server.mjs` (harvest relay dual-mode), `D:\Projects\RWR\mvp\.qa-harvest-relay-test.mjs` (the relay contract test), `D:\Projects\RWR\mvp\api\v1\db\pool.mjs` + `migrate.mjs` (RLS `withTenantConn` + idempotent migration runner), `D:\Projects\RWR\mvp\api\ingest-alphageo.mjs` + `api\v1\crm\ingest-core.mjs` (AlphaGeo → detection ingest), `D:\Projects\RWR\mvp\infra\docker-compose.yml` (postgis+geoserver+minio), and `D:\Projects\AlphaGeoCore\infra\hetzner\gateway-deployed\alphageo-api-gateway\phase41_api_gateway.py` (the import-guarded router mount pattern, incl. the existing `harvest_routes` and `imagery` routers).
