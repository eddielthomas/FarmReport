-- =============================================================================
-- 135_vendor_profile.sql — S4B / EPIC-009 P-009 Phase 1: iam.vendor_profile.
-- -----------------------------------------------------------------------------
-- Introduces iam.vendor_profile (1:1 with iam.user_profile when the user carries
-- any vendor:* role). Backfills 'legacy' rows for every pre-existing
-- iam.user_profile that already has 'vendor:view' in roles[] so we don't lose
-- attribution when the canonical vendor roles are added.
--
-- Renumbered from the plan (was 180_iam_vendor_profile.sql) so it slots after
-- S3B's 132_email_prefs.sql and ahead of S4A's reserved 133/134 calendar files.
--
-- RLS + tenant_isolation. Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS iam.vendor_profile (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL UNIQUE REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  category               TEXT NOT NULL DEFAULT 'sales'
                           CHECK (category IN ('sales','data','channel','implementation','repair','other')),
  status                 TEXT NOT NULL DEFAULT 'legacy'
                           CHECK (status IN ('active','legacy','suspended','revoked')),
  company_name           TEXT,
  primary_contact_email  TEXT,
  mfa_required           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_profile_tenant_status_idx
  ON iam.vendor_profile (tenant_id, status);
CREATE INDEX IF NOT EXISTS vendor_profile_user_idx
  ON iam.vendor_profile (user_id);

COMMENT ON TABLE iam.vendor_profile IS
  'External vendor users. 1:1 with iam.user_profile when user has any vendor:* role.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE iam.vendor_profile ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'vendor_profile'
       AND policyname  = 'vendor_profile_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY vendor_profile_tenant_iso ON iam.vendor_profile
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

COMMENT ON POLICY vendor_profile_tenant_iso ON iam.vendor_profile IS
  'tenant isolation; bypass via role rwr_platform (BYPASSRLS, provisioned by ops).';

-- ---- Backfill --------------------------------------------------------------
-- Every iam.user_profile row whose legacy roles[] array contains 'vendor:view'
-- gets a vendor_profile row with category='sales', status='legacy'. The tenant
-- admin must re-categorise + activate before contract scope binds anything.
INSERT INTO iam.vendor_profile
  (tenant_id, user_id, category, status, primary_contact_email, mfa_required)
SELECT up.tenant_id, up.id, 'sales', 'legacy', up.email, TRUE
  FROM iam.user_profile up
 WHERE 'vendor:view' = ANY (up.roles)
   AND NOT EXISTS (
     SELECT 1 FROM iam.vendor_profile vp WHERE vp.user_id = up.id
   );

COMMIT;
