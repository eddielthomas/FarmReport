# Report.Farm Mobile — Domain Design: Data Model & API Surface (Offline DB)

> **Domain scope.** The `farm.*` PostGIS schema (18 tables + 4 rollup views), the `/api/v1/farm/*` REST + `/gw/*` gateway relay, and the two client-of-record localStorage stores (`rf.studio.twins.v1`, `rf.studio.scanjobs.v1`) that ARE the offline model today. This document designs how all of that becomes a **native, offline-first Expo / React Native app** with **100% feature coverage**, honoring the honesty invariant (T1/T2/T3, never fabricate).
>
> **Target stack.** Expo + React Native + TypeScript, `expo-router`, offline DB via `expo-sqlite` + Drizzle ORM (+ SpatiaLite-style GeoJSON columns stored as text), maps via `@maplibre/maplibre-react-native`, 3D cutaway via `expo-gl` + `three`, push via `expo-notifications`, camera via `expo-camera`, secure token store via `expo-secure-store`. Dark-mode-first, cobalt-accent design language matching the Report.Farm web app.

---

## 0. Domain framing — what a "data model" domain looks like on mobile

Unlike a screen-heavy feature domain, this domain's deliverable is a **local database + sync engine that faithfully mirrors the server contract**, plus the **surfaces that let each role see, edit, queue, and reconcile that data offline**. Three tiers drive every design decision:

| Tier | Source of record | Offline capability | Examples |
|---|---|---|---|
| **A. Server-of-record** | Postgres/PostGIS via `/api/v1/farm/*` | Cache read + queue writes; server recomputes area/aoi/geometry as truth | `farm_profile`, `parcel`, `zone`, `observation`, `alert`, `report`, portfolio views |
| **B. Client-of-record** | localStorage today → **expo-sqlite/Drizzle on mobile** | Full CRUD offline (this IS the offline model) | `twins-store` (Twin + 60-item catalog + nested collections), `scan-jobs` |
| **C. Gateway-only** | AlphaGeo gateway via `/gw/*` relay | **Not offline-capable** — queue + degrade to `503 gateway_unconfigured` / honest-empty | scans, twins compose, vision segment, parcel lookup, SSE job stream |

### 0.1 The mobile offline database (Drizzle schema outline)

Local SQLite is **scoped per `tenant_id`** (a `tenant_id` column on every table + a WHERE-clause guard in every query mirrors server RLS locally — no cross-tenant leakage in the local cache). Tables:

- **Mirror tables** (Tier A, read-cache + write-shadow): `farm_profile`, `parcel`, `zone`, `asset`, `scan`, `observation`, `derived_signal`, `alert`, `recommendation`, `action_feedback`, `report`, `sensor_connector`, `imagery_scene`, `supplier`, `sourcing_region`, `risk_score`, `yield_at_risk`, `disruption_alert`, plus materialized rollup snapshots `v_farm_latest_risk`, `v_supplier_rollup`, `v_region_rollup`, `v_buyer_rollup`.
- **Client-of-record tables** (Tier B): `twin`, `twin_catalog` (60 seed rows), `twin_maintenance`, `twin_doc`, `twin_event`, `twin_routine`, `twin_yield`, `twin_treatment`, `twin_reading`, `scan_job`.
- **Sync infra tables**: `mutation_queue` (outbox), `sync_cursor` (per-entity high-water mark), `sync_conflict`, `geometry_draft` (offline-drawn GeoJSON awaiting server area/aoi), `honesty_meta` (per-entity emptiness/tier provenance).
- **Identity**: `session` (JWT, tenant_id, role, permission-set, exp), `perspective` (demo bundles).

Geometry is stored as **GeoJSON text** (`geography(4326)` equivalents) + a denormalized `bbox_w/s/e/n` for fast offline map queries. Client-side area is **preview only** (`equirectangular shoelace`, marked `area_source='client_preview'`); the server's `ST_Area/10000` overwrites it on sync (`area_source='server'`).

### 0.2 Honesty invariant on mobile (non-negotiable)

Observations, derived signals, alerts, report measurements, and risk/rollup numbers **exist only from a real AlphaGeo gateway round-trip**. The mobile app **NEVER seeds or fabricates** them. Every cached row carries `honesty_tier` (T1 regulatory / T2 evidence / T3 screening), `detectability_label`, and `provenance` (real | honest_empty | uncomputed). Empty lists render **explicit honest-empty states** ("No observations yet — AlphaGeo ingest not connected"), never zeros dressed as data. Rollup NULL/0 renders as "Not yet computed", not "0 risk".

### 0.3 Design language

Cobalt `#2F6BFF` accent on near-black `#0B0E14` surfaces (dark-first), `#F5F7FB` light theme. Severity/band color ramp: `low #22C55E → medium #EAB308 → high #F97316 → critical #EF4444`. Honesty chips are neutral slate with an italic label, deliberately visually quieter than real data. A persistent **sync status pill** (top-right of every tab) shows Online / Offline / Syncing / N-queued / Conflicts.

---

## 1. Epics + User Stories

Roles: **Buyer Admin** (tenant owner, all perms incl `platform:admin`), **Portfolio Lead** (portfolio + read, no onboarding), **Farm Operations** (full farm CRUD, scans, alerts ack), **Grower** (single farm, twins, feedback). Permission mapping honors the RBAC model (dot-form + colon-form legacy gates; `farmGate` accepts modern OR legacy OR `platform.admin.all`).

### Epic E1 — Offline Farm Records (farm_profile, parcel, zone)

**E1-S1 — Cache & browse farms offline.**
*As Farm Operations, I want the farm portfolio to load from local DB when I have no signal, so that I can review farms in a dead-zone field.*
AC: list renders from SQLite (`LIMIT 500`, tenant-scoped) when offline; each card shows name, farm_types, crops, total_area_ha (with `server`/`preview` badge), status, latest rollup risk band from `v_farm_latest_risk`; a "cached 2h ago" freshness stamp; requires `farm.profile.read`/`farm:view`.

