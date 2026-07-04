-- =============================================================================
-- 205_farm_connector_scene.sql — SensorConnector + ImageryScene.
-- -----------------------------------------------------------------------------
--   farm.sensor_connector — a standards-first IoT/telemetry connector attached to
--                           an asset (MQTT, LoRaWAN, Modbus, OPC UA, ISOBUS, API).
--                           Carries status + last_seen_at for health.
--   farm.imagery_scene    — STAC-ish metadata for a scene Report.Farm consumed,
--                           mirrored for report reproducibility. AlphaGeo remains
--                           system-of-record for the raster (docs/03 §5); we keep
--                           scene_id + footprint + asset hrefs only.
--
-- Additive + idempotent. RLS enabled centrally in 210_farm_rls.sql.
-- =============================================================================

-- ---- farm.sensor_connector --------------------------------------------------
CREATE TABLE IF NOT EXISTS farm.sensor_connector (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id       UUID NOT NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  asset_id      UUID REFERENCES farm.asset(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,                          -- mqtt|lorawan|modbus|opcua|isobus|api|...
  name          TEXT NOT NULL,
  protocol      TEXT,                                   -- SensorThings|MQTT|OPC-UA|...
  status        TEXT NOT NULL DEFAULT 'unknown',        -- active|error|offline|unknown
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,     -- endpoint, topic, auth ref (no secrets inline)
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS farm_connector_farm_idx  ON farm.sensor_connector (tenant_id, farm_id);
CREATE INDEX IF NOT EXISTS farm_connector_asset_idx ON farm.sensor_connector (tenant_id, asset_id);

-- ---- farm.imagery_scene -----------------------------------------------------
-- tenant_id is the buyer/tenant mirror scope; farm_id is nullable because a scene
-- may cover an AOI shared by several farms in the tenant.
CREATE TABLE IF NOT EXISTS farm.imagery_scene (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id     UUID REFERENCES farm.farm_profile(id) ON DELETE SET NULL,
  scene_id    TEXT NOT NULL,                            -- external STAC item id
  collection  TEXT,                                     -- sentinel-2-l2a|landsat-c2-l2|...
  provider    TEXT,                                     -- Copernicus|USGS|...
  platform    TEXT,                                     -- sentinel-2a|landsat-9|...
  acquired_at TIMESTAMPTZ,
  cloud_pct   NUMERIC,
  footprint   geography(POLYGON, 4326),
  bbox_west NUMERIC, bbox_south NUMERIC, bbox_east NUMERIC, bbox_north NUMERIC,
  assets      JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {band: href} STAC assets
  stac_href   TEXT,
  props       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scene_id)
);
CREATE INDEX IF NOT EXISTS farm_scene_tenant_idx ON farm.imagery_scene (tenant_id, acquired_at DESC);
CREATE INDEX IF NOT EXISTS farm_scene_geom_idx   ON farm.imagery_scene USING GIST (footprint);

COMMENT ON TABLE farm.imagery_scene IS
  'STAC-ish mirror of a scene Report.Farm consumed, for report reproducibility. '
  'AlphaGeo remains system-of-record for the raster.';
