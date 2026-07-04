# 08 — Digital Twin Studio: Enterprise Integration Plan

**Status:** Draft for review · **Owner:** Integration Architect · **Depends on:** `02_ALPHAGEO_INTEGRATION.md` §3, `03_DATA_MODEL.md`, `06_DECISIONS.md` (D1–D4), `07_BLUEPRINT.md`, migrations `200–211` under `app/api/v1/db/sql`.

> **Reconciliation note (read first).** The task brief names two canonical docs — `DIGITAL_TWIN_COPILOT_PATTERN.md` and `REPORTFARM_DIGITAL_TWIN_MEGAPROMPT.md`. **Neither file exists** in `D:/Projects/FarmReport` (confirmed by directory listing and `_PROJECT_LOG.md` line 80, which flags the §7.5 twin contract as "not found" yet "governs" P2). Every reference below to "the copilot pattern doc" or "the twin megaprompt" is therefore a **forward reference to a doc that must still be authored**, not an extraction. Claims sourced from those non-existent docs are marked **[ASSUMPTION — doc to author]**. The authoritative, verifiable contract today is: the app-tier `farm.*` schema (migrations 200–211), the live `/api/v1/farm/*` handlers, the documented gateway relay in `02 §3`, and the existing farm UI. This plan is grounded there.

> **Premise correction.** The task states "the AlphaGeo GATEWAY already supports digital-twin logic." **No canonical doc corroborates this.** `02` and `07_BLUEPRINT` describe the gateway as a **stateless EO/scan/indicator/imagery/evidence** surface holding **no twin state**. Twin state is 100% app-tier (`farm.*`). Whether any twin-state endpoint exists on the box is an **empirical unknown** and is the first item in §9. This plan assumes the gateway is EO-only until the gateway survey proves otherwise.

---

## 1. Executive summary

**What the prototype's "Digital Twin Manager / Studio" is.**
The `cconcepts/Farm Report AI` prototype ships a Figma-like, full-bleed 3D satellite **Studio** (`/studio`) for a single farm: a MapLibre map fills the viewport, overlaid by a top layer bar (satellite / NDVI / moisture / thermal), a left tool rail (cursor / pin / measure / zone / parcel / place / rect / circle / row / duplicate / delete / undo / redo), a bottom parcel strip + season-timeline scrubber, and a right tabbed inspector (Copilot / Twins / Reports / Analytics / History). On this substrate users author **digital twins** — a flat array of `Twin` entities in five categories (structure / equipment / crop / livestock / water), each drawn as a `point | rect | circle | polyline` geometry and carrying live status, readings, and ~15 optional operational sub-collections (maintenance, treatments, yields, scan subscriptions, sensor connectors, harvest predictions, supply orders, calendar, routines, docs). Two dedicated routes back it: a **Twins Explorer** grid (`/studio/twins`) and a 16-tab per-twin **dossier** (`/studio/twins/$twinId`). Four React-Three-Fiber scenes supply the visual language, of which one — `parcel-cutaway.tsx` — is genuinely data-driven (a rotating "geological cutaway" cube with a live satellite top face).

**The catch.** The entire prototype is a **client-only sketch**: twins persist in browser `localStorage` (`rf.studio.twins.v1`) via `useSyncExternalStore`; parcels are ephemeral `useState` (`INITIAL_PARCELS`, lost on reload); IDs are `Date.now()+Math.random()`; undo/redo are module-global in-memory stacks; NDVI / `status.online` / harvest predictions are **faked** (`Math.random`, static fields); the copilot (`/api/studio-chat`) is a **stateless, ungrounded** Gemini call through the *Lovable* AI Gateway that never receives any twin/parcel/scan context. There is **no tenancy, no auth, no server, no EO**.

**The enterprise-premium version we will build.**
A **tenant-scoped, server-authoritative Digital Twin Studio** inside Report.Farm that:
- Treats the existing `farm.*` model as the twin's spine — **structure** (`farm_profile` / `parcel` / `zone` / `asset`) + **state** (`scan` → `observation` → `derived_signal` → `alert`) — adding **no new god-object table**; the "twin" is a *composition read* over these plus thin new tables for twin-specific config, layer state, sim runs, and provenance.
- Delegates **all** EO/ML (imagery tiles, NDVI/moisture/thermal indicators, timelines, soil/elevation rasters, harvest predictions) to AlphaGeo via the **additive, import-guarded `/api/farm/*` relay** (never the flag-gated `/v1/*` control plane, never rebuilt in-app) per `06 D1`.
- Slots into the existing farm surface (`FarmConsole` → new `?view=studio` mode) reusing Report.Farm design tokens, `FarmMap`, `BoundaryImport`, `ZoneIntentEditor`, `RiskPill`, `SignalTimeline`.
- Reacts to change events via the **Postgres transactional outbox + Core→app Redis Streams** backbone (`06 D3`) behind the `ChangeEventSource` abstraction (`06 D4`), replacing the prototype's `CustomEvent('rf:twins:change')`.
- Elevates the R3F `parcel-cutaway` into a **premium, EO-fed** parcel visualization (real imagery/soil/DEM through the relay, real parcel metadata, real dimensions).
- Grounds the copilot in the tenant's real twin state and gives it **tool-calling** that writes through `/api/farm/*` and fans out via the event backbone.

Multi-tenancy, RLS, geometry validation (`ST_IsValid → 422`), server-computed hectares, audit, and dual dot-perm/legacy-role gating **already exist** in the farm substrate — the Studio inherits them rather than reinventing them.

---