**E1-S2 — Create a farm with a drawn boundary while offline.**
*As Farm Operations, I want to create a farm and sketch its MultiPolygon boundary offline, so that onboarding continues without connectivity.*
AC: POST body is **raw GeoJSON** (lone Polygon auto-promoted to MultiPolygon via client `ST_Multi` analog); local `ST_IsValid` analog blocks self-intersection with an inline "invalid geometry" hint before queueing; area/aoi shown as **client preview** with a lock icon meaning "server will finalize"; row lands in `mutation_queue` as `farm.create`; requires `farm.profile.write`/`farm:onboard`.

**E1-S3 — Edit farm fields & re-draw geometry offline.**
*As Grower, I want to change my farm's crops, timezone, currency, and boundary offline, so that corrections aren't blocked by signal.*
AC: partial-field PUT queued; geometry edit re-runs client validation + recomputes preview area/bbox; on sync the server response (authoritative area_ha/aoi_*) overwrites local; conflicting concurrent server edits raise a `sync_conflict`.

**E1-S4 — Delete a farm with cascade awareness.**
*As Buyer Admin, I want deleting a farm to warn me it cascades parcels/zones/scans/observations/alerts/reports, so that I don't lose data unknowingly.*
AC: destructive confirm lists child-record counts from local cache; queued as `farm.delete`; local rows tombstoned (hidden) immediately, hard-removed on server ack.

**E1-S5 — Manage parcels.**
*As Farm Operations, I want to draw titled parcels inside a farm offline, so that field-level records exist for twins to reference.*
AC: parcel requires name + POLYGON geom; POLYGON-only validation → inline 422-analog; queued `parcel.create`; `twin.parcelId` can reference a not-yet-synced parcel via local id, remapped to server UUID on sync.

**E1-S6 — Author zone intent.**
*As Farm Operations, I want to draw a zone and set its intent (expectedWaterFlow, standingWaterAllowed, vegetationPriority, alertSensitivity) offline, so that future alerts fire with the right semantics.*
AC: zone requires name + type + POLYGON; intent is a structured offline form (not free JSON); type picker uses the zone.type enum (irrigation-zone|barn|wetland|test-plot|…); `created_by` stamped from session `sub`; queued `zone.create`.

### Epic E2 — Digital Twin Offline Store (twins-store, 60-item catalog, asset analog)

