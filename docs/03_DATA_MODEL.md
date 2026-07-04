# 03 — Report.Farm Canonical Data Model (PostGIS, multi-tenant, RLS)

> **Goal.** Turn the research doc's canonical entities into numbered PostGIS migrations that run on RWR's idempotent migration runner, with tenant isolation via RLS, and a documented relationship to AlphaGeo's `alphageo.*` / `gis.*` / `app_meta.indicator_*` tables.

> **Owner:** Data-Model Engineer (A4). Append-only migrations; never edit an applied `*.sql`.

---

## 1. Inherited mechanics (from the RWR clone — do not reinvent)

- **Migration runner:** `api/v1/db/migrate.mjs` applies every `api/v1/db/sql/*.sql` in lexical order, once, recording filenames in `public._migrations`. **New farm tables = new numbered files** appended after the highest kept IAM/foundation number.
- **Tenancy + RLS spine:** every farm table has `tenant_id UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE`, `ENABLE ROW LEVEL SECURITY`, and a `USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)` policy — exactly like `111_rls_iam.sql`. The app binds the GUC per-tx via `withTenantConn(req, fn)` in `pool.mjs`.
- **PostGIS conventions:** geometries as `geography(…, 4326)` (RWR's `gis.feature`/`gis.layer` use `geography(GEOMETRY,4326)` + GIST indexes). Timestamps `TIMESTAMPTZ DEFAULT now()`. IDs `UUID DEFAULT gen_random_uuid()`.
- **Idempotency:** `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, policy-existence `DO $$ ... IF NOT EXISTS` guards.

## 2. Numbering plan

Keep RWR's IAM/foundation migrations (`001`–`120`ish). Add farm migrations in a fresh band so they never collide and clearly read as "the vertical":

| File | Contents |
|---|---|
| `200_farm_schema.sql` | `CREATE SCHEMA farm;` + `farm.farm_profile`, `farm.parcel` |
| `201_farm_zone_asset.sql` | `farm.zone`, `farm.asset` |
| `202_farm_scan_observation.sql` | `farm.scan`, `farm.observation` (the AlphaGeo ingest target) |
| `203_farm_derived_alert.sql` | `farm.derived_signal`, `farm.alert` |
| `204_farm_recommendation_report.sql` | `farm.recommendation`, `farm.report`, `farm.action_feedback` |
| `205_farm_connector_scene.sql` | `farm.sensor_connector`, `farm.imagery_scene` |
| `210_farm_rls.sql` | RLS enable + tenant-iso policies for every `farm.*` table |
| `211_farm_rbac_seed.sql` | farm permission strings + default role packs (`farm:view`, `report:generate`, …) |
| `299_farm_seed_demo.sql` | ONE demo tenant + ONE demo farm (real bbox, e.g. a known Sentinel-2-covered AOI) — no fabricated observations |

## 3. Entity → table mapping (research doc → PostGIS)

The 12 canonical entities (research doc §Canonical data model) map 1:1:

| Entity | Table | Geometry | Key relations |
|---|---|---|---|
| FarmProfile | `farm.farm_profile` | `boundaries geography(MULTIPOLYGON,4326)` | → `iam.tenant` |
| Parcel | `farm.parcel` | `geom geography(POLYGON,4326)` | → farm_profile |
| Zone | `farm.zone` | `geom geography(POLYGON,4326)`; `intent JSONB` | → parcel |
| Asset | `farm.asset` | `geom geography(POINT,4326)` | → zone; `connectors UUID[]` |
| Observation | `farm.observation` | `geom geography(GEOMETRY,4326)` | → scan, zone; **AlphaGeo ingest target** |
| DerivedSignal | `farm.derived_signal` | `geom geography(GEOMETRY,4326)` | → observation(s) |
| Alert | `farm.alert` | (point/zone ref) | → derived_signal, zone; `evidence JSONB` |
| Recommendation | `farm.recommendation` | — | → alert/report; `roi JSONB` |
| Report | `farm.report` | — | → farm_profile; `sections JSONB`, artifact URLs |
| SensorConnector | `farm.sensor_connector` | — | → asset; `status`, `last_seen_at` |
| ImageryScene | `farm.imagery_scene` | `footprint geography(POLYGON,4326)` | STAC-ish scene metadata |
| ActionFeedback | `farm.action_feedback` | — | → alert/recommendation; label for learning loop |

## 4. DDL sketch (the load-bearing tables)

### 4.1 `200_farm_schema.sql`
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS farm;

CREATE TABLE IF NOT EXISTS farm.farm_profile (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  language      TEXT NOT NULL DEFAULT 'en-US',
  currency      TEXT NOT NULL DEFAULT 'USD',
  farm_types    TEXT[] NOT NULL DEFAULT '{}',      -- row-crop|orchard|vineyard|...
  crops         TEXT[] NOT NULL DEFAULT '{}',
  total_area_ha NUMERIC,
  boundaries    geography(MULTIPOLYGON, 4326),
  profiles      JSONB NOT NULL DEFAULT '{}'::jsonb, -- sensitivity, cadence, channels, goals
  custom_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AlphaGeo binding: mirrors RWR crm.project(leak_source,sub_project_id)
  signal_source TEXT NOT NULL DEFAULT 'gateway',    -- gateway | local
  aoi_west NUMERIC, aoi_south NUMERIC, aoi_east NUMERIC, aoi_north NUMERIC,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_profile_tenant_idx ON farm.farm_profile (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_profile_bnd_idx    ON farm.farm_profile USING GIST (boundaries);

CREATE TABLE IF NOT EXISTS farm.parcel (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id    UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  geom       geography(POLYGON, 4326) NOT NULL,
  area_ha    NUMERIC,
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_parcel_farm_idx ON farm.parcel (tenant_id, farm_id);
CREATE INDEX IF NOT EXISTS farm_parcel_geom_idx ON farm.parcel USING GIST (geom);
```

### 4.2 `201_farm_zone_asset.sql` (zone-intent is the alert driver)
```sql
CREATE TABLE IF NOT EXISTS farm.zone (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id    UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  parcel_id  UUID REFERENCES farm.parcel(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,                         -- irrigation-zone|barn|wetland|test-plot|...
  intent     JSONB NOT NULL DEFAULT '{}'::jsonb,    -- expectedWaterFlow, standingWaterAllowed,
                                                    -- vegetationPriority, alertSensitivity
  geom       geography(POLYGON, 4326) NOT NULL,
  tags       TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_zone_farm_idx ON farm.zone (tenant_id, farm_id);
CREATE INDEX IF NOT EXISTS farm_zone_geom_idx ON farm.zone USING GIST (geom);

CREATE TABLE IF NOT EXISTS farm.asset (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id    UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id    UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,                         -- irrigation-pivot|pump|barn|pond|...
  name       TEXT NOT NULL,
  geom       geography(POINT, 4326),
  status     TEXT NOT NULL DEFAULT 'active',
  connectors UUID[] NOT NULL DEFAULT '{}',
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_asset_farm_idx ON farm.asset (tenant_id, farm_id);
```

### 4.3 `202_farm_scan_observation.sql` (the AlphaGeo ingest target — mirrors `crm.scan`/`crm.detection`)
```sql
CREATE TABLE IF NOT EXISTS farm.scan (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id     UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'gateway',       -- gateway | local
  status      TEXT NOT NULL DEFAULT 'running',        -- running | complete | failed
  aoi_west NUMERIC, aoi_south NUMERIC, aoi_east NUMERIC, aoi_north NUMERIC,
  signals     TEXT[] NOT NULL DEFAULT '{}',
  result_summary JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_scan_farm_idx ON farm.scan (tenant_id, farm_id, started_at DESC);

CREATE TABLE IF NOT EXISTS farm.observation (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  scan_id      UUID REFERENCES farm.scan(id) ON DELETE SET NULL,
  farm_id      UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id      UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  external_id  TEXT NOT NULL,                          -- gateway feature id (idempotency)
  measurement  TEXT NOT NULL,                          -- ndvi|evi|water_stress|standing_water|lst
  value        NUMERIC,
  unit         TEXT,
  confidence   NUMERIC,
  cloud_pct    NUMERIC,
  source_type  TEXT,                                   -- satellite|sar|sensor
  provider     TEXT,                                   -- Copernicus|USGS|...
  collection   TEXT,                                   -- sentinel-2-l2a|...
  scene_id     TEXT,
  acquired_at  TIMESTAMPTZ,
  geom         geography(GEOMETRY, 4326),
  props        JSONB NOT NULL DEFAULT '{}'::jsonb,      -- raw normalized payload
  raw_ref      TEXT,                                    -- s3://… raw payload (research doc rule)
  version      TEXT NOT NULL DEFAULT '1.0.0',
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, external_id)                         -- upsert key (mirrors crm.detection)
);
CREATE INDEX IF NOT EXISTS farm_obs_farm_time_idx ON farm.observation (tenant_id, farm_id, acquired_at DESC);
CREATE INDEX IF NOT EXISTS farm_obs_geom_idx       ON farm.observation USING GIST (geom);
CREATE INDEX IF NOT EXISTS farm_obs_measure_idx    ON farm.observation (tenant_id, farm_id, measurement);
```
> The `UNIQUE (farm_id, external_id)` + upsert exactly mirrors RWR's `crm.detection ON CONFLICT (project_id, external_id)` — the ingest core (`02_ALPHAGEO_INTEGRATION.md` §5.3) relies on it for idempotency.

### 4.4 `203_farm_derived_alert.sql` (DerivedSignal + Alert; alert carries evidence + impact)
```sql
CREATE TABLE IF NOT EXISTS farm.derived_signal (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id      UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id      UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,                          -- ndvi_delta|water_stress|change|disease_risk
  value        NUMERIC,
  baseline     NUMERIC,
  delta_pct    NUMERIC,
  confidence   NUMERIC,
  window_start TIMESTAMPTZ, window_end TIMESTAMPTZ,
  evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,     -- observation ids + values (explainable chain)
  geom         geography(GEOMETRY, 4326),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_derived_farm_idx ON farm.derived_signal (tenant_id, farm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS farm.alert (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id       UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  zone_id       UUID REFERENCES farm.zone(id) ON DELETE SET NULL,
  severity      TEXT NOT NULL,                         -- critical|high|medium|low
  category      TEXT NOT NULL,                         -- irrigation-failure|flooding|disease-hotspot|...
  title         TEXT NOT NULL,
  summary       TEXT,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{signal,value},...]
  confidence    NUMERIC,
  estimated_impact JSONB NOT NULL DEFAULT '{}'::jsonb, -- yieldLossPctIfIgnored, revenueAtRiskUsd
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  channels      TEXT[] NOT NULL DEFAULT '{}',          -- email|sms|push|webhook|slack
  status        TEXT NOT NULL DEFAULT 'open',          -- open|ack|resolved|suppressed
  dedup_key     TEXT,                                  -- so replays don't double-fire
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS farm_alert_farm_idx ON farm.alert (tenant_id, farm_id, created_at DESC);
```
`204`/`205` follow the same shape for `recommendation`, `report`, `action_feedback`, `sensor_connector`, `imagery_scene` (fields per research doc §Example JSON schemas).

### 4.5 `210_farm_rls.sql` (the isolation guarantee — pattern from `111_rls_iam.sql`)
For **every** `farm.*` table:
```sql
ALTER TABLE farm.observation ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='farm' AND tablename='observation'
                   AND policyname='observation_tenant_iso') THEN
    EXECUTE $POL$
      CREATE POLICY observation_tenant_iso ON farm.observation
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;
```
Repeat for `farm_profile`, `parcel`, `zone`, `asset`, `scan`, `derived_signal`, `alert`, `recommendation`, `report`, `action_feedback`, `sensor_connector`, `imagery_scene`. Cross-tenant admin (e.g. the background ingest listing all gateway farms) uses the `farm_platform` BYPASSRLS role for the SELECT, then binds the tenant GUC for each per-farm upsert — exactly the RWR `ingest-alphageo.mjs` pattern.

## 5. Relationship to AlphaGeo schemas (additive, read-mostly)

Report.Farm has its **own** `farm.*` schema in its **own** Postgres (the cloned `postgis` compose service). It does **not** write to AlphaGeo's DB. The link is the HTTP pipeline (`02_ALPHAGEO_INTEGRATION.md`). Mapping:

| AlphaGeo (box) | Report.Farm | Relationship |
|---|---|---|
| `alphageo.*` scan/scene tables | `farm.scan`, `farm.imagery_scene` | Report.Farm mirrors the scenes it consumed (scene_id, footprint) for report reproducibility; AlphaGeo remains system-of-record for the raster. |
| `app_meta.indicator_*` (Indicator Matrix / Visual OS) | `farm.observation` / `farm.derived_signal` | **Farm Observations can be published as AlphaGeo indicator instances** — a farm NDVI reading is an indicator instance over the farm AOI. The `/api/farm/signals-by-bbox` endpoint (§3.3) is backed by the indicator-instances federation. This is how the farm vertical rides the *existing* indicator surface additively. |
| `gis.*` (water mains, features) | `farm.parcel`/`farm.zone`/`farm.asset` | Same PostGIS `geography(…,4326)` conventions; no shared rows. |
| MinIO evidence buckets | evidence panels reference `/api/evidence/object` | Report.Farm links to AlphaGeo-hosted evidence objects; it does not copy them (unless a report needs a frozen artifact). |

**Optional forward path:** a farm Observation can be POSTed to AlphaGeo's indicator-instances endpoint so the farm signal shows up in the Indicator Matrix / Visual OS alongside other verticals — additive, opt-in, tenant-scoped. Not required for MVP.

## 6. Acceptance (Data-Model DoD)

- [ ] `migrate` applies `200`–`299` idempotently on top of the kept IAM foundation; re-run is a no-op.
- [ ] Every `farm.*` table has a tenant-iso RLS policy; `qa:rls` (ported) proves a second tenant cannot read tenant A's farm rows.
- [ ] `farm.observation` upserts idempotently by `(farm_id, external_id)` (re-ingesting the same scene produces no duplicate).
- [ ] `299_farm_seed_demo.sql` seeds exactly one demo tenant + one demo farm with a **real** bbox and **zero** fabricated observations (observations only ever come from a real round-trip).
- [ ] `audit:tenant` (ported) finds every `farm.*` mutating query passes through `withTenantConn`.
