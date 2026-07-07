# Report.Farm Mobile — Offline-First Local Database Design

**Owner:** Mobile Architecture Lead
**Scope:** The on-device persistence layer for the Report.Farm iOS/Android app (Expo / React Native).
**Stack:** `expo-sqlite` (SQLite 3.45+, WAL) + `drizzle-orm` (SQLite dialect) + `expo-secure-store` (secrets) + `expo-file-system` (blobs/tiles) + `@tanstack/react-query` (server-state cache orchestration on top of the DB).
**Status:** Implementation-grade spec. Everything below is buildable as written.

---

## 0. Design goals & the three hard invariants

Report.Farm on web keeps most business data server-authoritative (Postgres 16 + PostGIS, tenant-RLS) and keeps only two things client-side: the **twins store** (`rf.studio.twins.v1`) and the **scan-jobs store** (`rf.studio.scanjobs.v1`), both in `localStorage`. On mobile we replace `localStorage` with SQLite and additionally build a **read cache + write outbox** in front of the whole `/api/v1/farm/*` API so the app is usable with no connection.

Three invariants that drive every table decision:

1. **Tenant isolation is physical, not logical.** The server enforces Postgres RLS on `rwr.tenant_id`. On device there is no RLS, so every cached row carries a `tenant_id` column and **every read query is filtered by the active tenant**. Switching tenants (platform admin `TenantSwitcher`, org `DistrictSwitcher`) must never leak rows. We enforce this with a mandatory `tenant_id` column + a `WHERE tenant_id = ?` wrapper on all repository reads, plus a hard purge option on sign-out.
2. **Never fabricate.** `farm.observation`, `farm.derived_signal`, `farm.alert`, risk rollups, and report *measurements* come **only** from a real AlphaGeo gateway round-trip. Cached copies are honest mirrors. Empty is honest-empty; we store a `synced_at` and `is_stale` marker so the UI can say "Awaiting first satellite pass" / "cached 4h ago (offline)" — never a fake green. Honesty tiers (T1 regulatory / T2 evidence / T3 screening) and `approximate` flags are columns, not derived.
3. **Server owns geometry truth.** `area_ha` and `aoi_*` bbox are computed by PostGIS (`ST_Area`, `ST_IsValid`, `ST_XMin`…). The device may compute a *preview* area (equirectangular shoelace, ported from `twins-store.ringAreaM2`) but must treat the server response as source of truth and overwrite the preview on sync. Geometry that fails `ST_IsValid` returns `422 invalid_geometry` on flush — the outbox must surface that back to the owning draft, not silently drop it.

---

## 1. Library & runtime choices

| Concern | Choice | Why |
|---|---|---|
| SQL engine | `expo-sqlite` (`openDatabaseSync`, `execAsync`) | Native SQLite, WAL mode, synchronous + async APIs, works with Drizzle's Expo driver. |
| ORM / typing | `drizzle-orm` + `drizzle-orm/expo-sqlite` + `drizzle-kit` | Typed schema, generated migrations, `useLiveQuery` for reactive reads. |
| Migrations | `drizzle-kit generate` → bundled SQL, applied via `migrate()` on boot | Deterministic, versioned; no ad-hoc `CREATE TABLE IF NOT EXISTS`. |
| Secrets | `expo-secure-store` | JWT (8h), access-pass token (1h), refresh material. **Never** in SQLite. |
| Preferences | `expo-sqlite` `kv` table (or `@react-native-async-storage`) | Theme (`rwr.surface-mode`), last tenant, last surface, feature flags. |
| Blobs (report PDFs, docs, photos, soil texture, tile cache) | `expo-file-system` under `documentDirectory` + a `blob_asset` index table | SQLite stays lean; files are content-addressed on disk. |
| Server-state orchestration | `@tanstack/react-query` with a SQLite-backed persister | React Query drives fetch/cache/stale; the DB is the durable layer beneath it. |
| Reactive UI | `drizzle` `useLiveQuery` (or `expo-sqlite` `addDatabaseChangeListener`) | Screens re-render when the outbox flush updates rows. |
| Geo math | pure TS ported from `twins-store.ts` (`ringAreaM2`, `circlePolygon`, `rectPolygon`, `metersToLngLat`, `geomCenter`) | No native dep; identical math to web. |
| SSE (scan progress) | `react-native-sse` **or** `fetch`+XHR streaming that injects `Authorization` + `x-tenant-id` | RN `EventSource` can't set headers; web uses `fetch`+ReadableStream which RN lacks. |

**DB handle & PRAGMAs (boot):**

