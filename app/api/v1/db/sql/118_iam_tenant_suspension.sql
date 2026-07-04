-- =============================================================================
-- 118_iam_tenant_suspension.sql — audit history of tenant suspensions.
-- -----------------------------------------------------------------------------
-- Every transition of iam.tenant.status into 'suspended' inserts a row here
-- (started_at = now()). Resume sets ended_at on the open row. Tenant-scoped;
-- cascade on tenant delete.
--
-- tenant_id is the leading PK column via index for the audit-tenant gate.
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.tenant_suspension (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ NULL,
  suspended_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  ended_by      UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS tenant_suspension_tenant_idx
  ON iam.tenant_suspension (tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS tenant_suspension_active_idx
  ON iam.tenant_suspension (tenant_id)
  WHERE ended_at IS NULL;

COMMENT ON TABLE iam.tenant_suspension IS
  'Audit-quality history of every suspend/resume on iam.tenant.status. Each suspend inserts one row; each resume closes that row.';