## 2. Concept mapping

Every prototype concept → the existing Report.Farm artifact it maps to. **REUSE** = port/consume as-is; **ADAPT** = keep the shape, move server-side/tenant-scoped; **BUILD-NEW** = does not exist yet.

| # | Prototype concept | Report.Farm artifact (table / endpoint / component) | Verdict | Notes / grounding |
|---|---|---|---|---|
| 1 | `Twin` god-object (5 categories, ~15 inline collections) | `farm.asset` (points) + composition over `farm_profile`/`parcel`/`zone` + `observation`/`derived_signal` | **ADAPT** | Split the god-object: inline arrays → tenant-scoped related tables/JSONB. No new "twin" table needed for structure (research: "twin needs NO new tables"). |
| 2 | `TwinGeom` union (`point/rect/circle/polyline`) + `twin-geom.ts` helpers | `farm.asset.geom POINT`, `parcel.geom POLYGON`, `zone.geom POLYGON` (PostGIS `geography(4326)`) | **REUSE** (helpers) / **ADAPT** (persist) | Port `twin-geom.ts` (`metersToLngLat`, `circlePolygon`, `rectPolygon`, `translateGeom`, `twinsToGeoJSON`) verbatim — dependency-free. Persist rect/circle as materialized polygons in PostGIS. |
| 3 | Parcel (ephemeral `useState`, `INITIAL_PARCELS`) | `farm.parcel` (persisted) + `GET/POST /farm/farms/:id/parcels` | **REUSE** (backend exists) / **REBUILD** (prototype persistence) | Prototype parcels are lost on reload; Report.Farm already persists them multi-tenant with `ST_Area(geography)/10000` hectares. |
| 4 | Parcel polygon draw + shoelace acreage (`defineParcel`/`polygonAcres`) | `BoundaryImport.tsx` (import/paste only today) + `geometryAreaHa` | **REUSE → ADAPT** | Wire the prototype's freehand draw into `BoundaryImport` — closes the gap the wizard explicitly lacks (import/paste only). |
| 5 | Zone tool + zone intent (implicit) | `farm.zone.intent` JSONB `{expectedWaterFlow, standingWaterAllowed, vegetationPriority, alertSensitivity}` + `ZoneIntentEditor`/`ZONE_TYPES` | **REUSE** | Zone intent **is** the twin's expected-vs-observed contract (research: "zone.intent drives alerting"). Prototype has no equivalent — Report.Farm is richer here. |
| 6 | `StudioLayer` enum (satellite/ndvi/moisture/thermal) | Gateway `GET /api/imagery/{scene}/tiles/...`, `imagery/timeline`, `signals-by-bbox` (via relay) | **REUSE (gateway)** / **BUILD-NEW (wiring)** | Faked in prototype (static `ndvi`). Real values come from AlphaGeo indicator matrix. Layer *selection state* is app-tier UI. |
| 7 | `ScanSubscription` / `scanType` | `POST /api/farm/scan` → `farm.scan` + recurring-scan config (new) | **BUILD-NEW** | The scan-subscription concept maps to enqueuing gateway scans on a cadence; needs a new `twin_scan_subscription` table + scheduler. Delegates compute to gateway. |
| 8 | `SensorConnector` (REST/MQTT/LoRaWAN/Modbus/OPC-UA/OAuth) + `SENSOR_PROVIDERS` | `farm.sensor_connector` (migration 205) + `farm.asset.connectors uuid[]` | **ADAPT** | Connector *vocabulary/enums* reusable as-is (matches standards-first matrix). Persist + tenant-scope; actual ingest is a later connector build. |
| 9 | `status.readings[]` (faked `online`, live values) | `farm.observation` / `farm.derived_signal` (write-only from gateway) | **ADAPT** | Replace `Math.random` online + static readings with real Core-derived observations. Honest empty until P2 relay lands (no-fabrication invariant). |
| 10 | `HarvestPrediction` | `farm.derived_signal` (kind=prediction) / relay-fed | **BUILD-NEW (source)** | Must come from AlphaGeo, not client. Stored as derived signal / report metric. |
| 11 | `YieldRecord`, `Treatment`, `MaintenanceEntry`, `MaintenanceWindow` | `twin_operational_log` (new, JSONB-typed) or `farm.asset.metadata` | **BUILD-NEW** | Operator-entered operational records with no EO dependency; app owns fully. Thin new tenant-scoped table(s). |
| 12 | `CalendarEvent`, `Routine` | `twin_schedule` (new) + outbox events | **BUILD-NEW** | App-owned scheduling; routines that trigger scans call `POST /api/farm/scan`. |
| 13 | `FarmReport` (monthly/harvest/treatment-audit/sensor-health) | `farm.report` (migration 204) + `POST /farm/reports/generate` | **REUSE** | Report generation already exists server-side. Extend `type` enum as needed. |
| 14 | `SupplyItem`/`SupplyCartLine`/`SupplyOrder` + `SUPPLY_CATALOG` | Supply-chain overlay: `supplier`/`sourcing_region` (206) — *buyer==tenant* | **ADAPT / DEFER** | Prototype's e-commerce ordering ≠ Report.Farm's supplier-risk overlay. Real ordering is a separate wedge (D2); catalog seeds reusable as fixtures. |
| 15 | Soil-strata cutaway (`parcel-cutaway.tsx`, static AI texture) | AlphaGeo imagery/soil/DEM via `/api/farm/*` relay + `GET /api/evidence/object` | **ADAPT** | Keep the cube+HUD+shader composition; replace Google-tile fetch with gateway STAC/COG; drive strata from real soil-horizon/DEM/NDVI rasters. Fix circle-area `/4` bug; derive dims from real `widthM/heightM`. |
| 16 | `farm-sims-scene.tsx` (index-hashed fake crops) | — (regenerate from real twins or drop) | **REBUILD / DROP** | Procedural eye-candy; regenerate from per-tenant twins only if kept. |
| 17 | `hero-globe.tsx`, `onboarding-parcel.tsx` (decorative) | Marketing/onboarding visuals | **REUSE AS-IS** | Keep for landing/onboarding; optionally swap random pins for real parcel centroids. |
| 18 | `/api/studio-chat` copilot (stateless Gemini via Lovable Gateway) | New gateway-backed twin copilot relay → `/api/farm/*` grounding + tool-calls | **REBUILD** | Swap provider (pick explicit Claude model id, not a preview), inject twin/parcel/scan context, add real tool-calling. **[ASSUMPTION — copilot pattern doc to author]** |
| 19 | `/api/chat` CrystalGeo onboarding copilot | `OnboardingCopilot.tsx` (5-step wizard, real `/farm/*` writes) | **REUSE (RF wizard) + ADAPT (proto shell)** | Report.Farm onboarding already persists Farm/Parcel/Zone with role gating; adopt the prototype's cinematic shell as a visual upgrade, keep the honest writes. |
| 20 | localStorage persistence (`rf.studio.twins.v1`) | `farm.*` Postgres + `withTenantConn` RLS | **REBUILD** | Single-array localStorage → server API + DB behind `/api/farm/*`. |
| 21 | `CustomEvent('rf:twins:change')` / `storage` event | Postgres transactional outbox + Redis Streams (`ChangeEventSource`) | **REBUILD** | `06 D3/D4`: `RedisStreamSource` (co-located) / signed `WebhookSource` (remote). |
| 22 | Module-global undo/redo stacks (limit 50) | Per-user server-side history / event-sourced audit (`recordAudit`) | **REBUILD** | Global in-memory stacks are non-tenant-safe; rebuild as per-user or drop for MVP. |
| 23 | `Date.now()+Math.random()` IDs | Postgres UUIDs | **REBUILD** | All entities already UUID-keyed in `farm.*`. |
| 24 | 16-tab twin dossier | New twin dossier view (entitlement-gated tabs) | **ADAPT** | MVP keep Overview/Specs/Telemetry/Maintenance/Docs; gate advanced tabs (fusion/scans/yields/treatments/predictions/windows/supply) behind entitlements. |
| 25 | `FarmConsole` URL-query router (`?view=`) | Same `FarmConsole` — add `?view=studio` | **ADAPT** | Studio slots in alongside/replacing `FarmDetail`; longer term → real client router. |
| 26 | Studio chrome (glass panels, tool rail, inspector, scrubber) + `StudioMap` tool state machine | New Studio shell reusing `--panel-glass`, tokens, `FarmMap` base | **REUSE (interaction grammar) / ADAPT (FarmMap → editable)** | `FarmMap` is read-only today; extend to editable/multi-layer. |

