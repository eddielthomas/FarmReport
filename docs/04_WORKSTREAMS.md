# 04 — Workstreams, Sequencing & Acceptance Criteria

> **Goal.** Break the Report.Farm build into agent workstreams with explicit dependencies and phase gates, drawing the roadmap, acceptance criteria, and test cases from the research doc. Each phase closes only when its acceptance criteria pass in QA.

> **Owner:** Orchestrator (A0); every agent owns its lane.

---

## Phase map (maps to the research-doc roadmap)

```
P0 Clone + Boot ──► P1 Farm data model + onboarding map ──► P2 AlphaGeo pipeline + first signals
                                                                        │
                                              P3 Reports + Alerts ◄──────┘
                                                        │
                                              P4 Copilot + Marketplace (+ metering)
```

Research-doc roadmap alignment: P0+P1 = *Foundation*; P2 = *Core intelligence* (first NDVI/EVI/water-stress signals); P3 = *Alerts and onboarding copilot* + *Executive reporting*; P4 = *Sensor Hub / Marketplace / partnerization*.

---

## P0 — Clone + Boot  (owner A1, DevOps A8)

**Deliver:** a re-skinned, booting Report.Farm skeleton with tenancy/RLS/RBAC intact and AlphaGeo relay stubbed.

Depends on: nothing. Detailed steps: `05_BOOTSTRAP_SEQUENCE.md`; clone rules: `01_CLONE_PLAN.md`.

**Acceptance:**
- [ ] `app/` cloned per `01_CLONE_PLAN.md` (§7 checklist); RWR demo/leak data absent.
- [ ] `npm install` + `infra:up` (postgis+minio, renamed) + `migrate` (IAM foundation only, idempotent) + `dev` all succeed.
- [ ] `qa:rls`, `smoke:rbac`, `audit:tenant` pass on the empty-of-farm-data schema (tenancy survived the clone).
- [ ] Login + tenant switch work; console shell shows farm branding, not RWR.

## P1 — Farm data model + onboarding map  (owner A4 data, A5 frontend)

**Deliver:** the `farm.*` schema live + a map-native onboarding copilot that persists a FarmProfile with parcels + zones (with intent).

Depends on: P0. Schema: `03_DATA_MODEL.md`.