```ts
import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';

export const sqlite = openDatabaseSync('reportfarm.db', {
  enableChangeListener: true,
});
sqlite.execSync(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
`);
export const db = drizzle(sqlite);
```

**GeoJSON storage convention:** all geometry is stored as **GeoJSON TEXT** (a JSON string), never a binary/WKB blob — the API speaks GeoJSON, MapLibre/react-native-maps consume GeoJSON, and porting the web math needs plain arrays. Columns named `*_geojson`. A companion `bbox_w/s/e/n REAL` is denormalized for cheap spatial pre-filtering (SQLite has no PostGIS; we do bbox-overlap in SQL and precise hit-testing in JS with the ported `pointInPolygon`).

---

## 2. What is cached-offline vs server-only

| Data | Policy | Rationale |
|---|---|---|
| Farms, parcels, zones | **Cached, read + queued-write** | Field work needs boundaries/zones offline; onboarding drafts autosave. |
| Observations, derived signals, alerts, reports (metadata + sections) | **Cached, read-only** (+ alert `ack` and report `generate` as queued writes) | Honest mirror; measurements never authored on device. |
| Portfolio rollups (buyer/supplier/region), suppliers, sourcing regions | **Cached, read-only** | Glanceable dashboard offline; risk numbers honest-null until worker runs. |
| Twins (studio) + nested maintenance/events/routines/yields/treatments/docs/readings | **Cached, full offline CRUD** (device is system-of-record today; syncs when asset endpoints land) | Direct port of `rf.studio.twins.v1`. |
| Scan jobs | **Cached, full offline lifecycle** (queue launch, resume SSE on reconnect) | Direct port of `rf.studio.scanjobs.v1`; builds outlive app kills. |
| Map annotations (note/issue/task) | **Cached (an improvement over web, which is ephemeral)** | Persist to survive relaunch; queue as observations/notes later. |
| Gateway `/gw/*` results (signals-by-bbox, composed twins, parcel lookups) | **Cached last-result per key, read-only; online-only to (re)fetch** | 503 `gateway_unconfigured` in stub mode; degrade honestly. |
| Reference/seed data (60-item catalog, farm-type/crop presets, zone-type intent defaults, risk-band ramp, permission taxonomy) | **Bundled constants, seeded once** | Static; ship in app bundle, mirror to a `ref_*` table for joins. |
| **Server-only, never cached** | IAM admin (roles/users/teams/identities/flags), tenant CRUD, invites/registration, OIDC handshake, token revocation list, audit events | Admin/online-only; not part of the field/offline surface. |
| **Secrets, never in SQLite** | JWT, access-pass token, PKCE verifiers | `expo-secure-store`. |

---

## 3. Schema map (all tables)

```
reportfarm.db
├─ Identity / session (per-install, single-row-ish)
│   ├─ kv                         app prefs, active tenant, active user, gate state
│   └─ tenant_cache               known tenants + org membership (display only)
│
├─ Domain read-cache (tenant-scoped mirror of server-of-record)
│   ├─ farm                       farm.farm_profile
│   ├─ parcel                     farm.parcel
│   ├─ zone                       farm.zone
│   ├─ observation                farm.observation (honest-empty, read-only)
│   ├─ derived_signal             farm.derived_signal (evidence chain)
│   ├─ alert                      farm.alert (+ queued ack)
│   ├─ report                     farm.report (metadata + sections JSON)
│   ├─ supplier                   farm.supplier
│   ├─ sourcing_region            farm.sourcing_region
│   ├─ rollup_buyer               v_buyer_rollup (single row per tenant)
│   ├─ rollup_supplier            v_supplier_rollup
│   └─ rollup_region              v_region_rollup
│
├─ Studio local-of-record (ported from localStorage stores)
│   ├─ twin                       Twin (geom + specs + status JSON)
│   ├─ twin_maintenance           MaintenanceEntry[]
│   ├─ twin_doc                   TwinDoc[]
│   ├─ twin_event                 CalendarEvent[]
│   ├─ twin_routine               Routine[]
│   ├─ twin_yield                 YieldRecord[]
│   ├─ twin_treatment             Treatment[]
│   ├─ twin_reading               Reading[] (telemetry channels)
│   ├─ twin_undo                  undo/redo snapshots (persisted; web loses these)
│   ├─ scan_job                   ScanJob (background HD-twin builds)
│   └─ map_annotation             note/issue/task markers (persisted)
│
├─ Onboarding drafts (autosave — web keeps these in memory only)
│   ├─ farm_draft                 wizard state (name/types/crops/supplier/boundary/tz)
│   ├─ parcel_draft               ParcelDraft[]
│   └─ zone_draft                 ZoneDraft[] (+ intent JSON)
│
├─ Sync machinery (cross-cutting)
│   ├─ outbox                     write queue (mutations to replay)
│   ├─ tombstone                  local deletes to propagate / suppress re-pull
│   └─ sync_state                 per-collection cursor + last-pull + etag
│
├─ Gateway EO cache
│   ├─ gw_signal_cache            last signals-by-bbox FeatureCollection per AOI
│   ├─ gw_parcel_cache            find-my-farm lookups (address/point → parcel)
│   └─ gw_composite_cache         composed twin per aoi_id (materialization source)
│
├─ Media / tiles
│   ├─ blob_asset                 content-addressed file index (reports, docs, photos)
│   └─ tile_cache                 raster map tiles (z/x/y → file + LRU)
│
└─ Reference (seeded from bundle)
    ├─ ref_catalog                60-item twin catalog
    ├─ ref_farm_type              farm-type presets
    ├─ ref_crop                   crop presets
    ├─ ref_zone_type              zone types + default intent
    └─ ref_permission             permission taxonomy (dot + colon) for client gating
```

**Naming/typing conventions**
- PKs: server rows keep the **server UUID** as `id TEXT PRIMARY KEY`. Device-authored rows use a local id (`t_…`, `sj_…`, `draft_…`) until the server assigns one, then we store `server_id` alongside.
- Timestamps: server times stored as ISO `TEXT` (`created_at`, `updated_at`); device event times as INTEGER epoch ms (`created_ms`) to match the web stores. Sync bookkeeping uses epoch ms.
- Enums: stored as `TEXT` with a `CHECK` constraint mirroring the server enum (see §11 for the enum registry).
- Every cached (non-draft, non-ref) table carries: `tenant_id TEXT NOT NULL`, `synced_at INTEGER` (epoch ms of last successful pull/push), `dirty INTEGER DEFAULT 0` (has un-flushed local edits), `deleted INTEGER DEFAULT 0` (soft tombstone). This is the "sync trailer".

---

## 4. Full DDL sketch

> Drizzle schema is the source of truth in code; the SQL below is the generated shape (readable form). `CHECK` constraints encode enums. Indexes are explicit.

### 4.1 Identity / session

```sql
-- Key/value app state (single install). Values are JSON TEXT.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
-- Seeded keys: 'surface_mode'('light'|'dark'), 'active_tenant_id',
-- 'active_tenant_slug', 'active_user'(json {sub,email,roles[],perms[],org}),
-- 'access_pass_present'(bool mirror; token itself in SecureStore),
-- 'last_surface', 'schema_version'.

CREATE TABLE tenant_cache (
  id           TEXT PRIMARY KEY,          -- iam.tenant.id
  slug         TEXT NOT NULL,
  display_name TEXT,
  status       TEXT CHECK (status IN ('active','trial','suspended')),
  plan         TEXT,
  org_id       TEXT,                      -- parent org (nullable)
  org_slug     TEXT,
  flags        TEXT,                      -- JSON feature flags
  is_active    INTEGER DEFAULT 0,         -- the currently selected tenant
  synced_at    INTEGER
);
CREATE INDEX ix_tenant_active ON tenant_cache(is_active);
```

### 4.2 Domain read-cache

```sql
CREATE TABLE farm (
  id                TEXT PRIMARY KEY,        -- farm.farm_profile.id (server UUID)
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  timezone          TEXT DEFAULT 'UTC',
  language          TEXT DEFAULT 'en-US',
  currency          TEXT DEFAULT 'USD',
  farm_types        TEXT,                    -- JSON string[] (row-crop|orchard|...)
  crops             TEXT,                    -- JSON string[]
  total_area_ha     REAL,                    -- SERVER-computed; null until synced
  boundaries_geojson TEXT,                   -- GeoJSON MultiPolygon
  profiles          TEXT,                    -- JSON (sensitivity/cadence/channels/goals)
  custom_context    TEXT,                    -- JSON
  signal_source     TEXT DEFAULT 'gateway' CHECK (signal_source IN ('gateway','local')),
  aoi_w REAL, aoi_s REAL, aoi_e REAL, aoi_n REAL,   -- server bbox
  status            TEXT DEFAULT 'active',
  supplier_id       TEXT,                    -- null = single-farm mode
  supplier_name     TEXT,                    -- denormalized for list render
  latest_risk_score REAL,                    -- from v_farm_latest_risk (null=Unmonitored)
  latest_risk_band  TEXT CHECK (latest_risk_band IN ('healthy','watch','stress','high','critical') OR latest_risk_band IS NULL),
  latest_risk_date  TEXT,
  created_at        TEXT,
  updated_at        TEXT,
  synced_at         INTEGER,
  dirty             INTEGER DEFAULT 0,
  deleted           INTEGER DEFAULT 0
);
CREATE INDEX ix_farm_tenant       ON farm(tenant_id, created_at DESC);
CREATE INDEX ix_farm_supplier     ON farm(tenant_id, supplier_id);
CREATE INDEX ix_farm_bbox         ON farm(tenant_id, aoi_w, aoi_s, aoi_e, aoi_n);

CREATE TABLE parcel (
  id           TEXT PRIMARY KEY,
  local_id     TEXT,                        -- pre-sync client id (parcel_draft key)
  tenant_id    TEXT NOT NULL,
  farm_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  geom_geojson TEXT NOT NULL,               -- GeoJSON Polygon
  area_ha      REAL,                         -- server ST_Area
  bbox_w REAL, bbox_s REAL, bbox_e REAL, bbox_n REAL,
  tags         TEXT,                         -- JSON string[]
  created_at   TEXT,
  synced_at    INTEGER,
  dirty        INTEGER DEFAULT 0,
  deleted      INTEGER DEFAULT 0,
  FOREIGN KEY (farm_id) REFERENCES farm(id) ON DELETE CASCADE
);
CREATE INDEX ix_parcel_farm ON parcel(tenant_id, farm_id);

CREATE TABLE zone (
  id           TEXT PRIMARY KEY,
  local_id     TEXT,
  tenant_id    TEXT NOT NULL,
  farm_id      TEXT NOT NULL,
  parcel_id    TEXT,                         -- SET NULL on parcel delete
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,                -- irrigation-zone|barn|wetland|test-plot|crop-field|...
  intent       TEXT,                         -- JSON {expectedWaterFlow,standingWaterAllowed,vegetationPriority,alertSensitivity}
  geom_geojson TEXT NOT NULL,               -- GeoJSON Polygon
  bbox_w REAL, bbox_s REAL, bbox_e REAL, bbox_n REAL,
  tags         TEXT,
  created_by   TEXT,
  created_at   TEXT,
  synced_at    INTEGER,
  dirty        INTEGER DEFAULT 0,
  deleted      INTEGER DEFAULT 0,
  FOREIGN KEY (farm_id) REFERENCES farm(id) ON DELETE CASCADE
);
CREATE INDEX ix_zone_farm ON zone(tenant_id, farm_id);

CREATE TABLE observation (           -- READ-ONLY mirror. Never authored on device.
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  farm_id      TEXT NOT NULL,
  zone_id      TEXT,
  scan_id      TEXT,
  external_id  TEXT,                         -- gateway feature id (idempotency)
  measurement  TEXT,                         -- ndvi|evi|water_stress|standing_water|lst
  value        REAL,
  unit         TEXT,
  confidence   REAL,
  cloud_pct    REAL,                         -- honest-null preserved
  source_type  TEXT CHECK (source_type IN ('satellite','sar','sensor') OR source_type IS NULL),
  provider     TEXT,
  collection   TEXT,
  scene_id     TEXT,                         -- honest-null preserved
  tier         TEXT CHECK (tier IN ('T1','T2','T3') OR tier IS NULL),
  acquired_at  TEXT,
  geom_geojson TEXT,
  props        TEXT,                         -- JSON raw normalized payload
  detected_at  TEXT,
  synced_at    INTEGER,
  UNIQUE (farm_id, external_id)              -- mirrors server idempotency key
);
CREATE INDEX ix_obs_farm_meas ON observation(tenant_id, farm_id, measurement, acquired_at DESC);

CREATE TABLE derived_signal (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  farm_id      TEXT NOT NULL,
  zone_id      TEXT,
  kind         TEXT,                         -- ndvi_delta|water_stress|change|disease_risk
  value REAL, baseline REAL, delta_pct REAL, confidence REAL,
  window_start TEXT, window_end TEXT,
  evidence     TEXT,                         -- JSON (observation ids+values, explainable chain)
  geom_geojson TEXT,
  created_at   TEXT,
  synced_at    INTEGER
);
CREATE INDEX ix_dsig_farm ON derived_signal(tenant_id, farm_id, created_at DESC);

CREATE TABLE alert (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  farm_id            TEXT NOT NULL,
  zone_id            TEXT,
  derived_signal_id  TEXT,
  severity           TEXT CHECK (severity IN ('critical','high','medium','low') OR severity IS NULL),
  category           TEXT,                    -- irrigation-failure|flooding|disease-hotspot|...
  title              TEXT,
  summary            TEXT,
  evidence           TEXT,                    -- JSON [{signal,value}]
  confidence         REAL,
  estimated_impact   TEXT,                    -- JSON {yieldLossPctIfIgnored,revenueAtRiskUsd}
  recommended_actions TEXT,                   -- JSON []
  channels           TEXT,                    -- JSON [email|sms|push|webhook|slack]
  status             TEXT DEFAULT 'open' CHECK (status IN ('open','ack','resolved','suppressed')),
  status_local       TEXT,                    -- optimistic pending status pre-flush
  dedup_key          TEXT,
  created_at         TEXT,
  updated_at         TEXT,
  synced_at          INTEGER,
  dirty              INTEGER DEFAULT 0
);
CREATE INDEX ix_alert_farm ON alert(tenant_id, farm_id, created_at DESC);
CREATE INDEX ix_alert_status ON alert(tenant_id, status);

CREATE TABLE report (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  farm_id       TEXT NOT NULL,
  type          TEXT CHECK (type IN ('scheduled','urgent','on-demand') OR type IS NULL),
  title         TEXT,
  period_start  TEXT, period_end TEXT,
  status        TEXT CHECK (status IN ('draft','final','delivered') OR status IS NULL),
  summary       TEXT,
  sections      TEXT,                         -- JSON ordered sections (renderable offline)
  artifact_urls TEXT,                         -- JSON {pdf,html,csv} (server URLs)
  local_pdf_blob TEXT,                        -- blob_asset.hash if downloaded
  channels      TEXT,
  generated_by  TEXT,
  created_at    TEXT,
  synced_at     INTEGER
);
CREATE INDEX ix_report_farm ON report(tenant_id, farm_id, created_at DESC);

CREATE TABLE supplier (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  sourcing_region_id TEXT,
  name               TEXT NOT NULL,
  external_ref       TEXT,
  status             TEXT CHECK (status IN ('active','inactive','prospective') OR status IS NULL),
  tier               TEXT CHECK (tier IN ('strategic','preferred','spot') OR tier IS NULL),
  contact            TEXT,                    -- JSON
  metadata           TEXT,
  synced_at          INTEGER
);
CREATE INDEX ix_supplier_tenant ON supplier(tenant_id);

CREATE TABLE sourcing_region (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  name             TEXT NOT NULL,
  country          TEXT,
  admin_area       TEXT,
  geom_geojson     TEXT,                      -- GeoJSON MultiPolygon
  centroid_geojson TEXT,                      -- GeoJSON Point
  metadata         TEXT,
  synced_at        INTEGER
);

-- Rollup views mirrored as tables (empty/honest-zero until server worker runs).
CREATE TABLE rollup_buyer (
  tenant_id           TEXT PRIMARY KEY,       -- buyer subject_id = tenant_id
  buyer_slug          TEXT, buyer_name TEXT,
  supplier_count      INTEGER, region_count INTEGER, farm_count INTEGER,
  avg_risk_score      REAL, max_risk_score REAL,   -- null until computed
  revenue_at_risk_usd REAL,
  synced_at           INTEGER
);
CREATE TABLE rollup_supplier (
  supplier_id         TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  supplier_name       TEXT,
  sourcing_region_id  TEXT, region_name TEXT,
  farm_count          INTEGER,
  avg_risk_score      REAL, max_risk_score REAL,
  revenue_at_risk_usd REAL,
  synced_at           INTEGER
);
CREATE INDEX ix_rsup_tenant ON rollup_supplier(tenant_id, max_risk_score DESC);
CREATE TABLE rollup_region (
  sourcing_region_id  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  region_name         TEXT,
  supplier_count      INTEGER, farm_count INTEGER,
  avg_risk_score      REAL, max_risk_score REAL,
  revenue_at_risk_usd REAL,
  synced_at           INTEGER
);
```

### 4.3 Studio local-of-record (ported stores)

```sql
CREATE TABLE twin (
  id             TEXT PRIMARY KEY,           -- t_… (local) or t_gw_<aoi> (materialized)
  server_id      TEXT,                       -- farm.asset id once endpoint lands
  tenant_id      TEXT NOT NULL,
  parcel_id      TEXT,                        -- null = orphan / property-level
  property_id    TEXT,                        -- farm.id this twin belongs to (filter key)
  name           TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('structure','equipment','crop','field','livestock','water','infra')),
  kind           TEXT NOT NULL,
  icon           TEXT, color TEXT,
  geom_type      TEXT NOT NULL CHECK (geom_type IN ('point','rect','circle','polyline','polygon')),
  geom           TEXT NOT NULL,               -- JSON TwinGeom union (verbatim web shape)
  center_lng     REAL, center_lat REAL,       -- denormalized from geomCenter for map/bbox
  specs          TEXT,                        -- JSON {sizeLabel,installDate,costUsd,vendor,notes}
  online         INTEGER DEFAULT 1,
  linked_twin_ids TEXT,                       -- JSON string[]
  health_score   INTEGER,                     -- cached healthScore() output
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL,
  dirty          INTEGER DEFAULT 0,
  deleted        INTEGER DEFAULT 0
);
CREATE INDEX ix_twin_property ON twin(tenant_id, property_id);
CREATE INDEX ix_twin_category ON twin(tenant_id, category, updated_ms DESC);

-- Telemetry channels (Twin.status.readings[]).
CREATE TABLE twin_reading (
  id       TEXT PRIMARY KEY,
  twin_id  TEXT NOT NULL,
  label    TEXT NOT NULL,
  value    TEXT NOT NULL,
  unit     TEXT,
  ord      INTEGER DEFAULT 0,
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);
CREATE INDEX ix_reading_twin ON twin_reading(twin_id, ord);

CREATE TABLE twin_maintenance (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  date TEXT NOT NULL, type TEXT NOT NULL, notes TEXT,
  created_ms INTEGER NOT NULL,
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);
CREATE INDEX ix_maint_twin ON twin_maintenance(twin_id, date DESC);

CREATE TABLE twin_doc (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  name TEXT NOT NULL, url TEXT, note TEXT,
  blob_hash TEXT,                             -- local file if attached from camera/picker
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);

CREATE TABLE twin_event (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  date TEXT NOT NULL, time TEXT, title TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('task','scan','treatment','harvest','maintenance','note')),
  notes TEXT, done INTEGER DEFAULT 0,
  notif_id TEXT,                              -- expo-notifications scheduled id
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);
CREATE INDEX ix_event_twin ON twin_event(twin_id, date);

CREATE TABLE twin_routine (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cadence TEXT CHECK (cadence IN ('daily','weekly','biweekly','monthly','seasonal')),
  day_of_week INTEGER, time_of_day TEXT,
  action TEXT NOT NULL, active INTEGER DEFAULT 1, last_run TEXT,
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);

CREATE TABLE twin_yield (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  season TEXT NOT NULL, crop TEXT, quantity REAL, unit TEXT,
  quality TEXT, harvest_date TEXT, notes TEXT,
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);

CREATE TABLE twin_treatment (
  id TEXT PRIMARY KEY, twin_id TEXT NOT NULL,
  date TEXT NOT NULL,
  category TEXT CHECK (category IN ('fertilizer','pesticide','herbicide','fungicide','irrigation','other')),
  product TEXT NOT NULL, rate TEXT, area TEXT, applicator TEXT,
  reentry_hours INTEGER, notes TEXT,
  FOREIGN KEY (twin_id) REFERENCES twin(id) ON DELETE CASCADE
);

-- Persisted undo/redo (web keeps in-memory only; 50-entry cap).
CREATE TABLE twin_undo (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  stack      TEXT NOT NULL CHECK (stack IN ('undo','redo')),
  snapshot   TEXT NOT NULL,                   -- JSON Twin[] snapshot
  created_ms INTEGER NOT NULL
);
CREATE INDEX ix_undo_stack ON twin_undo(tenant_id, stack, id DESC);

CREATE TABLE scan_job (
  id           TEXT PRIMARY KEY,             -- sj_…
  tenant_id    TEXT NOT NULL,
  job_id       TEXT,                          -- gateway job id (null until 202 ack)
  aoi_id       TEXT,
  property_id  TEXT,
  twin_id      TEXT,
  label        TEXT NOT NULL,
  signals      TEXT NOT NULL,                 -- JSON ScanSignal[] (sar|moisture|thermal|superres)
  boundary     TEXT,                          -- JSON ring [[lng,lat]...] fallback geometry
  status       TEXT DEFAULT 'queued' CHECK (status IN ('queued','running','complete','error')),
  pct          INTEGER DEFAULT 0,
  stage        TEXT, message TEXT,
  started_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL,
  result_twin_id TEXT
);
CREATE INDEX ix_scan_status ON scan_job(tenant_id, status, started_ms DESC);
-- 'queued' is a mobile-only pre-state: launch intent recorded offline, fires
-- aoi/from-geom + scan when connectivity returns, then → 'running'.

CREATE TABLE map_annotation (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  property_id TEXT,
  lng REAL NOT NULL, lat REAL NOT NULL,
  label      TEXT,
  kind       TEXT CHECK (kind IN ('note','issue','task')),
  blob_hash  TEXT,                            -- optional photo
  created_ms INTEGER NOT NULL,
  dirty      INTEGER DEFAULT 0
);
CREATE INDEX ix_annot_property ON map_annotation(tenant_id, property_id);
```

### 4.4 Onboarding drafts (autosave)

```sql
CREATE TABLE farm_draft (
  id            TEXT PRIMARY KEY,            -- draft_…
  tenant_id     TEXT NOT NULL,
  name          TEXT,
  farm_types    TEXT,                         -- JSON string[]
  crops         TEXT,                         -- JSON string[]
  supplier_id   TEXT,
  boundary_geojson TEXT,                      -- Polygon|MultiPolygon
  timezone      TEXT,
  step          INTEGER DEFAULT 0,            -- current wizard step 0..4
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  partial_farm_id TEXT                        -- set if farm POST succeeded but children failed
);
CREATE TABLE parcel_draft (
  id           TEXT PRIMARY KEY,
  farm_draft_id TEXT NOT NULL,
  name         TEXT,
  geom_geojson TEXT,                          -- Polygon
  server_id    TEXT,                          -- filled after successful POST (key→id map)
  ord          INTEGER DEFAULT 0,
  FOREIGN KEY (farm_draft_id) REFERENCES farm_draft(id) ON DELETE CASCADE
);
CREATE TABLE zone_draft (
  id           TEXT PRIMARY KEY,
  farm_draft_id TEXT NOT NULL,
  parcel_draft_id TEXT,                       -- local link; resolved to server parcel_id on flush
  name         TEXT, type TEXT,
  intent       TEXT,                          -- JSON
  geom_geojson TEXT,
  server_id    TEXT,
  ord          INTEGER DEFAULT 0,
  FOREIGN KEY (farm_draft_id) REFERENCES farm_draft(id) ON DELETE CASCADE
);
```

### 4.5 Sync machinery

```sql
-- The write queue. Every offline mutation becomes an outbox row.
CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL,
  entity        TEXT NOT NULL,                -- 'farm'|'parcel'|'zone'|'alert'|'report'|'twin'|'scan_job'|'annotation'|'farm_draft'
  entity_local_id TEXT,                       -- local row id this op mutates
  op            TEXT NOT NULL CHECK (op IN ('create','update','delete','ack','generate','scan_launch')),
  method        TEXT NOT NULL,               -- HTTP verb
  path          TEXT NOT NULL,               -- e.g. /api/v1/farm/farms/:id/parcels (templated)
  payload       TEXT,                         -- JSON request body
  idem_key      TEXT,                         -- client idempotency key (X-Idempotency-Key)
  depends_on    INTEGER,                      -- outbox.id that must succeed first (farm→parcel→zone)
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','inflight','failed','done','conflict')),
  attempts      INTEGER DEFAULT 0,
  last_error    TEXT,                         -- server error code (invalid_geometry, 409, ...)
  http_status   INTEGER,
  next_attempt_ms INTEGER DEFAULT 0,          -- backoff gate
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX ix_outbox_ready ON outbox(status, next_attempt_ms);
CREATE INDEX ix_outbox_dep   ON outbox(depends_on);

-- Local deletes to propagate to the server AND suppress re-pull re-creation.
CREATE TABLE tombstone (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  entity      TEXT NOT NULL,
  server_id   TEXT,                           -- null if never synced (pure local delete)
  local_id    TEXT,
  reason      TEXT,                           -- 'user_delete'|'superseded'
  propagated  INTEGER DEFAULT 0,              -- server delete confirmed
  created_ms  INTEGER NOT NULL
);
CREATE INDEX ix_tomb_entity ON tombstone(tenant_id, entity, server_id);

-- Per-collection pull cursor + freshness. One row per (tenant, collection[, scope]).
CREATE TABLE sync_state (
  key          TEXT PRIMARY KEY,             -- e.g. 'demo-buyer:farms', 'demo-buyer:alerts:<farmId>'
  tenant_id    TEXT NOT NULL,
  collection   TEXT NOT NULL,
  scope_id     TEXT,                          -- farm id / bbox hash, when scoped
  last_pull_ms INTEGER,
  etag         TEXT,                          -- if server supports conditional GET
  cursor       TEXT,                          -- server pagination/updated-since cursor
  row_count    INTEGER,
  last_error   TEXT
);
```

### 4.6 Gateway EO cache

```sql
CREATE TABLE gw_signal_cache (
  bbox_key     TEXT PRIMARY KEY,             -- rounded 'W,S,E,N' + filter hash
  tenant_id    TEXT NOT NULL,
  farm_id      TEXT,
  feature_collection TEXT NOT NULL,          -- JSON farm.signal.v1 FeatureCollection
  count        INTEGER,
  fetched_ms   INTEGER NOT NULL,
  configured   INTEGER DEFAULT 1             -- 0 = last attempt returned 503 unconfigured
);
CREATE TABLE gw_parcel_cache (
  query_key    TEXT PRIMARY KEY,             -- 'addr:<q>' or 'pt:<lat>,<lon>' (rounded)
  tenant_id    TEXT NOT NULL,
  parcel_geojson TEXT,                        -- Polygon|MultiPolygon
  address      TEXT, area_ha REAL,
  approximate  INTEGER,                       -- 1 = OSM/T3, 0 = cadastral/T2
  source       TEXT CHECK (source IN ('gateway','osm')),
  tier         TEXT CHECK (tier IN ('T2','T3') OR tier IS NULL),
  fetched_ms   INTEGER NOT NULL
);
CREATE TABLE gw_composite_cache (
  aoi_id       TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  composite    TEXT NOT NULL,                 -- JSON CompositeTwin (materialization source)
  fetched_ms   INTEGER NOT NULL
);
```

### 4.7 Media / tiles

```sql
CREATE TABLE blob_asset (
  hash        TEXT PRIMARY KEY,              -- sha256 of content (content-addressed)
  tenant_id   TEXT NOT NULL,
  kind        TEXT CHECK (kind IN ('report_pdf','report_html','doc','photo','soil_texture','other')),
  mime        TEXT,
  file_uri    TEXT NOT NULL,                 -- expo-file-system uri
  bytes       INTEGER,
  source_url  TEXT,                          -- server/MinIO artifact url (for re-fetch)
  ref_count   INTEGER DEFAULT 1,
  pinned      INTEGER DEFAULT 0,             -- keep across LRU eviction
  last_access_ms INTEGER,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX ix_blob_lru ON blob_asset(pinned, last_access_ms);

CREATE TABLE tile_cache (
  key         TEXT PRIMARY KEY,              -- 'esri:{z}/{x}/{y}' or 'ndvi:{z}/{x}/{y}'
  tenant_id   TEXT,                          -- null = shared basemap (tenant-agnostic)
  layer       TEXT NOT NULL,                 -- satellite|ndvi|moisture|thermal
  z INTEGER, x INTEGER, y INTEGER,
  file_uri    TEXT NOT NULL,
  bytes       INTEGER,
  region_tag  TEXT,                          -- 'farm:<id>' for offline-region pinning
  pinned      INTEGER DEFAULT 0,
  last_access_ms INTEGER,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX ix_tile_lru ON tile_cache(pinned, last_access_ms);
CREATE INDEX ix_tile_region ON tile_cache(region_tag);
```

### 4.8 Reference (seeded from bundle)

```sql
CREATE TABLE ref_catalog (          -- the 60/62-item twin object library
  kind         TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  name         TEXT NOT NULL,
  icon         TEXT, color TEXT,
  default_geom_type TEXT NOT NULL,
  default_size TEXT,                          -- JSON {widthM?,heightM?,radiusM?}
  sample_readings TEXT                        -- JSON Reading[]
);
CREATE TABLE ref_farm_type ( key TEXT PRIMARY KEY, label TEXT );
CREATE TABLE ref_crop      ( key TEXT PRIMARY KEY, label TEXT );
CREATE TABLE ref_zone_type (
  key TEXT PRIMARY KEY, label TEXT,
  default_intent TEXT                          -- JSON intent presets (defaultIntentFor)
);
CREATE TABLE ref_permission (        -- for client-side gating labels (UX only)
  key   TEXT PRIMARY KEY,           -- 'farm.profile.read' | 'farm:view'
  form  TEXT CHECK (form IN ('dot','colon')),
  label TEXT
);
```

---

## 5. Tenant partitioning & session lifecycle

- **Active tenant** lives in `kv('active_tenant_id')` and is mirrored to `tenant_cache.is_active`. Every repository read is `WHERE tenant_id = :active`. A thin `withTenant(db)` wrapper injects it (the device analog of the server's `withTenantConn`).
- **Tenant switch** (admin `TenantSwitcher` re-mint, org `DistrictSwitcher` `/auth/switch-tenant`): online-only. On success we (1) store the new JWT in SecureStore, (2) set the new `active_tenant_id`, (3) `queryClient.invalidateQueries()` (React Query), (4) do **not** delete other tenants' rows — they stay partitioned by `tenant_id` and simply fall out of the `WHERE` filter. This matches web's "purge/segregate" intent while avoiding a re-download.
- **Sign-out** (3-phase, mirrors web `TopNav.signOut`): cancel SSE + push registrations → clear SecureStore token + `active_*` kv → **purge tenant-scoped tables for that tenant** (configurable: default purge on explicit sign-out, keep on token-expiry re-auth) → preserve `surface_mode`. Route to login.
- **`401 token_revoked` / `403 tenant_suspended`** on any sync flush → hard sign-out / locked state, exactly as web.
- **Access pass** (1h) and **session JWT** (8h) are the only two secrets, both in SecureStore. `kv` keeps only boolean presence mirrors so gating logic can run without touching SecureStore on every render. Both send on sync: `X-Access-Pass: <pass>` (no cookies on native) + `Authorization: Bearer <jwt>` + `X-Tenant-Id: <id|slug>`.

---

## 6. The outbox / sync-queue engine

### 6.1 Write path (optimistic + queued)

Every mutation follows: **apply locally → enqueue outbox → try flush**.

1. Repository writes the local row (sets `dirty=1`, or `status_local` for alerts) so the UI updates instantly.
2. An `outbox` row is inserted with `op`, templated `path`, JSON `payload`, a generated `idem_key` (UUID), and a `depends_on` pointer when ordering matters.
3. The **flush worker** (see §6.3) drains ready rows.

### 6.2 Dependency ordering (the onboarding create-bundle)

The server has **no atomic farm+parcels+zones bundle** — web POSTs sequentially and tracks `partialFarmId`. We encode that as an outbox dependency chain:

```
outbox#1  create farm      → POST /farm/farms                      (idem A)
outbox#2  create parcel[0]  → POST /farm/farms/:farmId/parcels  depends_on #1
outbox#3  create parcel[1]  → …                                  depends_on #1
outbox#4  create zone[0]    → POST /farm/farms/:farmId/zones    depends_on #2 (its parcel)
```

- `:farmId` / `:parcelId` in a child path are **placeholders** resolved at flush time from the parent op's server response (stored back into `parcel_draft.server_id` etc.). This is the offline realization of web's `key→server-id` map.
- If a child fails with `422 invalid_geometry`, the parent stays created; we set `farm_draft.partial_farm_id`, surface the exact zone/parcel error to its owning draft row, and **do not retry the parent** — matching `handleCreateError`'s "re-run won't duplicate" guidance. Idempotency keys guard against double-create if a `create farm` response was lost.

### 6.3 Flush worker

- Triggers: connectivity regained (`@react-native-community/netinfo`), app foreground, successful token refresh, manual pull-to-refresh, and a periodic timer while online.
- Selects `outbox` rows where `status='pending' AND next_attempt_ms <= now AND (depends_on IS NULL OR <dep is 'done'>)`, oldest first, small concurrency (2–3).
- Per row: set `inflight` → send with headers (Bearer + X-Tenant-Id + X-Access-Pass + X-Idempotency-Key) → on `2xx` mark `done`, clear `dirty` on the entity, store returned server id/area/aoi; on `4xx` (except 409/401/403) mark `failed` + record `last_error` for UI; on `409` mark `conflict` (see §6.4); on `401 token_revoked`/`403 tenant_suspended` abort the whole flush and trigger sign-out/lock; on network/5xx increment `attempts`, set exponential `next_attempt_ms` (1s,4s,15s,60s,300s cap), keep `pending`.
- `done` rows are pruned after a short retention (kept briefly for an activity log).

### 6.4 Conflict resolution — table by table

| Entity | Strategy | Detail |
|---|---|---|
| Twin & nested (maintenance/events/etc.) | **Last-write-wins, device-authoritative** | Device is system-of-record today; no server twin endpoint. When it lands, merge by `updated_ms`. |
| Farm / parcel / zone (create) | **Idempotent create** | `X-Idempotency-Key` prevents duplicate farms if a response is lost. |
| Farm / parcel / zone (update) | **LWW with server-geometry override** | Server recomputes `area_ha`/`aoi_*`; on success we overwrite local preview values. |
| Alert `ack` | **Server state machine wins** | `open/ack→ack` idempotent; `resolved/suppressed→ack` returns `409 invalid_status_transition` → drop the queued ack, refresh the alert from server, toast "already resolved". |
| Report `generate` | **No merge; re-request** | Server-side generation; on reconnect just POST. Never queue speculatively if the period is stale — prompt user. |
| Scan launch | **Re-fire intent** | `queued` scan_job fires `aoi/from-geom`+`scan` on reconnect; if gateway `503`, stays `queued` with honest "not connected". |
| Map annotation | **LWW device** | Local improvement; later maps to observation/note create. |
| Pulled read rows | **Server wins unless `dirty=1`** | A pull never clobbers a row with pending local edits; it stages the server version in `synced_at` bookkeeping and lets the outbox flush reconcile. |

### 6.5 Tombstones

- Deleting a **synced** row: set `deleted=1` locally (row hidden), insert a `tombstone(server_id,…)`, enqueue an `outbox delete`. On successful server delete → `tombstone.propagated=1`, then hard-delete the local row.
- Deleting a **never-synced** local row (e.g. a draft twin): hard-delete immediately, no tombstone needed (nothing on server).
- **Pull suppression:** when reconciling a pull, any incoming server row whose `id` matches an un-propagated tombstone is skipped (prevents a just-deleted row from resurrecting before the delete flushes). After `propagated=1` and a confirming pull, the tombstone is garbage-collected (retain ~30 days).

---

## 7. Table-by-table sync policy

Legend — **Pull cadence** / **Push trigger** / **Conflict**.

| Table | Direction | Pull cadence | Push trigger | Conflict |
|---|---|---|---|---|
| `farm` | bi | On operations/studio open; React Query staleTime 30s; pull-to-refresh; after any farm write | On create/update/delete (outbox) | Idempotent create; LWW update; server area/aoi override |
| `parcel` | bi | With parent farm detail open | On draw/import create | Idempotent; depends_on farm |
| `zone` | bi | With farm detail open | On create; intent edits | Idempotent; depends_on parcel |
| `observation` | pull-only | On farm detail open + push-notification wake; staleTime 60s | never | server-only (read mirror) |
| `derived_signal` | pull-only | With alert drill-down | never | read mirror |
| `alert` | pull + ack-push | Portfolio + farm detail open; push-notification arrival triggers targeted pull | `ack` queued write | 409 status-transition → drop+refresh |
| `report` | pull + generate-push | Reports list open | `generate` (online-only) | re-request; download artifact to blob |
| `supplier` / `sourcing_region` | pull-only | Portfolio open; cached long (staleTime 5m) | never (no CRUD endpoint yet) | read mirror |
| `rollup_buyer/supplier/region` | pull-only | Portfolio open; staleTime 60s | never | read mirror; honest-null preserved |
| `twin` (+ nested) | local-of-record (bi later) | n/a (local) — reconcile from `gw_composite` on scan complete | immediate local persist; server push when endpoint lands | LWW device |
| `scan_job` | local + gateway drive | n/a; driven by SSE while running | launch on user action / reconnect for `queued` | re-fire; twins/:aoi source of truth |
| `map_annotation` | local (bi later) | n/a | immediate local persist | LWW device |
| `farm_draft`/`parcel_draft`/`zone_draft` | local | n/a | autosave on every wizard change; consumed by create-bundle | n/a (transient) |
| `gw_signal_cache` | pull-only | On AOI/bbox change; refetchTick; online-only | never | overwrite last per bbox_key; keep stale for offline |
| `gw_parcel_cache` | pull-only | On find-my-farm lookup | never | overwrite per query_key |
| `gw_composite_cache` | pull-only | On scan complete / twin open | never | overwrite per aoi_id |
| `blob_asset` | pull-only | On report/doc open (download once) | never | content-addressed; LRU evict unpinned |
| `tile_cache` | pull-only | On map pan/zoom; explicit "download region" | never | LRU evict unpinned; region-pinned kept |
| `ref_*` | seed-only | On app version bump (re-seed from bundle) | never | bundle wins |

**Cadence controller.** React Query owns the in-memory freshness; the DB is its persister. `sync_state` records `last_pull_ms`/`cursor` per collection so a cold start knows what to refresh first (farms + alerts + rollups = the "portfolio warm set"). We prefer **updated-since cursors** (`?updated_after=<iso>`) where the API supports them; today the farm endpoints are full-list (LIMIT 500/1000), so we do a full replace into the tenant partition and reconcile against tombstones.

---

## 8. Media, imagery & tile caching

**Report/doc artifacts (MinIO):** `report.artifact_urls` and `twin_doc.url` point at server/MinIO objects. On open while online we download once into `expo-file-system` (`documentDirectory/blobs/<hash>`), index in `blob_asset` (content-addressed by sha256, `ref_count`, `pinned`). Offline, the viewer reads `local_pdf_blob`/`blob_hash`. Eviction: LRU over unpinned blobs when total blob bytes exceed a budget (default 500 MB); pinned = user "saved for offline" + the bundled soil-strata texture.

**Camera captures (expo-camera / expo-document-picker):** written straight to `blob_asset` with `kind='photo'`, linked from `twin_doc` or `map_annotation`. When a server media-upload endpoint exists, an outbox `create` op uploads and swaps `source_url` in.

**Map tiles (Esri World_Imagery + ndvi/moisture/thermal paint):** MapLibre/react-native-maps request tiles through a custom tile source that checks `tile_cache` first, else fetches and stores. Keyed `layer:z/x/y`. Two eviction classes: transient (LRU, budget e.g. 300 MB) and **region-pinned** — "Download this farm for offline" pins all tiles intersecting the farm bbox at zoom 12–18 with `region_tag='farm:<id>'`, exempt from LRU until the user removes the region. The ndvi/moisture/thermal layers are client-side raster paint transforms over the satellite base (per web), so only the satellite tiles need caching; the color filters are applied at render time.

**3D soil cutaway:** the `/textures/soil-strata.jpg` asset is **bundled** in the app (pinned `blob_asset` `kind='soil_texture'`), and the top-face satellite tiles reuse `tile_cache`. Degrades to the procedural-canvas / static fallback when WebGL/expo-gl is unavailable — no network dependency for the fallback.

**CSP note:** the web app runs under a strict CSP that blocks external hosts; the mobile equivalent is that all imagery/texture must be either bundled or fetched through our own relay/cache — never a hard external dependency at render time.

---

## 9. Twins store & scan-jobs local state (port details)

The web stores are `useSyncExternalStore` over `localStorage` with a JSON blob. On mobile we **normalize** the nested arrays into child tables (§4.3) for indexed queries (filter twins by property, list maintenance by date) but keep the `geom` union as verbatim JSON (the map/geo math consumes the exact web shape). A thin `twinRepo` reassembles a `Twin` object identical to `twins-store.ts`'s type so ported components (`geomCenter`, `geomAreaAcres`, `twinsToGeoJSON`, `healthScore`, `makeTwinFromCatalog`, `circlePolygon`, `rectPolygon`, `metersToLngLat`) work unchanged.

- **Undo/redo** becomes durable (`twin_undo`, 50-cap per stack) — a strict improvement over web (in-memory, lost on reload).
- **Cross-device sync** does not exist on web (per-browser). Mobile keeps twins device-local now, but the schema is sync-ready: `twin.server_id` + the sync trailer let us push to `farm.asset` (point twins) / `farm.zone` (field/parcel polygons) once those write endpoints ship.
- **Materialization:** on scan complete, `gw_composite_cache(aoi_id)` feeds `materializeParcelTwin` → `upsertTwinExternal` equivalent (`twinRepo.upsert`, no undo push). Defensive ring extraction with fallback to `scan_job.boundary` is ported exactly (gateway twin schema unconfirmed).
- **Scan-jobs** resume on relaunch: on boot, any `scan_job.status IN ('queued','running')` is picked up by the runner. `running` jobs reconnect the SSE stream (react-native-sse with Bearer+tenant headers) and treat `twins/:aoi` as source of truth on any clean stream-end (build finished while backgrounded). Because iOS/Android suspend JS in background, completion is **also** delivered via `expo-notifications` push (`farm.complete`) so a build that finishes while the app is killed still surfaces — the notification tap opens the materialized twin. `queued` (mobile-only) jobs fire their `aoi/from-geom`+`scan` when connectivity returns.

---

## 10. Reference / seed data

Seeded once on first boot (and re-seeded on schema-version bump) from bundled TS constants:

- **`ref_catalog`** — the 60+ item catalog imported verbatim from `twins-store.CATALOG` (kind, category, name, emoji icon, color, defaultGeomType, defaultSize, sampleReadings). Categories: `structure`(14), `equipment`(13), `crop`(8), `field`(8), `livestock`(8), `water`(8), `infra`(8).
- **`ref_farm_type`** — cropland/orchard/vineyard/pasture/livestock/aquaculture/greenhouse/mixed (+ free-text allowed, not seeded).
- **`ref_crop`** — corn/soybean/wheat/rice/coffee/cocoa/sugarcane/cotton/palm-oil/citrus/grapes/almonds/barley/sorghum.
- **`ref_zone_type`** — crop-field/irrigation-zone/barn/wetland/test-plot with `default_intent` presets (`defaultIntentFor`: barn=no-water, wetland=standing-water-ok, irrigation/test-plot=high sensitivity).
- **`ref_permission`** — dot-perms (`farm.profile.read/write`, `farm.zone.read/write`, `farm.portfolio.view`, `farm.report.generate`, `farm.alert.read/manage`, `farm.observation.read`, …) and legacy colon-roles (`farm:view`, `farm:onboard`, `ops:manage`, `alert:manage`, `report:generate`, `platform:admin`) for client gating labels only.
- **Risk-band ramp** (`healthy/watch/stress/high/critical` + `scoreToBand` thresholds) ships as a code constant (no table) — used by the shared `RiskPill`; `band=null → Unmonitored` honest state.

No demo farms/observations/alerts are ever seeded — those are honest-empty until a real gateway round-trip (invariant #2).

---

## 11. Enum registry (CHECK-constraint source of truth)

```
farm.status            active (+ future: paused, archived)
farm.signal_source     gateway | local
zone.type              crop-field | irrigation-zone | barn | wetland | test-plot (+ free)
zone.intent.*          expectedWaterFlow(bool) | standingWaterAllowed(bool)
                       vegetationPriority(low|med|high) | alertSensitivity(low|med|high)
observation.measurement ndvi | evi | water_stress | standing_water | lst
observation.source_type satellite | sar | sensor
alert.severity         critical | high | medium | low
alert.status           open | ack | resolved | suppressed
alert.category         irrigation-failure | flooding | disease-hotspot | ...
alert.channels[]       email | sms | push | webhook | slack
report.type            scheduled | urgent | on-demand
report.status          draft | final | delivered
supplier.status        active | inactive | prospective
supplier.tier          strategic | preferred | spot
risk band              healthy | watch | stress | high | critical  (UI)
                       low | medium | high | critical               (server risk_score.band)
subject_type           farm | supplier | region | buyer
ScanSignal             sar | moisture | thermal | superres   (NOT ndvi/evi — honest no_producer)
scan_job.status        queued(mobile) | running | complete | error
TwinCategory           structure | equipment | crop | field | livestock | water | infra
TwinGeom.type          point | rect | circle | polyline | polygon
CalendarEvent.kind     task | scan | treatment | harvest | maintenance | note
Routine.cadence        daily | weekly | biweekly | monthly | seasonal
Treatment.category     fertilizer | pesticide | herbicide | fungicide | irrigation | other
honesty tier           T1 (regulatory) | T2 (evidence) | T3 (screening)
parcel source          cadastral(T2, exact) | osm_landuse(T3, approximate) | nocoverage
```

---

## 12. Migration & versioning

- `drizzle-kit generate` produces numbered SQL migrations under `db/migrations/`. On boot, `migrate(db, migrations)` applies pending ones inside a transaction; `kv('schema_version')` records the applied version.
- Reference tables are re-seeded when the bundled `CATALOG_VERSION` differs from `kv('catalog_version')` (idempotent upsert by PK).
- Destructive migrations (rare) gate behind a one-time full re-pull of server-of-record tables (safe — they're mirrors), preserving local-of-record twins/scan-jobs/drafts.

---

## 13. Boot sequence (cold start)

```
1. open db + PRAGMAs → migrate() → seed ref_* if stale
2. read kv(active_tenant_id, active_user, surface_mode); read JWT+pass from SecureStore
3. decode JWT exp; if expired → route login (keep cached read data visible read-only)
4. hydrate React Query cache from DB (offline-first: show cached farms/alerts/rollups instantly)
5. if online:
     - flush outbox (respect depends_on + backoff)
     - refresh warm set (farms, alerts, rollups) via updated-since / full replace
     - resume scan_job runners (SSE reconnect / queued fire)
     - register expo-notifications; reconcile any farm.complete push misses
6. if offline: render from cache with is_stale/synced_at badges + honest-empty states
```

---

## 14. Open items / forward-compat

- **Server twin/asset endpoints** don't exist yet — `twin.server_id` + sync trailer are pre-wired for when `farm.asset`/`farm.zone` writes land.
- **Updated-since cursors** — farm endpoints are full-list today; adopt `?updated_after` on the server to shrink pulls.
- **Media upload endpoint** — camera blobs are local-only until an upload route exists; outbox `create` op is stubbed for it.
- **Push payload contract** — `farm.complete` / new-`alert` push notifications should carry `tenant_id` + entity id so the wake handler pulls the exact scope, not a full refresh.
```
