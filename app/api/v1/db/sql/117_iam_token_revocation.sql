-- =============================================================================
-- 117_iam_token_revocation.sql — JTI blocklist for token revocation.
-- -----------------------------------------------------------------------------
-- Consulted on every authenticated request by the revocation middleware
-- (30s in-process cache). Rows are pruned after expires_at by the background
-- worker registered in iam/token_revocation.mjs.
--
-- tenant_id is NULLable because platform.admin tokens may be revoked without
-- a tenant context. When tenant_id IS NULL the row is platform-scoped and
-- the audit-tenant gate exempts the table.
--
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.token_revocation (
  jti          TEXT PRIMARY KEY,
  tenant_id    UUID NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  identity_id  UUID NULL REFERENCES iam.identity(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by   UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS token_revocation_expiry_idx
  ON iam.token_revocation (expires_at);

CREATE INDEX IF NOT EXISTS token_revocation_identity_idx
  ON iam.token_revocation (identity_id)
  WHERE identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS token_revocation_tenant_idx
  ON iam.token_revocation (tenant_id)
  WHERE tenant_id IS NOT NULL;

COMMENT ON TABLE iam.token_revocation IS
  'JTI blocklist consulted on every authenticated request. Rows pruned after expires_at by the cleanup worker.';
