-- =============================================================================
-- 141_field_location.sql — Sprint 9A: technician position telemetry (part 2/4).
-- -----------------------------------------------------------------------------
-- Two stores:
--   field.technician_location          — last-known position per tech (upserted)
--   field.technician_location_history  — append-only forensic trail
--
-- Both carry tenant_id + RLS. The history table is append-only via trigger:
-- UPDATE/DELETE raise an exception so the replay trail cannot be tampered with.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---- field.technician_location (last-known) --------------------------------
CREATE TABLE IF NOT EXISTS field.technician_location (
  user_id        UUID PRIMARY KEY REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  location       GEOGRAPHY(Point,4326) NOT NULL,
  accuracy_m     NUMERIC(10,2) NULL,
  heading_deg    NUMERIC(6,2)  NULL,
  speed_mps      NUMERIC(8,2)  NULL,
  captured_at    TIMESTAMPTZ   NULL,
  posted_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tech_loc_tenant_posted_idx
  ON field.technician_location (tenant_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS tech_loc_location_gist
  ON field.technician_location USING GIST (location);

COMMENT ON TABLE field.technician_location IS
  'Last-known position per technician. Upserted on every /field/location POST. tenant_id is FK + indexed but the PK is user_id (single row per tech).';

-- ---- field.technician_location_history (append-only) -----------------------
CREATE TABLE IF NOT EXISTS field.technician_location_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  location     GEOGRAPHY(Point,4326) NOT NULL,
  accuracy_m   NUMERIC(10,2) NULL,
  heading_deg  NUMERIC(6,2)  NULL,
  speed_mps    NUMERIC(8,2)  NULL,
  captured_at  TIMESTAMPTZ   NULL,
  posted_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tech_loc_hist_tenant_captured_idx
  ON field.technician_location_history (tenant_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS tech_loc_hist_user_idx
  ON field.technician_location_history (tenant_id, user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS tech_loc_hist_location_gist
  ON field.technician_location_history USING GIST (location);

-- Append-only guard.
CREATE OR REPLACE FUNCTION field.fn_tech_loc_history_immutable()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'field_tech_location_history_immutable: % denied', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tech_loc_hist_immutable ON field.technician_location_history;
CREATE TRIGGER trg_tech_loc_hist_immutable
  BEFORE UPDATE OR DELETE ON field.technician_location_history
  FOR EACH ROW EXECUTE FUNCTION field.fn_tech_loc_history_immutable();

COMMENT ON TABLE field.technician_location_history IS
  'Append-only forensic trail of every position reported by a technician. UPDATE/DELETE blocked by trg_tech_loc_hist_immutable.';

-- ---- RLS --------------------------------------------------------------------
-- Both tables: tenant_iso. A technician implicitly sees only their own row in
-- the last-known table because the application path filters by user_id; the
-- RLS policy gates cross-tenant only (the row count per tenant is small and
-- the manager `field.location.read.tenant` permission gates the bulk read at
-- the handler layer).
ALTER TABLE field.technician_location         ENABLE ROW LEVEL SECURITY;
ALTER TABLE field.technician_location_history ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['technician_location','technician_location_history']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'field' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON field.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON field.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      pol, t);
  END LOOP;
END $$;

COMMIT;
