-- =============================================================================
-- 102_gis.sql — Customer-uploaded GIS layers.
-- -----------------------------------------------------------------------------
-- Customers upload pipes, electrical, architectural, blueprints, etc. We:
--   1. Store the raw file blob (gis.layer.file_id → sales.file)
--   2. Parse vector formats (GeoJSON / Shapefile / KML/KMZ) into gis.feature
--   3. Store raster overlays (GeoTIFF / PDF / PNG / JPG) in gis.raster with
--      bounding box + georeferencing matrix
--
-- Layers render on the customer portal's map and on the ops dashboard's
-- main map under a "Customer Layers" group.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS gis;

-- ---- gis.layer ------------------------------------------------------------
-- One row per uploaded file. tenant_id + optional lead_id (for project-scoped
-- uploads). `kind` drives the default render style on the map; `color` is the
-- per-layer accent. `status` reflects the parsing lifecycle.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gis.layer (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  lead_id         UUID REFERENCES sales.lead(id) ON DELETE SET NULL,
  uploader_id     UUID,                               -- iam.user_profile.id
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'pipes','electrical','architectural','blueprint',
                    'topology','assets','other'
                  )),
  source_format   TEXT NOT NULL CHECK (source_format IN (
                    'geojson','shapefile','kml','kmz',
                    'geotiff','pdf','png','jpg','other'
                  )),
  status          TEXT NOT NULL DEFAULT 'parsing'
                  CHECK (status IN ('parsing','ready','failed')),
  parse_error     TEXT,
  file_id         UUID REFERENCES sales.file(id) ON DELETE SET NULL,
  bbox            geography(POLYGON, 4326),
  feature_count   INTEGER DEFAULT 0,
  visible         BOOLEAN NOT NULL DEFAULT true,
  color           TEXT NOT NULL DEFAULT '#00d4ff',
  opacity         REAL NOT NULL DEFAULT 0.8 CHECK (opacity BETWEEN 0 AND 1),
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gis_layer_tenant_idx
  ON gis.layer (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gis_layer_lead_idx
  ON gis.layer (tenant_id, lead_id) WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gis_layer_bbox_idx
  ON gis.layer USING GIST (bbox);

-- ---- gis.feature ----------------------------------------------------------
-- Individual vector features (line / polygon / point) parsed from the source.
-- properties is the GeoJSON properties dict from upload — kept as-is so
-- customer-specific attributes (pipe diameter, voltage, etc.) survive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gis.feature (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id        UUID NOT NULL REFERENCES gis.layer(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  geom            geography(GEOMETRY, 4326) NOT NULL,
  geom_type       TEXT NOT NULL CHECK (geom_type IN (
                    'Point','LineString','Polygon',
                    'MultiPoint','MultiLineString','MultiPolygon'
                  )),
  properties      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gis_feature_layer_idx
  ON gis.feature (layer_id);

CREATE INDEX IF NOT EXISTS gis_feature_tenant_idx
  ON gis.feature (tenant_id);

CREATE INDEX IF NOT EXISTS gis_feature_geom_idx
  ON gis.feature USING GIST (geom);

-- ---- gis.raster -----------------------------------------------------------
-- For georeferenced rasters (GeoTIFF) — bounds extracted from file metadata.
-- For non-geo PDFs / PNGs / JPGs — bounds initially null until the customer
-- (or ops) georeferences via the map UI (drag corners onto the basemap).
-- georef_matrix is a 6-tuple affine transform JSON: [a, b, c, d, e, f]
-- (same convention as world files).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gis.raster (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id        UUID NOT NULL REFERENCES gis.layer(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  file_id         UUID REFERENCES sales.file(id) ON DELETE SET NULL,
  bounds          geography(POLYGON, 4326),
  georef_matrix   JSONB,
  width_px        INTEGER,
  height_px       INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gis_raster_layer_idx
  ON gis.raster (layer_id);

CREATE INDEX IF NOT EXISTS gis_raster_tenant_idx
  ON gis.raster (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gis_raster_bounds_idx
  ON gis.raster USING GIST (bounds);
