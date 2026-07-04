-- =============================================================================
-- 170_field_verification.sql — field verification post-back (P5).
-- -----------------------------------------------------------------------------
-- Until now a persisted detection (crm.detection) could be sent to the field
-- but nothing closed the loop: a field tech's findings never graduated the
-- indicator to verified / false_positive inside RWR. This migration adds the
-- post-back record so a field result graduates the detection's status.
--
-- Tables:
--   crm.field_result — one row per field-tech post-back against a detection.
--                      Carries the outcome, measurements, free-text notes, and
--                      photo evidence. The companion field.job (a different
--                      schema/service) is referenced by a NULLABLE field_job_id
--                      WITHOUT an FK (cross-schema, loosely coupled by design).
--
-- On post-back the API graduates crm.detection.status:
--   outcome 'false_positive' | 'no_leak'  → detection 'false_positive'
--   otherwise ('confirmed_leak'|'repaired')→ detection 'verified'
--
-- RLS + Bell-LaPadula clearance bound to every row (same pattern as 167).
-- Strictly additive + idempotent.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;

-- ---- crm.field_result -------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.field_result (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification  TEXT NOT NULL DEFAULT 'internal'
                    CHECK (classification IN ('public','internal','confidential','secret')),
  detection_id    UUID NOT NULL REFERENCES crm.detection(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES crm.project(id) ON DELETE CASCADE,
  -- field.job lives in another schema/service; carry the handle but DO NOT FK it.
  field_job_id    UUID NULL,
  outcome         TEXT NOT NULL
                    CHECK (outcome IN ('confirmed_leak','no_leak','false_positive','repaired')),
  measurements    JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes           TEXT NULL,
  photo_urls      TEXT[] NOT NULL DEFAULT '{}',
  verified_by     UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS field_result_tenant_detection_idx
  ON crm.field_result (tenant_id, detection_id);
CREATE INDEX IF NOT EXISTS field_result_tenant_project_idx
  ON crm.field_result (tenant_id, project_id);

COMMENT ON TABLE crm.field_result IS
  'A field-tech post-back graduating a crm.detection to verified or '
  'false_positive. Carries outcome, measurements, notes, and photo evidence. '
  'field_job_id is a loose (non-FK) handle into the field.job service.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE crm.field_result ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['field_result']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'crm' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON crm.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
      pol, t);
  END LOOP;
END $$;

COMMIT;
