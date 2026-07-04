-- =============================================================================
-- 132_email_prefs.sql — EPIC-006 P-006 S3B Phase 3 email preference matrix.
-- -----------------------------------------------------------------------------
-- iam.tenant_email_pref — tenant-level opt-out, one row per (tenant, kind).
-- iam.user_email_pref   — user-level opt-out, one row per (tenant, user, kind).
--
-- Precedence (enforced in prefs.mjs::shouldSend):
--   user > tenant > built-in default
--
-- Both tables are tenant-leading + RLS-enabled. CHECK constraint constrains
-- `kind` to the five S3B-supported event types; new kinds require a migration
-- bump (intentional — we never want a typo to silently route emails to a kind
-- nobody is reading).
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

-- ---- iam.tenant_email_pref --------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.tenant_email_pref (
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
                CHECK (kind IN (
                  'lead_created','lead_status_changed','meeting_scheduled',
                  'case_assigned','chat_alert'
                )),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID,
  PRIMARY KEY (tenant_id, kind)
);

CREATE INDEX IF NOT EXISTS tenant_email_pref_tenant_kind_idx
  ON iam.tenant_email_pref (tenant_id, kind);

ALTER TABLE iam.tenant_email_pref ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'tenant_email_pref'
       AND policyname = 'tenant_email_pref_tenant_iso'
  ) THEN
    EXECUTE 'CREATE POLICY tenant_email_pref_tenant_iso ON iam.tenant_email_pref
             USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
             WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
  END IF;
END $$;

-- ---- iam.user_email_pref ----------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.user_email_pref (
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL
                CHECK (kind IN (
                  'lead_created','lead_status_changed','meeting_scheduled',
                  'case_assigned','chat_alert'
                )),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS user_email_pref_tenant_user_idx
  ON iam.user_email_pref (tenant_id, user_id, kind);

ALTER TABLE iam.user_email_pref ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'user_email_pref'
       AND policyname = 'user_email_pref_tenant_iso'
  ) THEN
    EXECUTE 'CREATE POLICY user_email_pref_tenant_iso ON iam.user_email_pref
             USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
             WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
  END IF;
END $$;

COMMENT ON TABLE iam.tenant_email_pref IS
  'Tenant-level email opt-out by kind. Defaults are not stored; absence = default-on.';
COMMENT ON TABLE iam.user_email_pref IS
  'User-level email opt-out by kind. Overrides tenant pref; absence = fall through to tenant.';

COMMIT;