**Row count: 26 concept-mapping rows.**

---

## 3. Data model

**Design principle (from research):** the twin's *structure* and *state* already exist in `farm.*`; we add **thin, tenant-scoped** tables only for what has no home — twin config, layer/view state, sim runs, and explicit provenance — and we prefer existing JSONB (`farm_profile.profiles`/`custom_context`, `zone.intent`, `observation.props`, `derived_signal.evidence`, `asset.metadata`) over new columns wherever possible (research: "ADAPT — extend, do not replace").

All new tables: `tenant_id uuid NOT NULL` FK to `iam.tenant`, RLS policy mirroring migration 210, created/updated timestamps, and are written only inside `withTenantConn`. New migrations continue the `212+` sequence.

### 3.1 The twin as a composition (no new structure table)
A "twin" = a **read composition**, not a row:
- **Structure:** `farm.asset` (the physical thing) ⊕ its `parcel`/`zone` context ⊕ `farm_profile`.
- **State:** latest `observation` + `derived_signal` + open `alert` for the asset's zone/geom.
- **Config/ops/layers/sims:** the new tables below.

`farm.asset` already has: `id, farm_id, zone_id, type, name, geom POINT, status, connectors uuid[], metadata JSONB`. Extend the **category vocabulary** (structure/equipment/crop/livestock/water) via `asset.type` + `asset.metadata` (icon, color, specs, kind) — **no schema change** needed for the god-object's core fields.

### 3.2 New tables (migration 212 — `twin_studio`)

