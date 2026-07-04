-- =============================================================================
-- 166_crm_project_aoi.sql — bind crm.project to a map AOI + leak data source.
-- -----------------------------------------------------------------------------
-- Until now a project was a pure CRM container; the dashboard always showed the
-- bundled sub-project 676251. This adds an AOI bbox + a leak-data source to each
-- project so the project switcher can load DIFFERENT areas' leak indicators:
--   leak_source='bundled'  → served from the in-repo 676251 harvest JSON
--   leak_source='gateway'  → GET /api/leaks/by-bbox (relay to AlphaGeoCore)
-- center_lat/lon + default_zoom drive the fly-to. aoi_* is [W,S,E,N].
--
-- Seeds 4 projects for the demo tenant (demoville-a): Demoville (bundled) +
-- Houston / Cypress / Puerto Plata (gateway). Strictly additive + idempotent.
-- NOTE: the gateway AOI bboxes below are first-pass and refined post-deploy
-- against the live /api/leaks/by-bbox counts (Houston 775 / Cypress 205 / PP 258).
-- =============================================================================

BEGIN;

ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS aoi_west       DOUBLE PRECISION NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS aoi_south      DOUBLE PRECISION NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS aoi_east       DOUBLE PRECISION NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS aoi_north      DOUBLE PRECISION NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS center_lat     NUMERIC(9,6) NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS center_lon     NUMERIC(9,6) NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS default_zoom   NUMERIC(5,2) NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS leak_source    TEXT NULL;
ALTER TABLE crm.project ADD COLUMN IF NOT EXISTS sub_project_id TEXT NULL;

-- ---- Seed projects for the demo tenant -------------------------------------
DO $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT id INTO v_tenant FROM iam.tenant WHERE slug = 'demoville-a' LIMIT 1;
  IF v_tenant IS NULL THEN RETURN; END IF;

  -- Existing Demoville project → bundled source + its AOI.
  UPDATE crm.project SET
    leak_source = 'bundled', sub_project_id = '676251',
    aoi_west = -95.76995, aoi_south = 29.97325, aoi_east = -95.69681, aoi_north = 30.04567,
    center_lat = 30.009456, center_lon = -95.733045, default_zoom = 12.5
  WHERE tenant_id = v_tenant AND title = 'Demoville Water Recon Q2 2026';

  -- Gateway-backed projects (idempotent by title).
  INSERT INTO crm.project (tenant_id, title, description, status, leak_source,
                           aoi_west, aoi_south, aoi_east, aoi_north,
                           center_lat, center_lon, default_zoom)
  SELECT v_tenant, t.title, t.descr, 'active', 'gateway',
         t.w, t.s, t.e, t.n, t.clat, t.clon, t.z
  FROM (VALUES
    ('Houston Core — Water Recon',  'Leak indicators across the Houston core AOI (AlphaGeoCore · 4 districts).',
        -95.60934, 29.74698, -95.36423, 29.98138,  29.864180::numeric,  -95.486785::numeric, 11.0::numeric),
    ('Cypress (LSC) — Water Recon', 'Leak indicators across the Lone Star College–CyFair AOI (AlphaGeoCore).',
        -95.69730, 29.90982, -95.69001, 29.91318,  29.911500::numeric,  -95.693655::numeric, 15.5::numeric),
    ('Puerto Plata — Water Recon',  'Leak indicators across the Puerto Plata, DR AOI (AlphaGeoCore).',
        -70.75599, 19.77537, -70.68454, 19.80362,  19.789495::numeric,  -70.720265::numeric, 13.5::numeric)
  ) AS t(title, descr, w, s, e, n, clat, clon, z)
  WHERE NOT EXISTS (
    SELECT 1 FROM crm.project p WHERE p.tenant_id = v_tenant AND p.title = t.title
  );
END $$;

COMMIT;