**E2-S1 — Full offline twin CRUD.**
*As Grower, I want to place, move, resize, duplicate, and delete twins fully offline, so that the studio works anywhere on the farm.*
AC: place from catalog (`makeTwinFromCatalog`) with default geom type/size; edit geom (point/rect/circle/polyline/polygon); duplicate; delete; **50-step undo/redo**; all persisted to SQLite immediately (client-of-record — no queue needed, it's authoritative locally).

**E2-S2 — Browse the 60-item object library.**
*As Grower, I want the full catalog (Structures 14, Equipment 13, Crops&Beds 8, Fields&Zones 8, Livestock 8, Water 8, Access&Utility 8) with icons/colors, so that placement is fast.*
AC: 7 category sections; each item shows icon/color/defaultGeomType/defaultSize/sampleReadings; search + category filter; tapping drops onto the map at the current center (default central-Iowa if no map).

**E2-S3 — Twin detail workspace.**
*As Grower, I want every twin sub-collection editable offline — specs, maintenance timeline, calendar events, routines, yields, treatments, docs, live readings, health score, 3D cutaway — so that the twin is a complete field record.*
AC: tabbed workspace mirrors web; each nested collection (maintenance/events/routines/yields/treatments/docs/readings) is add/edit/delete offline; `healthScore` computed locally; treatment form enforces `category` enum + reentryHours; routine cadence enum (daily|weekly|biweekly|monthly|seasonal).

**E2-S4 — Materialize a backend HD twin into the local store.**
*As Farm Operations, I want a completed gateway scan's composed twin to merge into my local twins (geometry + indicators → readings), so that AI-built detail enriches my records.*
AC: on scan complete, `materializeParcelTwin` merges composite geometry + indicator readings; `upsertTwinExternal` reconciles by id without clobbering my manual edits (field-level merge, manual edits win on conflict, prompt if ambiguous).

**E2-S5 — Assets as the point-feature bridge.**
*As Farm Operations, I want physical point assets (pivot/pump/barn/pond) represented as twins now and ready to sync to `farm.asset` when the endpoint lands, so that my mobile records survive the future server contract.*
AC: point-geom twins in structure/equipment/water categories carry an `assetType` mapping to `farm.asset.type`; today they live client-side only; a "will sync when available" affordance sets expectation (no endpoint yet).

### Epic E3 — Observations & Signals cache (observation, derived_signal)

**E3-S1 — Read observation timeline offline (honest).**
*As Farm Operations, I want cached observations by farm + measurement offline, so that I can review recent EO signals in the field.*
AC: filter by farm_id + measurement (ndvi|evi|water_stress|standing_water|lst), order acquired_at DESC NULLS LAST; each row shows value/unit, provider, collection, source_type, confidence, cloud_pct, **honesty tier chip**; **honest-empty state** when no real ingest ("Empty until AlphaGeo connected") — never fabricated points.

**E3-S2 — Idempotent offline merge.**
*As the sync engine, I want observations merged by `(farm_id, external_id)`, so that re-pulls never duplicate rows.*
AC: unique key enforced locally; newer `updated_at` wins; no client can create observations (read-only cache).

**E3-S3 — Explainable signal evidence offline.**
*As Farm Operations, I want cached derived signals (ndvi_delta|water_stress|change|disease_risk) with their evidence chain, so that an alert's "why" is readable offline.*
AC: `derived_signal.evidence` (observation ids + values, baseline, delta_pct, window) cached alongside alerts; rendered in alert drill-down via `alert.derived_signal_id`; read-only.

### Epic E4 — Alerts, Recommendations & Feedback (alert, recommendation, action_feedback)

**E4-S1 — Push-notified, offline-readable alerts.**
*As Farm Operations, I want critical alerts as push notifications and readable offline, so that I act fast even with poor signal.*
AC: `channels` includes `push` → `expo-notifications` (APNs/FCM); tapping deep-links to Alert Detail; list filters by status (open|ack|resolved|suppressed, validated) `LIMIT 500`; each alert shows severity, category, title, summary, confidence, `estimated_impact` (yieldLossPctIfIgnored, revenueAtRiskUsd), `recommended_actions`, honesty tier; honest-empty until P2.

**E4-S2 — Queue an ack offline with transition rules.**
*As Farm Operations, I want to ack an alert offline and have it reconcile correctly, so that my triage isn't lost.*
AC: ack queued `alert.ack`; local optimistic state open/ack→ack (idempotent); on sync, server `409 invalid_status_transition` (resolved/suppressed→ack) surfaces as a resolved conflict ("already resolved on server") and reverts local state; requires `farm.alert.manage`/`alert:manage`.

**E4-S3 — Recommendation cards with ROI offline.**
*As Grower, I want AI recommendations (action_type inspect|irrigate|treat|schedule…, priority, ROI cost/benefit/payback) rendered offline, so that I can plan work.*
AC: recommendations cached under their alert/report; ROI JSONB rendered; status (open|accepted|dismissed|done) shown; write endpoints not yet built — status change queued as a **provisional feedback** where feedback exists.

**E4-S4 — Thumbs feedback offline (learning loop).**
*As Grower, I want to mark an alert/recommendation useful / not-useful / false-positive offline, so that the model learns from the field.*
AC: `action_feedback` (label enum + rating 1..5 + comment) queued as `feedback.create`; `actor_id` from session; ideal offline-queued write; reconciles when the endpoint lands (today staged in queue, flagged "pending endpoint").

### Epic E5 — Reports offline (report)

**E5-S1 — Browse & read reports offline.**
*As Portfolio Lead, I want cached reports and their sections rendered offline, so that I can review a covenant packet on a plane.*
AC: list by farm_id (created_at DESC); detail renders `sections` JSONB in order (overview, zones+intent, observations w/ honest data-quality note, alerts, portfolio); type (scheduled|urgent|on-demand) + status (draft|final|delivered) badges; honesty data-quality notes preserved verbatim.

**E5-S2 — Offline artifact viewing.**
*As Portfolio Lead, I want frozen artifacts (pdf/html/csv from `artifact_urls`) downloaded for offline viewing, so that deliverables are available without signal.*
AC: on cache, artifacts downloaded to app storage; PDF opens in in-app viewer; "download for offline" toggle per report; frozen URLs preserved for reproducibility.

**E5-S3 — Queue a report generation.**
*As Farm Operations, I want to request a report generation (farm_id, type, period) offline, so that it runs the moment I reconnect.*
AC: queued `report.generate`; period defaults last 30 days; requires `farm.report.generate`/`report:generate`; **generation requires server** — clear "will generate when online" state; never fabricates measurements locally.

### Epic E6 — Supply-chain & Portfolio (supplier, sourcing_region, rollups)

**E6-S1 — Buyer portfolio rollup offline.**
*As Buyer Admin, I want the buyer rollup (farm_count, avg/max risk, revenue_at_risk) cached offline, so that I can brief on supplier risk anywhere.*
AC: single buyer row (subject_id = tenant_id); band colors from local snapshot; **honest-zeroed** rollup for a new buyer renders "Not yet computed" not "0"; requires `farm.portfolio.view`/`farm:view`.

**E6-S2 — Supplier & region drill-down offline.**
*As Portfolio Lead, I want suppliers (with tier/status + region name, ordered max_risk DESC NULLS LAST) and regions cached, so that I can navigate the hierarchy offline.*
AC: `v_supplier_rollup` + `v_region_rollup` snapshots cached; supplier shows tier (strategic|preferred|spot), status (active|inactive|prospective), external_ref; region shows country/admin_area; NULL risk honestly absent.

**E6-S3 — Single-farm vs buyer mode.**
*As Grower, I want the app to hide supply-chain overlays when `supplier_id` is NULL (single-farm mode), so that my UI isn't cluttered with buyer concepts.*
AC: `farm_profile.supplier_id NULL` → single-farm layout; buyer/supplier/region tabs suppressed unless portfolio perms + at least one supplier link exist.

**E6-S4 — Disruption alerts (buyer-level) offline.**
*As Buyer Admin, I want buyer-level disruption alerts (category yield-risk|weather|disruption, share_at_risk_pct, revenue_at_risk) cached + ackable offline, so that supply-chain triage works in the field.*
AC: `disruption_alert` cached with status enum; ack queued (mirrors alert ack rules); dedup_key respected to avoid double-render; honest-absent until rollup worker runs.

### Epic E7 — Gateway Scans & Jobs (gateway relay, scan, scan-jobs)

**E7-S1 — Launch an HD-twin scan.**
*As Farm Operations, I want to launch a scan (aoi/from-geom → scan → SSE) from a farm boundary, so that AlphaGeo builds an HD twin.*
AC: pick signals from ScanSignal enum (sar|moisture|thermal|superres — excludes ndvi/evi which record honest `no_producer`); `POST /gw/aoi/from-geom` → `POST /gw/scan` → `202 {jobId}`; job tracked as local `ScanJob`; requires `farm.profile.write`/`farm:onboard`.

**E7-S2 — Background job progress that survives backgrounding.**
*As Farm Operations, I want scan progress (~5 min build) to continue while I use other screens or background the app, so that I don't babysit it.*
AC: SSE `/gw/jobs/:jobId/events` (farm.progress|farm.complete|farm.error, 15s heartbeat) drives a non-blocking progress dock; reconnect-on-drop; `POLL_MS 5s` fallback; `MAX_MS 12min` cap; twins/:aoi as source-of-truth on stream end; survives navigation via a background task.

**E7-S3 — Graceful gateway-offline degradation.**
*As Farm Operations, I want scans to queue and degrade honestly when the gateway is unreachable or unconfigured, so that I'm never shown fake results.*
AC: `503 gateway_unconfigured` (stub state) and offline → scan launch queued with "will run when gateway is live"; `502 gateway_unreachable` surfaced; upstream `422` preserved; **no offline scan results ever fabricated**; last composed twin remains cached for viewing.

**E7-S4 — Find-my-farm (parcel lookup).**
*As Farm Operations, I want address / drop-pin parcel lookup during onboarding, so that boundaries auto-populate.*
AC: `/gw/parcel?lat&lon` (drop-pin) and `/gw/parcel-by-address?q`; result labeled cadastral vs `osm_landuse` **T3** vs `nocoverage`; requires live gateway → offline shows "connect to look up parcels"; returned parcel Feature seeds a boundary draft.

**E7-S5 — AI auto-trace boundary.**
*As Farm Operations, I want SAM2/YOLO auto-trace of a boundary (`/gw/vision/segment` → `refine`), so that I don't hand-draw.*
AC: segment → refine loop; `404 vision_not_available` handled honestly; result is an editable ring, marked T3 screening; delineate alias supported.

**E7-S6 — Scan history mirror.**
*As Farm Operations, I want the `farm.scan` history (source, status, signals, aoi, result_summary) mirrored for display, so that I see what's been run.*
AC: read-only mirror populated by ingest; cannot run offline; started_at/completed_at + status (running|complete|failed) shown; queued requests fire when online.

### Epic E8 — Connectors & Imagery (sensor_connector, imagery_scene) [P2]

**E8-S1 — Connector health offline.**
*As Farm Operations, I want cached connector status (mqtt|lorawan|modbus|opcua|isobus|api; status active|error|offline|unknown; last_seen_at), so that I can see telemetry health in the field.*
AC: connector cards show type/protocol/status/last_seen; config JSONB shown **without inline secrets** (endpoint/topic refs only); no CRUD endpoint yet → read-only mirror; feeds twin live-readings.

**E8-S2 — Imagery scene metadata for report reproducibility.**
*As Portfolio Lead, I want cached STAC-ish scene metadata (scene_id, collection, provider, platform, acquired_at, cloud_pct, bbox, assets{band:href}, stac_href) tied to reports, so that report provenance is verifiable offline.*
AC: `imagery_scene` (UNIQUE tenant_id, scene_id) cached; footprint bbox rendered on the offline map; assets are metadata only (AlphaGeo owns raster); linked from report sections.

### Epic E9 — Sync, Tenancy & Security (tenancy/RLS/RBAC, geometry contract)

**E9-S1 — Local tenant isolation mirrors RLS.**
*As Buyer Admin, I want the offline DB scoped strictly per tenant, so that switching perspectives never leaks another buyer's cached data.*
AC: every table carries tenant_id; every query WHERE-guards on the active session tenant; switching tenant swaps the active scope and never surfaces the other tenant's rows; on logout the tenant scope is locked.

**E9-S2 — Offline permission gating identical to server.**
*As any role, I want the app to gate UI by my cached permission set, so that I can't attempt writes I'll be 403'd for.*
AC: JWT permission set (dot-form + colon-form legacy) stored; write CTAs hidden/disabled without the perm; demo perspectives (Buyer Admin/Portfolio Lead/Farm Operations/Grower) map to permission bundles (platform.admin/tenant.admin=all, analytics.viewer=read-only, dashboard.viewer=portfolio+profile read).

**E9-S3 — Authenticated sync.**
*As the sync engine, I want to send `Bearer JWT` (8h) + `x-tenant-id` on every sync call, so that server RLS + RBAC apply.*
AC: token refresh before 8h expiry; `x-tenant-id` header always set; 401 → re-auth flow, queue preserved; audit trail respected (server records authz.denied on 403).

**E9-S4 — Geometry validation parity.**
*As Farm Operations, I want the same geometry rules offline (Polygon-vs-MultiPolygon, ST_IsValid, POLYGON-only for parcels/zones), so that queued writes rarely bounce at the server.*
AC: farm boundaries accept Polygon/MultiPolygon (lone Polygon promoted); parcels + zones POLYGON-only; client `ST_IsValid` analog blocks self-intersection with inline error; server remains source of truth for area_ha/aoi_*; server `422 invalid_geometry` reconciled (GEOM_ERRCODES mapped) into a fixable conflict, not a silent drop.

### Epic E10 — Sync Engine, Outbox & Conflict Resolution (cross-cutting)

**E10-S1 — Durable mutation outbox.**
*As any editing role, I want every offline write persisted in a durable queue with ordering, so that nothing is lost on crash/kill.*
AC: `mutation_queue` rows (entity, op, payload, local_id, dependency, created_at, attempts, status); FIFO with dependency ordering (farm before its parcels/zones/twins); survives app kill; visible in an Outbox screen.

**E10-S2 — Pull sync with per-entity cursors.**
*As the sync engine, I want incremental pulls keyed on updated_at cursors, so that reconnection is cheap.*
AC: `sync_cursor` per entity; pulls apply idempotent upserts (observation by farm_id+external_id, imagery by scene_id, alert by farm_id+dedup_key); honest-empty preserved.

**E10-S3 — Conflict resolution UI.**
*As Farm Operations, I want a clear resolver when my offline edit collides with a server change (or a 409/422), so that I choose the right outcome.*
AC: `sync_conflict` list; each shows local vs server diff; resolve = keep-mine / take-server / merge; 409 invalid_status_transition and 422 invalid_geometry produce guided fixes; resolution re-queues or drops the mutation.

**E10-S4 — Local-id → server-UUID remap.**
*As the sync engine, I want to remap local ids to server UUIDs after create-acks, so that child references (twin.parcelId, alert.derived_signal_id) stay intact.*
AC: on create ack, local_id → server_uuid recorded; all dependent queued payloads + local FKs rewritten atomically.

---

## 2. User Journeys

### J1 — Offline farm onboarding (happy + offline path)
1. Farm Operations opens **Onboarding** (deep-link from Portfolio "+ Farm"). Signal is weak.
2. Farm basics form (name, timezone, currency, farm_types multi-select, crops) — saved to a local draft.
3. Boundary step: tries **Find-my-farm** → offline → banner "Parcel lookup needs the gateway; draw or import instead." Draws a MultiPolygon on the MapLibre canvas.
4. Client validates geometry (`ST_IsValid` analog); shows **preview area** with a lock ("server finalizes").
5. Parcels step: draws two POLYGON parcels; Zones step: draws an irrigation-zone, sets intent (expectedWaterFlow=high, standingWaterAllowed=false, alertSensitivity=medium).
6. Review → **Save**. Three mutations queue with dependency order (farm → parcels → zones). Sync pill shows "3 queued".
7. Later, signal returns → engine syncs: farm create acked (server returns authoritative area_ha/aoi_*, overwrites preview), local ids remapped, parcels/zones follow. Pill → "Synced".

### J2 — Field triage of a critical alert (push + offline ack)
1. Push notification: "Critical • Irrigation failure • Zone North — $18k at risk."
2. Tap → **Alert Detail** opens from cache. Shows evidence chain (derived_signal → observations), estimated_impact, recommended_actions, T2 tier chip.
3. Operator (offline) taps **Acknowledge** → optimistic ack, queued.
4. Adds **thumbs: useful** feedback → queued as `feedback.create`.
5. Reconnect: ack syncs OK (open→ack). If the server had already resolved it, a conflict card appears "Already resolved on server," local reverts to resolved. Feedback stays queued flagged "pending endpoint."

### J3 — HD-twin scan (background, survives navigation)
1. In **Studio**, Farm Operations selects a parcel, taps **Run scan**, picks signals (sar + moisture + thermal).
2. `aoi/from-geom` → `scan` → `202 {jobId}`. Progress dock appears (non-blocking).
3. Operator navigates to Alerts, backgrounds the app. Background task keeps SSE alive; on drop it reconnects, then polls every 5s.
4. `farm.complete` → `twins/:aoi` fetched as source-of-truth → `materializeParcelTwin` merges into local twins (manual edits preserved). Dock → "Twin ready," toast deep-links to the new twin.
5. Edge: gateway returns `503` mid-flow → dock shows "Gateway offline; scan re-queued," retries with backoff.

### J4 — Buyer portfolio brief offline
1. Buyer Admin (on a flight) opens **Portfolio**. Rollup card renders from snapshot: 42 farms, max risk High, $1.2M revenue-at-risk.
2. New sourcing region shows "Not yet computed" (honest-absent) rather than 0.
3. Drills into a strategic-tier supplier → sees its farms ordered by max_risk; opens a farm's cached report; a disruption_alert (weather, 30% share-at-risk) is ackable → queued.

### J5 — Twin field record keeping (fully offline)
1. Grower opens **Object Library**, drops a "Center Pivot" (equipment, point) on the map.
2. Opens **Twin Detail** → logs a treatment (category=fertilizer, product, rate, reentryHours=24), adds a maintenance entry, schedules a routine (weekly, Monday, inspect), records a yield (season, crop, quantity).
3. Everything persists to SQLite instantly (client-of-record). Undo/redo available. No queue needed — it's authoritative locally; assets flagged "will sync when server endpoint lands."

### J6 — Conflict resolution after long offline stint
1. Operator returns after 3 days offline with 14 queued mutations.
2. Sync runs; 12 succeed. 2 conflicts: a farm edited on web (take-server vs keep-mine diff) and a geometry that failed server `ST_IsValid` (self-intersection introduced by a later edit).
3. Operator opens **Conflict Resolver**: keeps-mine on the farm (re-queues), fixes the geometry inline (drag vertex) then re-queues. Both clear.

---

## 3. Screens

Each screen: purpose · layout · elements · states · nav · gestures.

### S1 — Sync & Data Center
- **Purpose:** command center for the offline DB — connectivity, queue, cursors, storage, honesty status.
- **Layout:** top status hero (Online/Offline/Syncing + last-sync time); sections: Outbox (N pending), Conflicts (N), Downloaded artifacts (size), Per-entity freshness list, Storage usage bar, "Sync now" + "Purge cache" actions.
- **Elements:** sync pill, entity freshness rows (farms, observations, alerts, reports, portfolio, twins, connectors, imagery), progress bars, tenant scope indicator.
- **States:** Online (green), Offline (amber banner "changes will sync when reconnected"), Syncing (animated), Error (retry), Empty (fresh install: "Sign in to sync").
- **Nav:** reachable from every tab's sync pill; deep-links to Outbox (S18) and Conflict Resolver (S17).
- **Gestures:** pull-to-refresh forces sync; long-press an entity row → "force re-pull."

### S2 — Portfolio / Farm List (Mission Control)
- **Purpose:** tenant-scoped farm portfolio, offline-first.
- **Layout:** search + filter bar (status, farm_type, risk band); tabs (Portfolio / Buyers / Suppliers / Regions / Growers — shown per perms & single-farm vs buyer mode); farm cards.
- **Elements:** farm card (name, farm_types chips, crops, area_ha + source badge, status, risk band dot, supplier name, "cached Xh ago"); FAB "+ Farm" (perm-gated); role/perspective switcher.
- **States:** Loading (skeleton), Offline (cached badge), Empty ("No farms — add one to begin"), Error, honest-absent risk.
- **Nav:** card → Farm Detail (S3); + → Onboarding; tabs → Portfolio (S13)/Supplier (S14).
- **Gestures:** pull-to-refresh; swipe card → quick actions (open report, run scan); long-press → delete (cascade warning).

### S3 — Farm Detail (record)
- **Purpose:** single-farm hub tying record + map + observations + alerts + reports + twins.
- **Layout:** header (name, status, edit); mini offline map (boundary + parcels + zones + asset points, bbox-driven); segmented sections: Overview, Parcels, Zones, Observations, Alerts, Reports, Twins.
- **Elements:** area_ha (source badge), aoi bbox, farm_types/crops, signal_source, supplier link; edit/delete (perm-gated); "Open in Studio."
- **States:** offline (fully readable from cache), queued-edit badge, honest-empty observation/alert lists.
- **Nav:** into S4/S5/S6/S7/S10/S11/S12; back to S2.
- **Gestures:** map pinch/pan; section swipe.

### S4 — Boundary / Geometry Editor (offline draw)
- **Purpose:** draw/import/edit farm boundary (Polygon/MultiPolygon) & validate offline.
- **Layout:** full-screen MapLibre; bottom tool rail (draw, vertex edit, import GeoJSON/shapefile, undo/redo, clear); preview area/bbox readout; validity indicator.
- **Elements:** vertex handles (drag/add/remove); "promote Polygon→MultiPolygon" auto-note; import picker; save (queues create/update).
- **States:** valid (green), invalid_geometry (red inline, save disabled), preview-area lock, offline (find-my-farm disabled with hint).
- **Nav:** from Onboarding/Studio/Farm Detail; back saves draft.
- **Gestures:** tap-to-add vertex, drag vertex, long-press vertex → delete, two-finger rotate/pan.

### S5 — Parcel Manager
- **Purpose:** list + draw POLYGON parcels.
- **Layout:** map + parcel list (name, area_ha, tags); draw tool.
- **Elements:** parcel card, add-parcel (POLYGON-only validation), tag editor.
- **States:** offline queue badge, POLYGON-only error inline, empty.
- **Nav:** from Farm Detail / Onboarding.
- **Gestures:** tap parcel → highlight on map; swipe → delete.

### S6 — Zone Intent Editor
- **Purpose:** draw zones + author intent that drives alerting.
- **Layout:** map draw + intent form.
- **Elements:** name, type picker (zone.type enum), intent controls (expectedWaterFlow slider, standingWaterAllowed toggle, vegetationPriority select, alertSensitivity segmented), tags.
- **States:** POLYGON validation, offline queue badge, intent-required hints.
- **Nav:** from Farm Detail / Onboarding.
- **Gestures:** map draw; form steppers.

### S7 — Digital Twin Studio (map + tool rail)
- **Purpose:** the studio — property map, twins, scans, layers.
- **Layout:** full map; left tool rail (select, edit-boundary, note/issue/task, measure, zone, parcel-draw, object library, rectangle, circle, row/line, duplicate, delete, undo/redo, isolate-property spotlight, labels); layer switcher (satellite/ndvi/moisture/thermal + opacity); season timeline (12-mo NDVI); right panel (Twin inspector / Reports / Analytics / History); **Run scan** button + progress dock.
- **Elements:** twin markers/shapes, catalog opener (S8), scan launcher (S15), layer sheet.
- **States:** offline (satellite base cached; ndvi/moisture/thermal layers honest-empty unless cached; live signals "connect gateway"), scan running dock, undo/redo depth.
- **Nav:** from Farm Detail; opens Twin Detail (S9), Object Library (S8), Scan Launcher (S15).
- **Gestures:** pinch/pan/rotate; long-press map → place; drag twin → move; two-finger rotate twin; pinch twin → scale.

### S8 — Object Library (60-item catalog)
- **Purpose:** browse/place the catalog.
- **Layout:** category-sectioned grid (7 categories, 60 items) + search.
- **Elements:** catalog card (icon, color, defaultGeomType, defaultSize, sampleReadings); category filter chips.
- **States:** always available offline (seeded), search-empty.
- **Nav:** from Studio; select → drops twin, returns to map.
- **Gestures:** tap to place; long-press → details preview.

### S9 — Twin Detail Workspace
- **Purpose:** complete twin record with all nested collections + 3D cutaway.
- **Layout:** header (name, category, health score ring, online status); tabs: Specs, Maintenance, Calendar/Events, Routines, Yields, Treatments, Docs, Telemetry (readings), 3D Cutaway.
- **Elements:** editable forms per tab (enums enforced: routine.cadence, treatment.category, event.kind, reading label/value/unit); linkedTwinIds; duplicate/delete; 3D rotating soil-strata "land slice" (expo-gl + three).
- **States:** fully offline CRUD (client-of-record); materialized-from-gateway badge; empty sub-collections.
- **Nav:** from Studio grid/marker; back to Studio.
- **Gestures:** tab swipe; 3D rotate (drag) + pinch-zoom cutaway; long-press collection row → edit/delete.

### S10 — Observations Timeline
- **Purpose:** honest EO signal history.
- **Layout:** measurement filter chips (ndvi|evi|water_stress|standing_water|lst); time-ordered list/chart.
- **Elements:** observation row (value/unit, provider, collection, source_type, confidence, cloud_pct, tier chip, acquired_at); chart with honesty shading.
- **States:** **honest-empty** ("No observations — AlphaGeo ingest not connected"), offline cached badge, loading.
- **Nav:** from Farm Detail; row → detail sheet.
- **Gestures:** filter tap; chart pan/pinch.

### S11 — Alerts List + Alert Detail
- **Purpose:** operator-facing events + evidence + ack + feedback.
- **Layout (list):** status filter (open|ack|resolved|suppressed), severity-sorted cards. **(Detail):** severity banner, summary, evidence chain (derived_signal → observations), estimated_impact, recommended_actions, recommendation cards (ROI), channels, ack button, feedback thumbs.
- **Elements:** severity color, tier chip, ack CTA (perm-gated), thumbs (useful/not-useful/false-positive + rating), category icon.
- **States:** honest-empty until P2, offline ack queued badge, 409 conflict card, push-deep-link entry.
- **Nav:** from push, Farm Detail, Portfolio; detail → linked report/twin.
- **Gestures:** swipe card → ack; pull-to-refresh; long-press → suppress (if permitted).

### S12 — Reports List + Report Viewer
- **Purpose:** read reports + sections + artifacts offline; queue generation.
- **Layout (list):** by farm, type/status badges, "download for offline" toggle. **(Viewer):** ordered sections (overview, zones+intent, observations w/ data-quality note, alerts, portfolio), artifact viewer (pdf/html).
- **Elements:** generate CTA (type, period; perm-gated), data-quality honesty notes, artifact download state.
- **States:** offline read from cache + downloaded artifacts; generation "will run when online"; honest data-quality notes.
- **Nav:** from Farm Detail / Portfolio; generate → queued.
- **Gestures:** section scroll; pinch PDF.

### S13 — Portfolio Dashboard (rollup)
- **Purpose:** buyer/supplier/region rollups offline.
- **Layout:** buyer rollup hero (farm_count, avg/max risk, revenue_at_risk); tabs Suppliers / Regions / Analytics; rollup cards.
- **Elements:** band-colored cards, honest "Not yet computed" states, disruption_alert list.
- **States:** honest-zero/NULL, offline snapshot badge, single-farm mode hides overlays.
- **Nav:** from Portfolio tabs; card → Supplier/Region detail (S14).
- **Gestures:** tab swipe; pull-to-refresh.

### S14 — Supplier / Region Detail
- **Purpose:** hierarchy drill-down.
- **Layout:** supplier header (tier, status, external_ref, region), farm list ordered by max_risk; region view (country, admin_area, member suppliers/farms).
- **Elements:** tier/status chips, risk bands, contact (metadata), member cards.
- **States:** NULL risk honest-absent, offline cached.
- **Nav:** from Portfolio; farm → Farm Detail.
- **Gestures:** list scroll; tap farm.

### S15 — Scan Launcher + Progress Dock
- **Purpose:** launch gateway scans, track background jobs.
- **Layout:** signal multi-select (sar|moisture|thermal|superres), AOI summary, launch CTA; docked job cards (pct, stage, message).
- **Elements:** progress bar, stage label, cancel/remove, "clear finished," reconnect indicator.
- **States:** running/complete/error; **503/502 honest degrade**; offline "queued to run"; SSE reconnecting.
- **Nav:** from Studio; complete → deep-link to materialized twin.
- **Gestures:** swipe job → dismiss; tap → detail.

### S16 — Connector Health + Imagery Scenes [P2]
- **Purpose:** telemetry health + scene provenance.
- **Layout:** connector list (type/protocol/status/last_seen); imagery scene list/map (scene_id, collection, provider, acquired_at, cloud_pct, footprint).
- **Elements:** status chips, secret-free config view, scene bbox on map, stac_href/asset band list.
- **States:** read-only mirror, offline cached, honest "no connectors."
- **Nav:** from Farm Detail / Report provenance.
- **Gestures:** list scroll; tap scene → map footprint.

### S17 — Sync Conflict Resolver
- **Purpose:** resolve write collisions & server rejections.
- **Layout:** conflict list; per-conflict diff (local vs server), resolution actions.
- **Elements:** keep-mine / take-server / merge; guided fixers for 409 (status transition) and 422 (geometry — opens S4 inline).
- **States:** empty ("no conflicts"), resolving, geometry-fix mode.
- **Nav:** from Sync Center (S1); geometry fix → S4.
- **Gestures:** swipe to choose resolution; expand diff.

### S18 — Outbox / Mutation Queue
- **Purpose:** transparency + control over queued writes.
- **Layout:** ordered queue list (entity, op, created_at, attempts, status, dependency).
- **Elements:** retry, cancel, reorder-locked (dependency), "pending endpoint" flags (feedback/recommendation/asset).
- **States:** empty, syncing, failed (retry/backoff), blocked-by-dependency.
- **Nav:** from Sync Center.
- **Gestures:** swipe → cancel; tap → payload detail.

### S19 — Login / Tenant & Perspective Switcher
- **Purpose:** auth, tenant selection, demo perspectives, offline session.
- **Layout:** login (email + manual tenant + access-code gate); perspective picker (Buyer Admin / Portfolio Lead / Farm Operations / Grower).
- **Elements:** JWT capture (8h), tenant_id + role/permission set store (secure-store), offline "cached session valid until…".
- **States:** online login, offline (cached session, read-only if expired), 401 re-auth, access-gate.
- **Nav:** entry point; → Portfolio.
- **Gestures:** standard forms.

### S20 — Settings / Storage & Data Management
- **Purpose:** manage cache size, downloaded artifacts, honesty preferences, notifications.
- **Layout:** storage usage, per-entity cache toggles, artifact downloads, push channel prefs (email/sms/push mirror), purge/reset, tenant scope, sign-out (locks scope).
- **Elements:** storage meter, clear-cache, notification opt-ins, honesty-info explainer.
- **States:** normal, low-storage warning, purge confirm.
- **Nav:** from tab bar / Sync Center.
- **Gestures:** toggles; confirm sheets.

---

## 4. Offline Behavior Matrix

| Capability | Offline behavior | Queues? | Read-only offline? |
|---|---|---|---|
| Browse farms / parcels / zones | Full read from SQLite (tenant-scoped) | — | Read yes |
| Create/edit/delete farm, parcel, zone | Draw + client-validate + preview area; server recomputes area/aoi on sync | **Yes** (dependency-ordered) | No |
| Twin CRUD + 60-item catalog + nested collections | **Full offline CRUD** (client-of-record, authoritative) | No (authoritative locally) | No |
| Undo/redo (50-step), duplicate | Full offline | No | No |
| Observations timeline | Read cache; **honest-empty** if no real ingest | — | **Read-only** (never created client-side) |
| Derived signals / evidence | Read cache with alerts | — | Read-only |
| Alerts list + detail | Read cache; push deep-link | — | Read for list |
| Alert ack | Optimistic + queued; 409 reconciled | **Yes** | No |
| Recommendation status / feedback thumbs | Queued (flagged "pending endpoint" where none exists) | **Yes** | No |
| Reports list + sections | Read cache | — | Read-only |
| Report artifacts (pdf/html/csv) | Downloaded for offline viewing | Download job | Read-only |
| Report generation | **Requires server**; queued "run when online" | **Yes** | Generation blocked |
| Portfolio / supplier / region rollups | Read snapshot; honest-zero/NULL | — | Read-only |
| Disruption alert ack | Queued (mirrors alert rules) | **Yes** | No |
| Gateway scans / aoi / vision / parcel lookup | **Not offline-capable**; queue + degrade 503/502; never fabricate | **Yes** (launch) | Blocked |
| Scan jobs / SSE progress | Background task + reconnect + poll; survives backgrounding; resumes when online | Launch queued | — |
| Connector health / imagery scenes [P2] | Read cache (mirror) | — | Read-only |
| Tenancy / permission gating | Fully offline from cached JWT set | — | Enforced |
| Geometry validation | Client `ST_IsValid`/preview-area; server authoritative on sync | via write queue | — |
| Sync / conflicts / outbox | Fully functional offline (view/edit queue); sync fires on reconnect | — | — |

**Honesty rule everywhere:** empty/uncomputed data renders explicit honest-empty/"not yet computed" states with tier + provenance chips; the app never generates observation/signal/alert/measurement/risk values locally.

---

## 5. Coverage Map (100%)

| # | Inventory feature | Priority | Screen(s) | Epic / Story |
|---|---|---|---|---|
| 1 | farm.farm_profile (root farm) | P0 | S2, S3, S4, S19 | E1-S1..S4, E9 |
| 2 | farm.parcel | P0 | S5, S4, S3, S7 | E1-S5 |
| 3 | farm.zone (intent) | P0 | S6, S3, S7 | E1-S6 |
| 4 | farm.asset (point features) | P1 | S8, S9, S7 (twin analog) | E2-S5 |
| 5 | farm.scan (execution) | P1 | S15, S7 | E7-S1, E7-S6 |
| 6 | farm.observation (EO sink) | P0 | S10, S3, S12 | E3-S1, E3-S2 |
| 7 | farm.derived_signal | P1 | S11 (alert drill-down) | E3-S3 |
| 8 | farm.alert | P0 | S11, S3, push | E4-S1, E4-S2 |
| 9 | farm.recommendation + action_feedback | P1 | S11, S12 (cards + thumbs) | E4-S3, E4-S4 |
| 10 | farm.report + generation | P0 | S12, S3 | E5-S1..S3 |
| 11 | farm.sensor_connector + imagery_scene | P2 | S16, S12 (provenance) | E8-S1, E8-S2 |
| 12 | supplier + sourcing_region overlay | P0 | S14, S13, S2 | E6-S2, E6-S3 |
| 13 | Portfolio rollup store + views | P0 | S13, S14 | E6-S1, E6-S4 |
| 14 | AlphaGeo gateway relay /gw/* | P0 | S15, S4 (find-my-farm/auto-trace), S7 | E7-S1..S6 |
| 15 | Client twins-store (60-item catalog) | P0 | S7, S8, S9 | E2-S1..S4 |
| 16 | Client scan-jobs store | P1 | S15 (progress dock) | E7-S2, E7-S3 |
| 17 | Tenancy, RLS isolation & RBAC | P0 | S19, S1, S20 (gating everywhere) | E9-S1..S3 |
| 18 | Geometry & validation contract | P0 | S4, S5, S6, S17 | E9-S4, E10-S3 |
| — | Sync engine / outbox / conflicts (cross-cutting infra required by all Tier-A writes) | P0 | S1, S17, S18 | E10-S1..S4 |

**Every one of the 18 inventory features is covered by at least one screen and one user story.** Cross-cutting infra (sync engine, outbox, conflict resolution, local-id remap) is added as Epic E10 because the domain's core deliverable — an offline DB mirroring the server contract — is not expressible without it.

### Honesty tiers carried into every surface
- **T1 (regulatory)** / **T2 (evidence)** / **T3 (screening)** chips on observations, alerts, reports, parcel-lookup results (cadastral vs osm_landuse T3 vs nocoverage), and vision auto-trace (T3).
- Detectability labels preserved on observations/alerts.
- Honest-empty on all Tier-A lists until P2 ingest / rollup workers land; honest-zero/NULL on portfolio rollups; `no_producer` respected for ndvi/evi scan signals.
- No fabrication anywhere — the mobile client never manufactures EO/risk data.

### Known gaps (server-side, not mobile design gaps)
The following have no dedicated REST endpoint yet, so mobile stages them and flags "pending endpoint" (design is complete; sync activates when the server ships): `farm.asset` CRUD, `farm.derived_signal` read, `farm.recommendation`/`action_feedback` write, `farm.sensor_connector`/`imagery_scene` read, standalone `supplier`/`sourcing_region` CRUD, and direct `farm.scan`/`risk_score`/`yield_at_risk`/`disruption_alert` writes (populated by P2 ingest + P3.5 rollup workers). Twins/scan-jobs are fully covered today as client-of-record.
