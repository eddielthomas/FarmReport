-- =============================================================================
-- 172_registration.sql — self-service registration (request-access model).
-- -----------------------------------------------------------------------------
-- Adds opt-in customer self-registration WITHOUT weakening the invite-only
-- default. A prospect fills a public form with an ORG/ACCESS CODE (staff-issued)
-- that resolves to a tenant + default role/project; the submission is captured
-- as a PENDING request (no login is created yet). Flow:
--
--   1. submit  → iam.registration_request (status='pending', email_verified=f)
--                + email-verify token (app-owned via Resend; no Keycloak SMTP).
--   2. verify  → email_verified=true (the prospect proves the mailbox).
--   3. approve → staff create the Keycloak user + iam.user_profile, link the
--                project, mark status='approved'.  reject → status='rejected'.
--
-- Self-registration is gated by the app flag ALLOW_SELF_REGISTRATION (the public
-- config endpoint + the submit route both consult it), so the Register button
-- and route simply do not exist when it is off.
--
-- Tables live in the iam schema (auth/identity), mirror the 167 tenant_iso RLS
-- pattern, and are strictly additive + idempotent.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS iam;

-- ---- iam.registration_code --------------------------------------------------
-- Staff-issued codes that admit a registrant into a specific tenant with a
-- default role (and optional auto-link project). The code is globally unique
-- (case-insensitive) so the PUBLIC submit path can resolve the tenant from the
-- code alone, before any auth/tenant context exists.
CREATE TABLE IF NOT EXISTS iam.registration_code (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'customer:view',
  project_id   UUID NULL REFERENCES crm.project(id) ON DELETE SET NULL,
  label        TEXT NULL,
  max_uses     INTEGER NULL,                 -- NULL = unlimited
  used_count   INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS registration_code_code_ukey
  ON iam.registration_code (lower(code));
CREATE INDEX IF NOT EXISTS registration_code_tenant_idx
  ON iam.registration_code (tenant_id, active);

COMMENT ON TABLE iam.registration_code IS
  'Staff-issued org/access codes that map a self-registrant to a tenant + '
  'default role/project. Resolved by the public registration submit path.';

-- ---- iam.registration_request -----------------------------------------------
-- One row per self-registration attempt, awaiting staff approval.
CREATE TABLE IF NOT EXISTS iam.registration_request (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  code_id            UUID NULL REFERENCES iam.registration_code(id) ON DELETE SET NULL,
  email              TEXT NOT NULL,
  first_name         TEXT NULL,
  last_name          TEXT NULL,
  company            TEXT NULL,
  role               TEXT NOT NULL DEFAULT 'customer:view',
  project_id         UUID NULL REFERENCES crm.project(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected')),
  email_verified     BOOLEAN NOT NULL DEFAULT false,
  verify_token_hash  TEXT NULL,
  verify_expires_at  TIMESTAMPTZ NULL,
  kc_user_id         TEXT NULL,               -- Keycloak user id once approved
  reviewed_by        UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ NULL,
  reject_reason      TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open request per (tenant, email). Re-submitting upserts the pending row.
CREATE UNIQUE INDEX IF NOT EXISTS registration_request_tenant_email_ukey
  ON iam.registration_request (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS registration_request_status_idx
  ON iam.registration_request (tenant_id, status, created_at DESC);
-- The public verify path looks a row up by its token hash across tenants.
CREATE INDEX IF NOT EXISTS registration_request_verify_idx
  ON iam.registration_request (verify_token_hash);

COMMENT ON TABLE iam.registration_request IS
  'A pending self-registration awaiting staff approval. Email is app-verified '
  '(Resend) before approval; approval provisions the Keycloak user + profile.';

-- ---- RLS (tenant isolation; same shape as 167) ------------------------------
-- Staff reads/writes go through withTenantConn (app.tenant_id bound). The public
-- submit/verify paths use the owner pool (q()) which is exempt, and always pass
-- an explicit tenant_id resolved from the code.
ALTER TABLE iam.registration_code    ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.registration_request ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['registration_code','registration_request']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'iam' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON iam.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON iam.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      pol, t);
  END LOOP;
END $$;

COMMIT;
