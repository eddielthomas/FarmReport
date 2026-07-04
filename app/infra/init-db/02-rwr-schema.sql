-- =============================================================================
-- RWR core schema for satellite-derived water-recovery data.
-- Mirrors the harvested shapes documented in the satellite data dictionary under docs/integrations/
-- =============================================================================

\echo '==> Creating rwr schema'
CREATE SCHEMA IF NOT EXISTS rwr AUTHORIZATION rwr;

-- ----------------------------------------------------------------------------
-- Sub-projects (top-level deployment unit)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rwr.sub_projects (
    sub_project_id        BIGINT PRIMARY KEY,
    name                  TEXT NOT NULL,
    status                TEXT,
    captured_at           TIMESTAMPTZ,
    poi_count             INT,
    leak_count            INT,
    pipe_km_total         NUMERIC,
    pipe_km_investigated  NUMERIC,
    water_save_l          NUMERIC,
    water_cost_save_usd   NUMERIC,
    energy_save_kwh       NUMERIC,
    co2_reduction_kg      NUMERIC,
    web_application_url   TEXT,
    wms_url               TEXT,
    gis_files_url         TEXT,
    raw_overall           JSONB
);

-- ----------------------------------------------------------------------------
-- Points of Interest (polygon catchments where leaks may exist)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rwr.pois (
    id                       BIGINT PRIMARY KEY,
    sub_project_id           BIGINT NOT NULL REFERENCES rwr.sub_projects(sub_project_id),
    poi_number               TEXT NOT NULL,
    investigation_result     TEXT,
    leak_type                TEXT,
    address                  TEXT,
    verified                 TEXT,
    investigation_date       TIMESTAMPTZ,
    pipe_length_m            NUMERIC,
    centroid_lon             DOUBLE PRECISION,
    centroid_lat             DOUBLE PRECISION,
    data_release_date        TIMESTAMPTZ,
    recover_insights_level   TEXT,
    delivery_name            TEXT,
    dma_name                 TEXT,
    geom                     GEOMETRY(MultiPolygon, 4326),
    raw                      JSONB
);

CREATE INDEX IF NOT EXISTS pois_geom_idx     ON rwr.pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS pois_subp_idx     ON rwr.pois (sub_project_id);
CREATE INDEX IF NOT EXISTS pois_insights_idx ON rwr.pois (recover_insights_level);

-- ----------------------------------------------------------------------------
-- Field results (verified leaks - ground truth)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rwr.field_results (
    ogc_fid              BIGINT PRIMARY KEY,
    sub_project_id       BIGINT NOT NULL REFERENCES rwr.sub_projects(sub_project_id),
    utilis_finding       TEXT NOT NULL,
    verification_result  TEXT,
    leak_type            TEXT,
    visible              TEXT,
    address              TEXT,
    timestamp_corrected  TIMESTAMPTZ,
    timestamp_date       DATE,
    repaired             TEXT,
    repaired_timestamp   TIMESTAMPTZ,
    leak_size            TEXT,
    customer_leak_unit   TEXT,
    main_sub_type        TEXT,
    service_sub_type     TEXT,
    cust_sub_type        TEXT,
    pipe_type            TEXT,
    comments             TEXT,
    crew_owner_id        BIGINT,
    actual_lon           DOUBLE PRECISION,
    actual_lat           DOUBLE PRECISION,
    geom                 GEOMETRY(Point, 4326),
    raw                  JSONB
);

CREATE INDEX IF NOT EXISTS field_results_geom_idx     ON rwr.field_results USING GIST (geom);
CREATE INDEX IF NOT EXISTS field_results_subp_idx     ON rwr.field_results (sub_project_id);
CREATE INDEX IF NOT EXISTS field_results_finding_idx  ON rwr.field_results (utilis_finding);

-- ----------------------------------------------------------------------------
-- Linkage view (joins POIs to verified leaks via utilis_id <-> trim(utilis_finding))
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW rwr.poi_with_leak AS
SELECT
    p.id                       AS poi_id,
    p.poi_number,
    p.recover_insights_level,
    p.geom                     AS poi_geom,
    f.ogc_fid,
    f.verification_result,
    f.leak_type,
    f.address                  AS leak_address,
    f.geom                     AS leak_geom
FROM rwr.pois p
LEFT JOIN rwr.field_results f
       ON p.poi_number = TRIM(f.utilis_finding)
      AND p.sub_project_id = f.sub_project_id;

\echo '==> rwr schema ready'
