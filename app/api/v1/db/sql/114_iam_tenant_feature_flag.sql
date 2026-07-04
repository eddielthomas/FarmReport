-- =============================================================================
-- 114_iam_tenant_feature_flag.sql — per-tenant feature flag store.
-- -----------------------------------------------------------------------------
-- Structured access to per-tenant rollout/threshold settings. Read on every
-- request via the flags middleware (60s LRU). Mutated by tenant.admin OR
-- platform.admin through PUT /iam/tenants/:id/flags.
--
-- Tenant-scoped (tenant_id is the leading PK column). Cascade on tenant delete.
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.tenant_feature_flag (
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL DEFAULT 'true'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Leading-tenant index implied by PK; key-only secondary for global feature
-- audits (e.g. "which tenants have crm.lifecycle.v2 enabled?").
CREATE INDEX IF NOT EXISTS tenant_feature_flag_key_idx
  ON iam.tenant_feature_flag (key);

-- Also keep a leading tenant_id index for the audit-tenant gate.
CREATE INDEX IF NOT EXISTS tenant_feature_flag_tenant_idx
  ON iam.tenant_feature_flag (tenant_id);

COMMENT ON TABLE iam.tenant_feature_flag IS
  'Per-tenant, per-feature toggle. value is JSONB so a row can carry boolean, percentage, or struct config.';
