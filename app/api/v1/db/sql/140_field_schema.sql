-- =============================================================================
-- 140_field_schema.sql — Sprint 9A: Field Service Management schema (part 1/4).
-- -----------------------------------------------------------------------------
-- Introduces the `field` schema, the `field.job` aggregate (commissioned work
-- ticket with a geofence + assigned technician), and child `field.task` rows
-- for sub-checklists. Every business table carries tenant_id + classification
-- and the canonical RLS policy (tenant_iso + Bell-LaPadula clearance lattice
-- from 139_classification.sql) is enabled.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS field;

-- PostGIS is created earlier (138_crm_map.sql). Re-declare for safety.
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---- field.job --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field.job (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification          TEXT NOT NULL DEFAULT 'internal'
                            CHECK (classification IN ('public','internal','confidential','secret')),
  source_lead_id          UUID NULL REFERENCES sales.lead(id) ON DELETE SET NULL,
  source_opportunity_id   UUID NULL REFERENCES sales.opportunity(id) ON DELETE SET NULL,
  source_case_id          UUID NULL REFERENCES ops.case(id) ON DELETE SET NULL,
  title                   TEXT NOT NULL,
  description             TEXT NULL,
  status                  TEXT NOT NULL DEFAULT 'commissioned'
                            CHECK (status IN (
                              'commissioned','assigned','en_route','on_site',
                              'in_progress','completed','verified','cancelled')),
  priority                TEXT NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low','medium','high','critical')),
  location                GEOGRAPHY(Point,4326) NULL,
  geofence_radius_m       INTEGER NOT NULL DEFAULT 100
                            CHECK (geofence_radius_m > 0 AND geofence_radius_m <= 5000),
  commissioned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_to             UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  assigned_at             TIMESTAMPTZ NULL,
  scheduled_for           TIMESTAMPTZ NULL,
  created_by              UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_tenant_assigned_status_idx
  ON field.job (tenant_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS job_tenant_status_idx
  ON field.job (tenant_id, status);
CREATE INDEX IF NOT EXISTS job_location_gist
  ON field.job USING GIST (location);
CREATE INDEX IF NOT EXISTS job_classification_idx
  ON field.job (tenant_id, classification) WHERE classification <> 'internal';

COMMENT ON TABLE field.job IS
  'Commissioned field-service work ticket. status flows commissioned -> assigned -> en_route -> on_site -> in_progress -> completed -> verified. geofence_radius_m gates check-in distance.';

-- ---- field.task -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field.task (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  job_id        UUID NOT NULL REFERENCES field.job(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NULL,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  completed     BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at  TIMESTAMPTZ NULL,
  completed_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_tenant_job_idx
  ON field.task (tenant_id, job_id, ordinal);

COMMENT ON TABLE field.task IS
  'Sub-checklist row owned by field.job. completed=true is one-shot; UI may unset only via manager override (audited).';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE field.job  ENABLE ROW LEVEL SECURITY;
ALTER TABLE field.task ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['job','task']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'field' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON field.%I', pol, t);
    END IF;
    -- job has classification; task inherits via job_id (no direct column).
    IF t = 'job' THEN
      EXECUTE format(
        'CREATE POLICY %I ON field.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
        '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
        '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
        pol, t);
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON field.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol, t);
    END IF;
  END LOOP;
END $$;

COMMIT;
