-- =============================================================================
-- 200_farm_schema.sql — Report.Farm vertical: schema + FarmProfile + Parcel.
-- -----------------------------------------------------------------------------
-- First migration of the farm 200-band (see docs/03_DATA_MODEL.md §2). Creates
-- the `farm` schema and the two root spatial entities every other farm table
-- hangs off:
--   farm.farm_profile — the tenant's farm; carries the AlphaGeo AOI binding.
--   farm.parcel       — a titled land parcel within a farm.
--
-- Tenancy spine (docs/03 §1): every farm table carries
--   tenant_id UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE
-- + a leading-tenant_id index; RLS is enabled centrally in 210_farm_rls.sql.
--
-- PostGIS conventions: geography(…,4326) + GIST; TIMESTAMPTZ DEFAULT now();
-- UUID DEFAULT gen_random_uuid(). Additive + idempotent. Safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS farm;

-- ---- farm.farm_profile ------------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.farm_profile (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  language       TEXT NOT NULL DEFAULT 'en-US',
  currency       TEXT NOT NULL DEFAULT 'USD',
  farm_types     TEXT[] NOT NULL DEFAULT '{}',       -- row-crop|orchard|vineyard|...
  crops          TEXT[] NOT NULL DEFAULT '{}',
  total_area_ha  NUMERIC,
  boundaries     geography(MULTIPOLYGON, 4326),
  profiles       JSONB NOT NULL DEFAULT '{}'::jsonb, -- sensitivity, cadence, channels, goals
  custom_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AlphaGeo binding: mirrors RWR crm.project(leak_source, sub_project_id).
  signal_source  TEXT NOT NULL DEFAULT 'gateway',    -- gateway | local
  aoi_west NUMERIC, aoi_south NUMERIC, aoi_east NUMERIC, aoi_north NUMERIC,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_profile_tenant_idx ON farm.farm_profile (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS farm_profile_bnd_idx    ON farm.farm_profile USING GIST (boundaries);

COMMENT ON TABLE farm.farm_profile IS
  'The tenant''s farm. boundaries + aoi_* bind the farm to AlphaGeo''s scan AOI '
  'via the /api/farm/* relay; signal_source selects gateway vs local pipeline.';

-- ---- farm.parcel ------------------------------------------------------------
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

COMMENT ON TABLE farm.parcel IS 'A titled land parcel within a farm_profile.';
