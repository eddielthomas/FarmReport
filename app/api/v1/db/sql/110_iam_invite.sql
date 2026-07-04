-- =============================================================================
-- 110_iam_invite.sql — invite tokens for /auth/register-with-invite
-- -----------------------------------------------------------------------------
-- Replaces the open self-serve /auth/register flow (Phase F-1 S0). Tokens are
-- stored hashed-at-rest (sha256 hex). The plaintext is shown ONCE at mint and
-- never persisted. Consumption is single-use, time-bounded (expires_at), and
-- gated by an atomic UPDATE ... WHERE consumed_at IS NULL RETURNING * to
-- prevent races.
--
-- Idempotent (IF NOT EXISTS). Additive only — no DROP COLUMN.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.invite (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role_keys     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  invited_by    UUID REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  consumed_at   TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS invite_tenant_email_idx
  ON iam.invite (tenant_id, email);

CREATE INDEX IF NOT EXISTS invite_tenant_created_idx
  ON iam.invite (tenant_id, created_at DESC);

COMMENT ON TABLE iam.invite IS
  'Single-use, hashed invite tokens. Plaintext shown once at mint; consumption is atomic via UPDATE … WHERE consumed_at IS NULL RETURNING *.';
