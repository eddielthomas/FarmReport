-- =============================================================================
-- 111_rls_iam.sql — row-level security on iam.user_profile + iam.invite
-- -----------------------------------------------------------------------------
-- Enforces tenant isolation at the database layer for IAM tables.
--   iam.user_profile  — user accounts; never cross-tenant
--   iam.invite        — invite tokens; never cross-tenant
--
-- iam.tenant is intentionally NOT covered: platform admins legitimately query
-- across tenants for billing, status, lifecycle. They use a separate role
-- `rwr_platform` (BYPASSRLS) which is provisioned out-of-band by ops; we do
-- NOT switch app role at runtime in S0.
--
-- App connections set `SET LOCAL app.tenant_id = '<uuid>'` per request via
-- withTenantConn() in db/pool.mjs. The policy uses current_setting(...,true)
-- so missing-setting returns NULL (=> policy rejects) rather than raising.
--
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

-- --- iam.user_profile --------------------------------------------------------
ALTER TABLE iam.user_profile ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'iam' AND tablename = 'user_profile'
      AND policyname  = 'user_profile_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY user_profile_tenant_iso ON iam.user_profile
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

-- --- iam.invite --------------------------------------------------------------
ALTER TABLE iam.invite ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'iam' AND tablename = 'invite'
      AND policyname  = 'invite_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY invite_tenant_iso ON iam.invite
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

-- Document the bypass role expected at ops layer. We do not CREATE ROLE here
-- to keep the migration runnable as the app role; ops provisions rwr_platform
-- out-of-band and uses it for DDL + cross-tenant admin queries only.
COMMENT ON POLICY user_profile_tenant_iso ON iam.user_profile IS
  'tenant isolation; bypass via role rwr_platform (BYPASSRLS, provisioned by ops)';
COMMENT ON POLICY invite_tenant_iso ON iam.invite IS
  'tenant isolation; bypass via role rwr_platform (BYPASSRLS, provisioned by ops)';
