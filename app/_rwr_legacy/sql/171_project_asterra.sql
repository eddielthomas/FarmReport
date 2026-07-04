-- =============================================================================
-- 171_project_asterra.sql — bind a crm.project to an ASTERRA Recover project.
-- -----------------------------------------------------------------------------
-- P3 (Asterra live ingest): a project whose leak_source='asterra' pulls its
-- leak polygons (POIs) from the ASTERRA Recover API instead of the AlphaGeoCore
-- gateway. To do that we need to know WHICH ASTERRA-side project id to query.
--
-- leak_source is free TEXT today (no CHECK constraint — see 166_crm_project_aoi)
-- so 'asterra' is already a legal value; this migration only adds the column
-- that carries the upstream project id the ingest scheduler reads.
--
-- Strictly additive + idempotent.
-- =============================================================================

BEGIN;

ALTER TABLE crm.project
  ADD COLUMN IF NOT EXISTS asterra_project_id TEXT NULL;

COMMENT ON COLUMN crm.project.asterra_project_id IS
  'ASTERRA Recover API project id (numeric, stored as TEXT) to pull POIs/leaks '
  'from when leak_source=''asterra''. NULL = not an ASTERRA-backed project. '
  'Used by api/ingest-asterra.mjs to discover which projects to auto-ingest.';

COMMIT;
