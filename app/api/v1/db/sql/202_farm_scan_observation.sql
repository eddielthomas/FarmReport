-- =============================================================================
-- 202_farm_scan_observation.sql — Scan + Observation (the AlphaGeo ingest target).
-- -----------------------------------------------------------------------------
-- farm.scan mirrors crm.scan: one row per scan request/execution over a farm AOI.
-- farm.observation is the normalized ingest sink for the /api/farm/* relay; it
-- upserts idempotently by (farm_id, external_id) exactly as crm.detection upserts
-- by (project_id, external_id). Observations ONLY ever come from a real gateway
-- round-trip — they are never seeded/fabricated (docs/03 §6 hard invariant).
--
-- Additive + idempotent. RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.scan --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.scan (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id        UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  source         TEXT NOT NULL DEFAULT 'gateway',       -- gateway | local
  status         TEXT NOT NULL DEFAULT 'running',        -- running | complete | failed
  aoi_west NUMERIC, aoi_south NUMERIC, aoi_east NUMERIC, aoi_north NUMERIC,
  signals        TEXT[] NOT NULL DEFAULT '{}',
  gateway_job_id TEXT,
  result_summary JSONB,
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_scan_farm_idx ON farm.scan (tenant_id, farm_id, started_at DESC);

COMMENT ON TABLE farm.scan IS
  'A scan request/execution over a farm AOI (mirrors crm.scan). Observations it '
  'surfaces link back via farm.observation.scan_id.';

-- ---- farm.observation -------------------------------------------------------
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
  raw_ref      TEXT,                                    -- s3://… raw payload (docs/03 rule)
  version      TEXT NOT NULL DEFAULT '1.0.0',
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (farm_id, external_id)                         -- upsert key (mirrors crm.detection)
);
CREATE INDEX IF NOT EXISTS farm_obs_farm_time_idx ON farm.observation (tenant_id, farm_id, acquired_at DESC);
CREATE INDEX IF NOT EXISTS farm_obs_geom_idx       ON farm.observation USING GIST (geom);
CREATE INDEX IF NOT EXISTS farm_obs_measure_idx    ON farm.observation (tenant_id, farm_id, measurement);

COMMENT ON TABLE farm.observation IS
  'Normalized AlphaGeo ingest sink. Upserts by (farm_id, external_id). Rows come '
  'only from a real gateway round-trip — never seeded/fabricated.';
