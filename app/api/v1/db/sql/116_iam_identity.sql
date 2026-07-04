-- =============================================================================
-- 116_iam_identity.sql — global identity + per-tenant membership.
-- -----------------------------------------------------------------------------
-- iam.identity is the cross-tenant user record. The Keycloak `sub` claim is
-- bound via (subject_provider, subject_id). A single identity can have N
-- memberships across tenants.
--
-- iam.tenant_membership is the per-tenant grant of an identity, carrying the
-- role bundle for the F-2 cache (P-002 introduces iam.user_role as the
-- canonical join).
--
-- Backfill at the end seeds identity + membership from existing user_profile
-- rows. Same email across tenants collapses to one identity.
--
-- iam.identity is intentionally NOT tenant-scoped (cross-tenant by design).
-- iam.tenant_membership IS tenant-scoped and gets RLS at the bottom of this
-- migration.
--
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.identity (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','locked','deleted')),
  subject_provider  TEXT NULL,
  subject_id        TEXT NULL,
  mfa_required      BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at     TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ NULL,
  UNIQUE (subject_provider, subject_id)
);

CREATE INDEX IF NOT EXISTS identity_status_idx
  ON iam.identity (status);

CREATE INDEX IF NOT EXISTS identity_subject_idx
  ON iam.identity (subject_provider, subject_id)
  WHERE subject_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS iam.tenant_membership (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  identity_id   UUID NOT NULL REFERENCES iam.identity(id) ON DELETE CASCADE,
  user_id       UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  roles         TEXT[] NOT NULL DEFAULT ARRAY['dashboard:view']::TEXT[],
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','revoked')),
  invited_by    UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  invited_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at     TIMESTAMPTZ NULL,
  revoked_at    TIMESTAMPTZ NULL,
  UNIQUE (identity_id, tenant_id)
);

-- Leading tenant_id index — required by audit:tenant gate.
CREATE INDEX IF NOT EXISTS tenant_membership_tenant_idx
  ON iam.tenant_membership (tenant_id, status);

CREATE INDEX IF NOT EXISTS tenant_membership_identity_idx
  ON iam.tenant_membership (identity_id, status);

COMMENT ON TABLE iam.identity IS
  'Global identity (cross-tenant). One row per human or service account; tenant grants live in iam.tenant_membership.';
COMMENT ON TABLE iam.tenant_membership IS
  'Per-tenant grant of an identity. Roles array is the F-2 cache; P-002 introduces iam.user_role as the canonical join.';

-- ---------------------------------------------------------------------------
-- Backfill: one identity per distinct email across all existing user_profiles.
-- Run inside a single statement so a re-run is a pure NO-OP via ON CONFLICT.
-- ---------------------------------------------------------------------------
INSERT INTO iam.identity (email, display_name, status, subject_provider)
  SELECT DISTINCT ON (email)
         email,
         display_name,
         CASE status WHEN 'active' THEN 'active' ELSE 'disabled' END,
         'dev-hs256'
    FROM iam.user_profile
ON CONFLICT (email) DO NOTHING;

INSERT INTO iam.tenant_membership (identity_id, tenant_id, user_id, roles, status, joined_at)
  SELECT i.id, up.tenant_id, up.id, up.roles, 'active', up.created_at
    FROM iam.user_profile up
    JOIN iam.identity i ON i.email = up.email
ON CONFLICT (identity_id, tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS on iam.tenant_membership. Tenant isolation by current_setting.
-- iam.identity stays open to platform.admin paths (no RLS) because it is the
-- cross-tenant primitive; downstream code consults memberships for scope.
-- ---------------------------------------------------------------------------
ALTER TABLE iam.tenant_membership ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'tenant_membership'
       AND policyname  = 'tenant_membership_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY tenant_membership_tenant_iso ON iam.tenant_membership
        USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

COMMENT ON POLICY tenant_membership_tenant_iso ON iam.tenant_membership IS
  'tenant isolation; platform-admin paths bypass via rwr_platform role (provisioned by ops).';
