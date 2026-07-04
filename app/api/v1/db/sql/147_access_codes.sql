-- =============================================================================
-- 147_access_codes.sql — Sprint 10B: per-tenant + platform-global access codes.
-- -----------------------------------------------------------------------------
-- Backs the access-code gate (mvp/access.html → POST /api/v1/access/verify).
-- The gate sits in front of EVERY authenticated surface (sales/pm/analytics/
-- tenants/staff/customer/operations/vendor/field/login/dashboard) and is
-- enforced by accessGate.mjs which verifies a short-lived JWT issued on
-- successful code verification.
--
-- Code values are stored as sha256(plaintext) hex digests; the plaintext is
-- shown ONCE at mint time and never persisted. Code rows may be:
--   * Tenant-scoped (tenant_id NOT NULL) — minted by tenant.admin for that
--     tenant's invite cohort.
--   * Platform-global (tenant_id IS NULL) — minted by platform.admin and
--     accepted by anyone (resolves to whichever tenant the user picks at
--     /login.html; the pass token simply marks "human-on-the-other-side").
--
-- RLS is enabled with the canonical tenant_iso policy. Platform admins use
-- service-role queries (no app.tenant_id binding) to manage global codes.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS iam.access_code (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NULL,
  max_uses        INTEGER NULL CHECK (max_uses IS NULL OR max_uses > 0),
  current_uses    INTEGER NOT NULL DEFAULT 0,
  created_by      UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS access_code_tenant_idx
  ON iam.access_code (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS access_code_active_idx
  ON iam.access_code (code_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS access_code_expires_idx
  ON iam.access_code (expires_at)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

COMMENT ON TABLE iam.access_code IS
  'Sprint 10B pilot access codes. tenant_id NULL = platform-global. Codes are stored as sha256 hex; plaintext shown once at mint. Successful verify mints a short-lived rwr.access_pass JWT consumed by accessGate.mjs.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE iam.access_code ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'iam' AND tablename = 'access_code'
                AND policyname = 'access_code_tenant_iso') THEN
    EXECUTE 'DROP POLICY access_code_tenant_iso ON iam.access_code';
  END IF;
  -- Tenant-scoped rows are visible only to their tenant. Platform-global rows
  -- (tenant_id IS NULL) are visible to everyone with the table grant — the
  -- application layer gates mint/list on platform.admin.
  EXECUTE
    'CREATE POLICY access_code_tenant_iso ON iam.access_code '
    'USING (tenant_id IS NULL '
    '       OR tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
    'WITH CHECK (tenant_id IS NULL '
    '            OR tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
END $$;

COMMIT;
