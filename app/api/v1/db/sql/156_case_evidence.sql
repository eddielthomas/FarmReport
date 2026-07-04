-- =============================================================================
-- 156_case_evidence.sql — Sprint: Investigation Typing + Evidence.
-- -----------------------------------------------------------------------------
-- ops.case_evidence — append-only evidence items attached to an investigation
-- (ops.case). Evidence is the raw material the Reporting engine assembles into
-- a report: photos, videos, documents, linked detections, and free-text notes.
--
-- Append-only by contract (case 3 non-negotiable): the API only ever INSERTs +
-- SELECTs. No UPDATE / DELETE handler is exposed.
--
-- Tenant RLS: deny-by-default + FORCE ROW LEVEL SECURITY so every access path
-- must go through withTenantConn() (which SET LOCAL app.tenant_id).
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.case_evidence (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  case_id     UUID NOT NULL REFERENCES ops.case(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('photo','video','document','detection','note')),
  ref_id      TEXT NULL,            -- detection id / upload id / external ref
  title       TEXT NULL,
  body        TEXT NULL,
  created_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leading tenant_id index (audit:tenant gate) + the (tenant, case, time) hot path.
CREATE INDEX IF NOT EXISTS case_evidence_tenant_case_created_idx
  ON ops.case_evidence (tenant_id, case_id, created_at DESC);

COMMENT ON TABLE ops.case_evidence IS
  'Append-only evidence items on an investigation (ops.case). Feeds the Reporting engine. No in-place mutation.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE ops.case_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.case_evidence FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='ops' AND tablename='case_evidence'
                AND policyname='case_evidence_tenant_iso') THEN
    DROP POLICY case_evidence_tenant_iso ON ops.case_evidence;
  END IF;
  CREATE POLICY case_evidence_tenant_iso ON ops.case_evidence
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

COMMIT;
