-- =============================================================================
-- 201_farm_zone_asset.sql — Zone (the alert driver) + Asset.
-- -----------------------------------------------------------------------------
-- farm.zone carries the operator's INTENT (expectedWaterFlow, standingWaterAllowed,
-- vegetationPriority, alertSensitivity) as JSONB. Intent is what turns a raw
-- observation into a meaningful alert ("standing water where none is allowed").
-- farm.asset is a physical point feature (pivot, pump, barn, pond) that connectors
-- attach to.
--
-- Additive + idempotent. RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.zone --------------------------------------------------------------
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

COMMENT ON COLUMN farm.zone.intent IS
  'Operator intent that drives alerting: expectedWaterFlow, standingWaterAllowed, '
  'vegetationPriority, alertSensitivity.';

-- ---- farm.asset -------------------------------------------------------------
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
CREATE INDEX IF NOT EXISTS farm_asset_geom_idx ON farm.asset USING GIST (geom);