```
-- Twin-specific config that has no EO dependency and no natural farm.* home.
farm.twin_config (
  id            uuid PK,
  tenant_id     uuid NOT NULL,
  asset_id      uuid NOT NULL REFERENCES farm.asset(id) ON DELETE CASCADE,
  category      text NOT NULL,           -- structure|equipment|crop|livestock|water
  kind          text,                    -- silo|pivot|sensor|herd|pond ...
  icon          text, color text,        -- presentation (emoji/hex from CATALOG seed)
  geom_spec     jsonb,                   -- original TwinGeom (rect widthM/heightM, circle radiusM, polyline) for editor round-trip
  specs         jsonb,                   -- {sizeLabel, installDate, costUsd, vendor, notes}
  linked_asset_ids uuid[],              -- replaces linkedTwinIds
  version       int NOT NULL DEFAULT 1,  -- optimistic concurrency (etag)
  created_at timestamptz, updated_at timestamptz
);

-- Operator-entered operational records (maintenance/treatment/yield/window) — app-owned, no EO.
farm.twin_operational_log (
  id uuid PK, tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES farm.asset(id) ON DELETE CASCADE,
  kind text NOT NULL,                    -- maintenance|treatment|yield|window|doc
  occurred_at timestamptz,
  payload jsonb NOT NULL,                -- typed per kind (Treatment{category,product,rate,reentryHours}, YieldRecord{...}, etc.)
  created_by uuid, created_at timestamptz
);

-- Scheduling: calendar events + recurring routines + recurring scan subscriptions.
farm.twin_schedule (
  id uuid PK, tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL REFERENCES farm.asset(id) ON DELETE CASCADE,
  kind text NOT NULL,                    -- event|routine|scan_subscription
  cadence text,                          -- daily|weekly|monthly|seasonal (routines/subs)
  next_run_at timestamptz, active bool DEFAULT true,
  action jsonb,                          -- {scanType, signals[], provider} for scan_subscription -> POST /api/farm/scan
  payload jsonb,                         -- CalendarEvent/Routine fields
  created_at timestamptz, updated_at timestamptz
);

-- Layer / view state per user per farm (satellite|ndvi|moisture|thermal, opacity, active parcel, timeline position).
farm.twin_layer_state (
  id uuid PK, tenant_id uuid NOT NULL,
  farm_id uuid NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  active_layer text, layer_opacity numeric, active_parcel_id uuid,
  timeline_at timestamptz, view jsonb,   -- camera, isolate, labels
  updated_at timestamptz,
  UNIQUE(tenant_id, farm_id, user_id)
);

-- Simulation runs (what-if / scenario). App stores request+result; COMPUTE delegates to gateway (see §4).
farm.twin_sim_run (
  id uuid PK, tenant_id uuid NOT NULL,
  farm_id uuid NOT NULL, asset_id uuid,
  sim_type text NOT NULL,                -- irrigation|yield|disruption|... (spec-compatible names)
  status text NOT NULL,                  -- queued|running|complete|error
  gateway_job_id text,                   -- if delegated to AlphaGeo
  request jsonb NOT NULL,                -- scenario inputs
  result jsonb, evidence jsonb,          -- provenance-linked outputs
  requested_by uuid, created_at timestamptz, completed_at timestamptz
);

-- Explicit provenance for any twin-visible derived value (which scan/scene/model produced it).
farm.twin_provenance (
  id uuid PK, tenant_id uuid NOT NULL,
  subject_type text NOT NULL,            -- observation|derived_signal|sim_run|prediction|layer
  subject_id uuid NOT NULL,
  source text NOT NULL,                  -- gateway|sensor_connector|operator|sim
  gateway_job_id text, scene_id text, model text, collection text,
  acquired_at timestamptz, recorded_at timestamptz,
  evidence_ref text                      -- GET /api/evidence/object key
);
```

