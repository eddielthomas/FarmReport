-- =============================================================================
-- 138_crm_map.sql — Sprint 5A (EPIC-008 P-008 Phases 1-2): Map adapter schema.
-- -----------------------------------------------------------------------------
-- Adds geographic + ownership columns to sales.lead and contract-progression
-- to sales.opportunity so GET /crm/map/pins can return a colour-coded
-- FeatureCollection of leads filtered by RBAC + bbox.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

-- ---- PostGIS guard ----------------------------------------------------------
-- Already present in the compose init (infra/init-db/01-extensions.sql); we
-- repeat the CREATE EXTENSION here so the migration ledger reflects the
-- dependency and re-runs against a foreign Postgres still work.
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---- sales.lead — location + owner + assignment timestamp -------------------
ALTER TABLE sales.lead
  ADD COLUMN IF NOT EXISTS location    GEOGRAPHY(Point,4326),
  ADD COLUMN IF NOT EXISTS owner_id    UUID REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- GIST index for bbox / ST_Intersects queries.
CREATE INDEX IF NOT EXISTS lead_location_gist
  ON sales.lead USING GIST (location);

-- Composite BTREE for owner-scoped lookups (sales.agent visibility path).
CREATE INDEX IF NOT EXISTS lead_tenant_owner_idx
  ON sales.lead (tenant_id, owner_id);

COMMENT ON COLUMN sales.lead.location IS
  'EPSG:4326 geocoded address point. Nullable while the geocoder catches up — pin endpoint filters NULLs out.';
COMMENT ON COLUMN sales.lead.owner_id IS
  'Current owner (mirrors latest sales.assignment role=owner). Denormalised for fast pin queries.';
COMMENT ON COLUMN sales.lead.assigned_at IS
  'Timestamp owner_id was set. Matches sales.assignment.assigned_at of the active owner row.';

-- ---- sales.opportunity — contract progression -------------------------------
ALTER TABLE sales.opportunity
  ADD COLUMN IF NOT EXISTS contract_status TEXT NOT NULL DEFAULT 'none';

-- Add the CHECK constraint only if it doesn't already exist (idempotent).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'sales.opportunity'::regclass
       AND conname  = 'opportunity_contract_status_chk'
  ) THEN
    ALTER TABLE sales.opportunity
      ADD CONSTRAINT opportunity_contract_status_chk
      CHECK (contract_status IN ('none','drafted','sent','signed','countersigned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS opportunity_lead_contract_idx
  ON sales.opportunity (lead_id, contract_status);

COMMENT ON COLUMN sales.opportunity.contract_status IS
  'Contract progression independent of pipeline stage.
   none=no paperwork; drafted=internal draft; sent=sent to client;
   signed=client signed; countersigned=fully executed.';

-- ---- Best-effort owner_id backfill from status_history ---------------------
-- Picks the earliest changed_by per lead as a stable approximation.
-- Skipped for leads whose history has no changed_by (left NULL → invisible
-- to non-global readers, which is the safe default).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'sales' AND table_name = 'status_history'
  ) THEN
    UPDATE sales.lead l
       SET owner_id = sub.changed_by
      FROM (
        SELECT DISTINCT ON (lead_id) lead_id, changed_by
          FROM sales.status_history
         WHERE changed_by IS NOT NULL
         ORDER BY lead_id, changed_at ASC
      ) sub
     WHERE sub.lead_id = l.id
       AND l.owner_id IS NULL;
  END IF;
END $$;
