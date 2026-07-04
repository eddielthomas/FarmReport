-- =============================================================================
-- 134_oauth_vault.sql — EPIC-007 P-007 Phase 1: per-tenant DEK + OAuth
-- credential vault with envelope-encryption support.
-- -----------------------------------------------------------------------------
-- Depends on: 001_iam.sql (tenant, user_profile), 116_iam_identity.sql.
--
-- Tables:
--   iam.tenant_dek                     — per-tenant Data Encryption Key,
--                                        wrapped by a KMS-held KEK.
--   iam.oauth_credential               — encrypted access/refresh tokens.
--   iam.oauth_credential_rotation_log  — append-only rotation audit trail.
--
-- All three are tenant-scoped (tenant_id FK + RLS). The DEK is itself
-- ciphertext: the plaintext is materialised only briefly in the app process
-- after a KMS unwrap call. See mvp/api/v1/lib/oauth-vault.mjs.
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- iam.tenant_dek --------------------------------------------------------
-- One active row per tenant. dek_ciphertext is the KEK-wrapped DEK; the
-- plaintext is never persisted. kek_alias identifies which KMS key wraps it
-- (e.g. 'local-dev-only', 'aws-kms:arn:...', 'gcp-kms:projects/...').
CREATE TABLE IF NOT EXISTS iam.tenant_dek (
  tenant_id        UUID NOT NULL PRIMARY KEY REFERENCES iam.tenant(id) ON DELETE CASCADE,
  dek_ciphertext   BYTEA NOT NULL,
  kek_alias        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at       TIMESTAMPTZ
);
-- audit:tenant gate requires a leading tenant_id index. The PK already covers
-- (tenant_id) but we add an explicit named index so the scanner picks it up.
CREATE INDEX IF NOT EXISTS tenant_dek_tenant_idx
  ON iam.tenant_dek (tenant_id);

COMMENT ON TABLE iam.tenant_dek IS
  'Per-tenant Data Encryption Key, wrapped by KMS-held KEK. Plaintext lives only briefly in memory.';

-- ---- iam.oauth_credential --------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.oauth_credential (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id                  UUID REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider IN ('google','outlook','ical','outlook-app')),
  external_account_id      TEXT,
  scope                    TEXT,
  access_token_ciphertext  BYTEA,
  refresh_token_ciphertext BYTEA,
  nonce                    BYTEA,
  expires_at               TIMESTAMPTZ,
  revoked_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_credential_tenant_idx
  ON iam.oauth_credential (tenant_id, provider);
CREATE INDEX IF NOT EXISTS oauth_credential_tenant_user_idx
  ON iam.oauth_credential (tenant_id, user_id);

-- A user may have at most one ACTIVE (non-revoked) credential per provider.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_credential_active_uniq
  ON iam.oauth_credential (tenant_id, user_id, provider)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE iam.oauth_credential IS
  'Encrypted OAuth tokens for calendar (and future) provider integrations.';

-- ---- iam.oauth_credential_rotation_log -------------------------------------
CREATE TABLE IF NOT EXISTS iam.oauth_credential_rotation_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  credential_id   UUID NOT NULL REFERENCES iam.oauth_credential(id) ON DELETE CASCADE,
  rotated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason          TEXT NOT NULL,
  kek_alias_from  TEXT,
  kek_alias_to    TEXT
);
CREATE INDEX IF NOT EXISTS oauth_rotation_tenant_credential_idx
  ON iam.oauth_credential_rotation_log (tenant_id, credential_id, rotated_at DESC);

COMMENT ON TABLE iam.oauth_credential_rotation_log IS
  'Append-only audit trail of OAuth credential rotation events (DEK rewrap, refresh, etc.).';

-- ---- RLS -------------------------------------------------------------------
ALTER TABLE iam.tenant_dek                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.oauth_credential               ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.oauth_credential_rotation_log  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('iam', 'tenant_dek',                    'tenant_dek_tenant_iso'),
      ('iam', 'oauth_credential',              'oauth_credential_tenant_iso'),
      ('iam', 'oauth_credential_rotation_log', 'oauth_rotation_tenant_iso')
    ) AS s(sch, tbl, pol)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = spec.sch AND tablename = spec.tbl AND policyname = spec.pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        spec.pol, spec.sch, spec.tbl
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