**Notes & assumptions**
- **No god-object.** The prototype's ~15 inline arrays are decomposed into `twin_operational_log` (maintenance/treatment/yield/window/doc), `twin_schedule` (events/routines/scan-subs), `farm.sensor_connector` (existing), `farm.report` (existing), and existing state tables — per research REUSE/REBUILD guidance.
- **State stays write-only from gateway.** `observation`/`derived_signal`/`alert` are never seeded (no-fabrication invariant). Predictions/harvest are `derived_signal` rows or report metrics fed by the relay — **not** client `Math.random`.
- **Sim model is genuinely new.** Research: "there is NO simulation state model … must be built new." `twin_sim_run` stores request/result/provenance; **compute is delegated** (gateway) or is a thin app-side deterministic calc — **[ASSUMPTION — sim compute location pending §9 gateway survey]**.
- **Soil profile is genuinely new.** No soil model exists in the prototype (`soil` is a CSS token). Soil-horizon data for the cutaway comes from AlphaGeo (SoilGrids/DEM) via the relay; if cached app-side, store as `twin_provenance`-linked raster refs, not new geometry.
- **Concurrency:** `twin_config.version` replaces the prototype's `updatedAt`-only optimism; the R3F/undo layer no longer owns truth.
- **RLS:** every table gets a policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)`; the `farm_platform` BYPASSRLS role is used only by the ingest/relay/sim workers (mirrors migration 210 + the `farm_platform BYPASSRLS` role noted in `02`).

---

## 4. API surface

**Rule (D1):** the app **owns twin state, config, ops, scheduling, layers, sim orchestration, provenance**; the app **delegates all EO/indicator/imagery/sim-compute** to AlphaGeo via the **additive, import-guarded `/api/farm/*` relay** (`02 §3`). Never the `/v1/*` control plane (flag-gated OFF). Never rebuild EO/ML.

### 4.1 App-owned (new/extended `/api/v1/farm/*` read+write endpoints)
All run inside `withTenantConn` (RLS) with `farmGate(req,res,dotPerm,...legacyRoles)` and `recordAudit`.

| Method + path | Purpose | Notes |
|---|---|---|
| `GET /farm/farms/:id/twins` | **Twin-state composition read** — assets ⊕ zone/parcel context ⊕ latest observation/derived_signal/open alerts ⊕ twin_config | **BUILD-NEW.** No new persistence — composes existing tables (research: "compose both without new tables"). Honest empty state until P2 ingest. |
| `GET /farm/twins/:assetId` | Single-twin dossier payload (config + ops log + schedule + connectors + latest state + provenance) | Backs the dossier route. |
| `POST /farm/farms/:id/twins` / `PUT /farm/twins/:id` / `DELETE` | Create/update/delete asset + twin_config (geometry validated `ST_IsValid → 422`, `version` etag `→ 409` on conflict) | Wraps `farm.asset` + `twin_config`. |
| `POST /farm/twins/:id/ops` | Append operational log (maintenance/treatment/yield/window/doc) | App-owned, no EO. |
| `GET/POST/PUT/DELETE /farm/twins/:id/schedule` | Calendar events / routines / scan subscriptions | Scan-subscription rows enqueue `POST /api/farm/scan` on `next_run_at` via scheduler worker. |
| `PUT /farm/farms/:id/layer-state` | Persist per-user layer/view/timeline state | Replaces localStorage view state. |
| `POST /farm/twins/:id/sims` / `GET /farm/sims/:id` | Create/read a sim run | **Orchestration app-side; compute delegated** (see 4.3) — **[ASSUMPTION pending §9]**. |
| `GET /farm/twins/:id/provenance` | Provenance chain for any twin value | Feeds "what changed & why" evidence UI. |
| *(existing, reuse)* `POST /farm/reports/generate`, `GET /farm/alerts`, `POST /farm/alerts/:id/ack`, `GET /farm/observations`, `/portfolio/*` | Reports, alerts, rollups | Already live; the Studio consumes them. |

### 4.2 Gateway-owned (consumed through the relay — the app never computes these)
Documented in `02 §3` + reused existing gateway surfaces:

| Gateway endpoint (relay/consume) | Feeds in Studio | Source |
|---|---|---|
| `POST /api/farm/scan` → `202 {job_id}` | Twin scan trigger, scan subscriptions | `02 §3.1`; delegates `scan_pipeline.enqueue` |
| `GET /api/farm/jobs/{job_id}/events` (SSE) | Live scan progress in inspector (interactive) | `02 §3`; `normalizeHarvestTick` → `farm.progress/complete/error` |
| `GET /api/farm/signals-by-bbox?...` → GeoJSON FC | NDVI/moisture/thermal layer values, twin readings | `02 §3.3`; indicator-instances federation |
| `GET /api/imagery/{scene}/tiles/{z}/{x}/{y}.png` + `tilejson.json` | Map raster layers, cutaway top face | existing gateway — **reuse** |
| `GET /api/imagery/timeline?bbox=&context=optical\|sar` | Season timeline scrubber | existing — **reuse** for twin timeline |
| `GET /api/evidence/object?bucket=&key=` | Evidence drill-downs, provenance artifacts | existing proxy — **reuse** |

**App relay files to clone** (`02 §3`, RWR lineage): `server.mjs` harvest section → `POST /api/farm/refresh`, `GET /api/farm/jobs/:jobId/events`, `GET /api/farm/signals-by-bbox`; plus `ingest-alphageo.mjs` / `crm/ingest-core.mjs` re-pointed to farm names (write `farm.scan` + `farm.observation`, idempotent upsert by `UNIQUE(farm_id, external_id)`). Auth: `Authorization: Bearer $ALPHAGEO_HARVEST_TOKEN` + nginx IP-gate.

### 4.3 Sim & soil compute — delegation decision **[ASSUMPTION — pending §9]**
Per D1 the app builds **no EO/ML**. Simulations that need EO/agronomic modeling (yield-at-risk, irrigation, disruption) **must** delegate to AlphaGeo — either an existing gateway sim primitive (unknown; §9) or, if none exists, they are **scoped down to deterministic app-side calculations over already-relayed indicator data** for the MVP, with heavy modeling deferred until the gateway exposes a sim surface. `twin_sim_run.gateway_job_id` is populated only when delegated.

### 4.4 Change events (D3)
On any twin state change, the ingest/sim workers write a **Postgres transactional outbox** row; a dispatcher publishes spec-compatible events — `ingest.normalized.observation.v1`, `signal.derived.v1`, `alert.created.v1` (+ new `twin.updated.v1`, `sim.completed.v1` **[names to ratify]**). Core→app freshness arrives via **Redis Streams `XREAD`** behind `ChangeEventSource` (`RedisStreamSource` co-located / signed `WebhookSource` remote). The Studio subscribes over SSE/WebSocket to push live readings/alerts into the inspector — replacing the prototype's `CustomEvent('rf:twins:change')`.

---

## 5. Frontend

### 5.1 Where it slots in
- **Mount point:** `FarmConsole` (the `operations.html` URL-query router) gains **`?view=studio`** (and `?view=studio&farm=uuid&twin=uuid`) alongside `onboard` / default / `?farm=`. The Studio is its **own fixed-inset shell** (like the prototype — it does **not** use `ConsoleShell`). **ADAPT** of concept-map row 25. Longer term, migrate `FarmConsole`'s full-reload query router to a real client router (research REBUILD note).
- **Routes/views:** Studio workspace (`?view=studio`), Twins Explorer (grid), Twin dossier (entitlement-gated tabs). MVP dossier tabs: **Overview / Specs / Telemetry / Maintenance / Docs**; gate fusion/scans/yields/treatments/predictions/windows/supply behind entitlements (research ADAPT guidance).

### 5.2 Reuse from Report.Farm (design tokens + primitives)
- **Tokens only** (hard rule): `.crm` wrapper, `--bg/--surface*/--fg*/--accent*/--border*/--radius-*/--shadow-*/--panel-glass`, dark "Mission Control" default. The prototype's "clay glass" panels map directly to `--panel-glass` + `backdrop-blur`.
- **`FarmMap`** as the base map — **ADAPT** from read-only to **editable/multi-layer** (draw/select/edit zones, layer toggles, time scrubbing) rather than rebuilding base-layer + WebGL-fallback plumbing.
- **`BoundaryImport`** (file/paste, `shpjs`/`togeojson`, `geometryAreaHa`, `GeometryPreview`) — the single most valuable reuse asset; **add** the prototype's freehand polygon draw + shoelace acreage into it.
- **`ZoneIntentEditor` / `ZONE_TYPES` / `classifyZone` / `ZONE_KIND`** — the zone-intent (expected-vs-observed) editor.
- **`RiskPill` / `RiskLegend`** — enforced color+icon+label; use for all twin state/risk display (null band → "Unmonitored", never fake-green).
- **`SignalTimeline`** — extend its ghost-axis honest-empty feed into the "what changed" panel with real NDVI sparklines + evidence drill-downs.
- **Hoist** the duplicated inline `Panel`/`SectionHead`/`EmptyNote`/`KpiChip` into a shared `farm-ui` module the Studio also consumes.

### 5.3 Port from the TanStack/R3F prototype (R3F is Vite-native)
- **Verbatim:** `twin-geom.ts` (geometry helpers), the `TwinGeom` union as the client geometry vocabulary, `CATALOG`/`SENSOR_PROVIDERS`/`SUPPLY_CATALOG` as fixtures/enums.
- **`StudioMap` interaction grammar:** the tool state machine (`cursor/pin/measure/zone/parcel/place/rect/circle/row`), drag-to-move (`translateGeom`), drag-to-draw rect/circle, click-to-add polyline, isolate mask, layer paint presets, twin GeoJSON source/layer wiring, keyboard shortcuts (Cmd+Z/Y, Cmd+D, Del, Esc). Rehost on the extended `FarmMap`/MapLibre base. Both prototype and Report.Farm use **MapLibre GL** already — low-friction port.
- **`parcel-cutaway.tsx` → premium visualization (ADAPT):** keep the cube+HUD+shader composition; **(1)** replace direct Google-tile fetch with gateway imagery (STAC/COG / signed tiles via `/api/farm/*` + `/api/imagery/*`); **(2)** derive cube dims/aspect from real `widthM/heightM` (not fixed 2.2×1.6); **(3)** fix the circle-area `/4` bug; **(4)** drive strata sides + top-face tint from real soil-horizon/DEM/NDVI rasters; **(5)** show real Owner/parcel metadata (not "Owner: Private"). Add tenant-scoped data plumbing, loading/empty/error states, texture caching/LOD, WebGL perf budget.
- **Decorative scenes:** `hero-globe.tsx` / `onboarding-parcel.tsx` reuse as-is for marketing/onboarding; `farm-sims-scene.tsx` regenerate from real twins or drop.
- **TanStack → Vite conversion:** the prototype uses TanStack Start server routes (`.server.handlers.POST`) for `/api/studio-chat`; in Report.Farm those become **vanilla-Node handlers** under `/api/v1/farm/*` (copilot) — see §6. The React components, R3F Canvas, MapLibre, and `useSyncExternalStore` store logic are framework-agnostic and port directly into Vite/React 18.

### 5.4 Store rebuild
The prototype's `useTwins()` localStorage `useSyncExternalStore` + module-global undo/redo → **server-backed, tenant-scoped** data via `@tanstack/react-query` (`apiGet`/`apiPost` to `/farm/*`), with optimistic updates guarded by `twin_config.version` etags. Live updates arrive via the `ChangeEventSource` SSE/WS subscription (§4.4). Undo/redo either drops for MVP or becomes per-user server history (research REBUILD).

---

## 6. Twin copilot

> **[ASSUMPTION — `DIGITAL_TWIN_COPILOT_PATTERN.md` does not exist and must be authored.]** The design below is derived from the prototype + `04 §80-87` (conversational copilot is **P4-only**, "grounded in the digital twin + reports + AlphaGeo MCP tools," must answer "what changed this month?" with an evidence chain, no hallucination) + `06 D3`. The canonical tool schema / grounding contract / MCP tool list is **not specified anywhere** and is a deliverable, not an extraction.

**Prototype today:** `/api/studio-chat` → *Lovable* AI Gateway → `google/gemini-3-flash-preview`; stateless; **no** twin/parcel/scan context ever sent; **no** tools — "pin a task / open Analytics / schedule a scan" are prose only.

**Naming reconciliation (critical):** the *Lovable AI Gateway* (an LLM proxy) is a **different thing** from the *AlphaGeo Gateway* (`phase41_api_gateway.py`, the `/api/farm/*` geospatial relay). The enterprise copilot has **two hops**: (a) the LLM provider, and (b) the geospatial relay that grounds it and executes its actions. The prototype has only (a).

**Target architecture:**
1. **Provider swap.** Replace the Lovable Gateway + preview model with Report.Farm's own model call using an **explicitly pinned Claude model id** (not a preview alias) — reuse the AI-SDK streaming plumbing pattern (`streamText` + UI-message SSE) and both persona system prompts (worth keeping verbatim as voice specs). Handler becomes a **vanilla-Node `/api/v1/farm/copilot`** endpoint (tenant-scoped, `farmGate`, `withTenantConn`).
2. **Grounding.** Before/while calling the model, resolve **server-authoritative** twin/parcel/scan/indicator context from `/farm/*` (the composition read §4.1) — inject as a RAG-style context block **and/or** expose read tools. The active `parcelId`, layer, selected twin, and timeline position ride in the request body (the prototype's `sendChat()` SSE parser stays, extended to send this context).
3. **Tool-calling (the real gap).** Convert prose offers into executable tools that write through `/api/farm/*` and fan out via outbox+Redis:
   - `get_twin_state(farm_id, asset_id)` / `get_signals_bbox(...)` / `list_alerts(...)` (read, gateway-backed)
   - `pin_task(asset_id, ...)` → `POST /farm/twins/:id/schedule`
   - `schedule_scan(asset_id, scanType, signals[])` → `twin_schedule` → `POST /api/farm/scan`
   - `generate_report(farm_id, type, period)` → `POST /farm/reports/generate`
   - `ack_alert(alert_id)` → `POST /farm/alerts/:id/ack`
   - `run_sim(asset_id, sim_type, scenario)` → `POST /farm/twins/:id/sims`
   - `open_panel(analytics|history|reports)` (client-side intent)
   Every mutating tool respects RBAC (§7) and emits an audit + outbox event.
4. **Evidence discipline.** "What changed this month?" answers must cite `twin_provenance` / `observation` / `derived_signal` evidence (scene_id, acquired_at, gateway_job_id) — honest empty ("awaiting first satellite pass") until P2 ingest; **never invent hard numbers** (keep the prototype persona rule).
5. **Event-driven updates.** The copilot subscribes to the same `ChangeEventSource` stream so it can proactively surface new alerts/derived signals in-session.
6. **Onboarding copilot** (`/api/chat` → `OnboardingCopilot`): Report.Farm's 5-step wizard already writes real Farm/Parcel/Zone with `farm:onboard` gating. Adopt the prototype's cinematic map+chat shell as a **visual upgrade**, but keep the honest writes; captured Farm Intelligence Profile answers persist through `/farm/*`, not browser chat state.

---

## 7. Enterprise hardening

- **Multi-tenant isolation.** Every twin table carries `tenant_id` + RLS (migration 210 pattern); all handlers run in `withTenantConn` (sets `app.tenant_id`). The relay/ingest/sim workers use the `farm_platform` BYPASSRLS role and **always** scope writes by `farm_id`→`tenant_id`. `buyer == tenant` (no `farm.buyer` table); supply-chain overlay hangs off `tenant_id`.
- **RBAC — who manages twins.** Reuse the dual dot-perm/legacy-role `farmGate`. Proposed perms: `farm:onboard` (create farms/parcels/zones — exists), `farm:twin.write` (create/edit/delete assets + config + ops + schedule), `farm:twin.scan` (trigger scans / scan subs — cost-bearing), `farm:sim.run` (run sims — cost-bearing), `farm:read`/watch-only (view Studio, no writes; onboarding hidden, 403 handled honestly as today). Copilot tool-calls inherit the caller's perms.
- **Provenance / audit.** `twin_provenance` records the source (gateway/sensor/operator/sim), `gateway_job_id`, `scene_id`, `model`, `acquired_at` for every twin-visible derived value → satisfies the "evidence chain" requirement and MRV-style reporting. All mutations call `recordAudit`. No-fabrication invariant enforced end-to-end (state is write-only from real gateway round-trips).
- **Billing tie-in.** Cost-bearing actions — gateway **scans** (`POST /api/farm/scan`), **scan subscriptions** (recurring), **sim runs**, **imagery tile** volume — are the metering hooks. Record usage per `tenant_id` at enqueue time (tie to the RWR multi-tenant metering shell). Scan subscriptions and sims are gated by entitlement + perm so free/watch tiers can't incur EO cost. Advanced dossier tabs gate behind entitlements (§5.1).
- **Performance for many twins.**
  - **Map/GeoJSON:** viewport-bounded `signals-by-bbox` + parcel/zone queries (GIST indexes already on `geography`); cluster/LOD twin points at low zoom; `twinsToGeoJSON` splits poly/line/point FeatureCollections keyed by id (reuse).
  - **State reads:** the twin composition read is the hot path — paginate, cache latest observation/derived_signal per asset (materialized or `v_farm_latest_risk`-style views), and prefer the rollup views (`v_supplier_rollup`/`v_region_rollup`/`v_buyer_rollup`) for portfolio scale.
  - **Live push:** Redis Streams consumer groups per tenant; debounce UI updates; SSE reconnect/backfill via background-ingest polling (demoted to fallback per D3).
  - **R3F budget:** the prototype's Bloom + 128-seg spheres + shadow maps are heavy — cap postprocessing, cache/LOD textures, lazy-mount the cutaway only in the dossier, and WebGL-fallback like `FarmMap`/`GeometryPreview` already do.

---

## 8. Phased delivery

Dependencies flagged; **BLOCKED-ON-GATEWAY** items cannot start until the §9 gateway survey returns.

- **P0 — Foundation & reconcile (unblocked).**
  Deliverables: this doc reviewed; **author the missing `DIGITAL_TWIN_COPILOT_PATTERN.md` + §7.5 twin contract stubs**; migration `212_twin_studio` (tables in §3.2) + RLS `213` + RBAC seed `214`; hoist shared `farm-ui` primitives (`Panel/SectionHead/EmptyNote/KpiChip`); port `twin-geom.ts` + `TwinGeom` + `CATALOG`/`SENSOR_PROVIDERS` fixtures into the Vite app. **Depends on:** nothing external.

- **P1 — Studio shell + structure authoring (mostly unblocked).**
  Deliverables: `FarmConsole ?view=studio` mount; Studio fixed-inset shell with tokens/`--panel-glass`; extend `FarmMap` → editable/multi-layer; port `StudioMap` tool state machine; add freehand draw + shoelace acreage into `BoundaryImport`; twin create/edit/delete over `POST/PUT/DELETE /farm/twins` (+ `twin_config`, geometry `422`, etag `409`); Twins Explorer grid; layer-state persistence. Uses existing `parcel`/`zone`/`asset` CRUD. **Depends on:** P0. **Not blocked** (structure is app-tier).

- **P2 — Relay + live state (BLOCKED-ON-GATEWAY).**
  Deliverables: clone `server.mjs` harvest relay + `ingest-alphageo.mjs`/`crm/ingest-core.mjs` re-pointed to farm; import-guarded `farm.py` gateway router mount; `POST /api/farm/scan`, jobs SSE, `signals-by-bbox`; ingest writes `farm.scan`/`farm.observation`; twin-state composition read `GET /farm/farms/:id/twins`; real NDVI/moisture/thermal layers + timeline via `/api/imagery/*`; wire real readings/alerts into inspector; outbox + Redis `ChangeEventSource` live push. **BLOCKED-ON:** §9 items 1–8 (delegate signatures, SSE tick shape, indicator FC shape, signal kinds, Redis stream contract, env/auth wiring). This is the P2 gap the whole twin depends on (research).

- **P3 — Premium visualization + dossier + ops (partially blocked).**
  Deliverables: `parcel-cutaway` premium re-fit (gateway imagery, real dims, `/4` bug fix, soil/DEM strata, real metadata); twin dossier (MVP tabs Overview/Specs/Telemetry/Maintenance/Docs); operational log + schedule/routines + scan subscriptions (`twin_operational_log`, `twin_schedule` → enqueue scans); entitlement gating; report generation reuse. **Depends on:** P2 for EO-fed visuals; ops/schedule tables unblocked earlier.

- **P4 — Twin copilot + sims (BLOCKED-ON-GATEWAY for grounding/sim compute).**
  Deliverables: gateway-backed copilot relay (`/api/v1/farm/copilot`, pinned Claude model, grounding context, tool-calling per §6); evidence-chain "what changed?" answers; sim runs (`twin_sim_run` + delegation decision §4.3); onboarding copilot cinematic shell over the honest 5-step writes. **Depends on:** P2 (grounding data), §9 item on any gateway sim primitive, and the authored copilot-pattern doc.

- **P5 — Hardening & scale.**
  Deliverables: billing/metering on scans/sims/imagery; RBAC finalization; provenance UI; portfolio-scale perf (materialized latest-state views, Redis consumer groups, R3F LOD/caching); remote-deployment `WebhookSource` (HMAC) path per D4; migrate `FarmConsole` query router → real client router.

---

## 9. Open questions for the gateway

*(Verbatim list to hand to the backend gateway agent — this feeds the next deliverable. Items 1–8 are P2 blockers.)*

- Does the gateway expose ANY existing twin-state or digital-twin endpoint (the task's premise that "the AlphaGeo GATEWAY already supports digital-twin logic")? The canonical docs say NO (gateway is scan/EO/indicator/imagery/evidence only) — confirm empirically on the box.
- Do the delegate internals named in `02 §4` actually exist, and with what real signatures — `scan_pipeline.enqueue(bbox, analyses, tenant, aoi)` and `.stream(job_id)`, `indicator_svc.query_bbox(bbox, kinds, limit)`? These are illustrative skeletons, not verified APIs.
- What is the native SSE tick shape — `{stage, state, done, total, message}` vs `{type:'progress', pct, stage, message}` — and the exact `_final` summary payload, so `normalizeHarvestTick` can be ported?
- Does the indicator-instances federation actually return per-AOI GeoJSON with the `02 §3.3` properties (`measurement`, `value`, `confidence`, `cloud_pct`, `scene_id`, `acquired_at`), or must a mapping layer be built?
- Which signal kinds are really available (ndvi / evi / water_stress / change), and are SAR / water-stress wired or is it optical-only today?
- Does the gateway expose a Redis change stream today (stream name, message schema, consumer group), or must Core be extended to publish it? `06 D3` assumes push "from day one" but no stream contract is documented.
- What are the exact `ALPHAGEO_HARVEST_TOKEN` / `ALPHAGEO_FARM_BASE` / `ALPHAGEO_GATEWAY_ORIGIN` env wirings and the nginx IP-gate config on the deployed box?
- Is commercial-tasking escalation truly out of the current pipeline?
- Does the gateway expose (or can it expose) any simulation / scenario-modeling primitive (yield-at-risk, irrigation, disruption "what-if") the app can delegate to, or must all sim compute be app-side deterministic calculation over relayed indicator data for the MVP?
- Are soil-horizon / DEM / elevation rasters (e.g. SoilGrids) available through the gateway (STAC/COG or tiles) to feed the premium parcel-cutaway strata, or is only optical/indicator imagery served?
- Can imagery be served as signed COG URLs and/or `{z}/{x}/{y}` tiles per farm AOI with tenant scoping, and what are the auth/caching semantics for embedding them in the R3F cutaway top face?
- Locate or formally declare-missing the §7.5 report.farm↔AlphaGeo twin contract doc (and the `DIGITAL_TWIN_COPILOT_PATTERN.md` / `REPORTFARM_DIGITAL_TWIN_MEGAPROMPT.md` referenced by the task) before P2 build proceeds — who authors the canonical twin contract, the copilot grounding/tool schema, and the Redis change-event schema?