**Acceptance (from research-doc acceptance criteria):**
- [ ] Migrations `200`–`299` apply idempotently; every `farm.*` table RLS-isolated (`qa:rls` extended to farm tables).
- [ ] User can **draw or import** a farm boundary (GeoJSON/Shapefile/KML — reuse RWR's `@tmcw/togeojson`/`shpjs`/`@xmldom/xmldom` deps + `gis` upload flow) and save a FarmProfile.
- [ ] User can create **zones with intent rules** (barn: no water; irrigated field: moisture high-priority; wetland: standing water normal) and persist them.
- [ ] Upload of a self-intersecting polygon is **rejected with a geometry-validation error** (research-doc test case).
- [ ] Onboarding de-emphasizes everything outside the selected farm (research-doc UX).

## P2 — AlphaGeo pipeline + first signals  (owner A2 relay, A3 gateway)

**Deliver:** the `/api/farm/*` pipeline end-to-end — a farm AOI round-trips a scan and persists a real NDVI + water Observation. **This phase is the thesis go/no-go.**

Depends on: P0 (relay clone), P1 (farm + AOI to scan). Contract + build: `02_ALPHAGEO_INTEGRATION.md`.

**Acceptance:**
- [ ] Gateway logs `farm_surfaces_mounted`; `/api/farm/signals-by-bbox` returns 200 (FC or `[]`); AlphaGeo `/api/*` core diff shows only the new farm mount (additive proven).
- [ ] Ported relay integration test passes (mock gateway → `farm.progress`/`farm.complete`).
- [ ] **Real round-trip:** one demo farm AOI → real Sentinel-2 scene → `farm.observation` NDVI row with real `value`+`confidence`+`scene_id`, tenant-scoped, on the map. No fabrication.
- [ ] Re-ingesting the same scene is **idempotent** (no duplicate observations/alerts — research-doc test case).
- [ ] A **cloudy revisit** is masked/flagged; no false signal if confidence too low (research-doc test case).
- [ ] Background ingest (`ingest-farm.mjs`, `ALPHAGEO_FARM_AUTO_INGEST=1`) keeps observations fresh per-tenant.

## P3 — Reports + Alerts  (owner A6, with A2 for signal→alert, A7 QA)

**Deliver:** DerivedSignals from Observations, the alert engine (zone-intent + thresholds, dedup, channels), and the reporting engine (executive + field + irrigation templates; HTML+PDF+JSON companion).

Depends on: P2 (real Observations to reason over). Templates: research doc §Reporting/§Alerting.

**Alert acceptance (research-doc alerting rules + test cases):**
- [ ] Barn zone (`standingWaterAllowed:false`) with a `standing_water` Observation → **critical alert** fires.
- [ ] Irrigation field low-NDVI **but heavy rain forecast** → urgency reduced vs the no-rain scenario.
- [ ] Alert carries **evidence + confidence + estimated impact** (revenue-at-risk); dedup by `dedup_key` so replays don't double-fire.
- [ ] Feedback marking an alert false-positive is recorded (`farm.action_feedback`) and suppresses similar low-confidence future alerts.
- [ ] Channels: email (reuse RWR `email/*` + Resend), plus SMS/push/webhook stubs.

**Report acceptance (research-doc acceptance criteria):**
- [ ] System generates an **executive-monthly** report and a **field** report, each with: executive summary, changes-since-previous, evidence panels (linking `/api/evidence/object` + `/api/imagery/*` tiles), confidence/data-quality notes, ranked recommendations, and a **machine-readable JSON companion**.
- [ ] **Golden-report snapshot test** passes (report is reproducible from the same inputs).
- [ ] Scheduled report generation completes under the research-doc target (~15 min for a ~1,500 ha farm) — instrument, don't fake.

## P4 — Copilot, Marketplace, Metering  (owner A5 copilot, A6/A8 metering, A3 connectors)

**Deliver:** the conversational farm copilot (grounded in the digital twin + reports + AlphaGeo MCP tools), per-tenant metering/quotas, and the connector/marketplace scaffold.

Depends on: P3. Guidance: research doc §Copilot / §Multi-tenant metering / §Marketplace.

**Acceptance:**
- [ ] Copilot answers "what changed this month?" grounded in real Observations/Reports with an evidence chain (answer groundedness, not hallucination).
- [ ] Per-tenant quotas enforced (AOI count, hectares under management, connectors, alerts, API calls) with `billing.usage`-style metering; soft/hard quota behavior.
- [ ] Connector certification checklist scaffolded (research doc §Connector certification): auth sandbox+prod, unit/CRS mappings, idempotent ingestion, stale/offline detection, sample farm-to-alert flow.
- [ ] Sensor Hub base adapters stubbed standards-first (MQTT/OPC UA/Modbus + ISOXML import) behind the canonical Observation model.

---

## Cross-phase QA (owner A7, continuous)

Port RWR's harness and extend to farm per the research-doc testing strategy:

| RWR harness | Farm extension |
|---|---|
| `qa:rls` | RLS on every `farm.*` table; second-tenant read denied |
| `smoke:rbac` | farm permission matrix (`farm:view`/`report:generate`/`alert:manage`/…) |
| `audit:tenant` | every `farm.*` mutation goes through `withTenantConn` |
| `.qa-harvest-relay-test.mjs` | renamed farm-relay test (mock gateway → normalized `farm.*` SSE) |
| — (new) | geometry-validation (self-intersecting polygon rejected) |
| — (new) | golden-report snapshot; alert-precision replay over a scripted incident |
| — (new) | idempotency: re-ingest same scene ⇒ no dup observation/alert |

**Zero cross-tenant leak tolerance** (research-doc SLO) is a hard gate on every phase.

## Dependency graph (who blocks whom)

```
A8 infra ─┐
A1 clone ─┼─► P0 ─► A4 schema ─► A5 onboarding ─► P1
          │              │
          └──────────────┴─► A2 relay ⇄ A3 gateway ─► P2 (first real signal)
                                               │
                             A6 reports+alerts ◄┘  ─► P3
                                               │
                             A5 copilot / A8 metering / A3 connectors ─► P4
```

## Sprint hygiene (every merge — research-doc "sprint deliverables")

Working code in trunk · updated migrations + OpenAPI/event schemas · an RLS/isolation test · runbook note · one-line change summary. Real round-trips, not mocks, gate "done".
