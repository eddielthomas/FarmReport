-- =============================================================================
-- 163_org_hierarchy.sql — OperationsOS Phase A / Sprint A5.1.
-- -----------------------------------------------------------------------------
-- Introduces the ORG tier ABOVE tenants (ADR-0024 §D). A *district* is a tenant
-- (the existing hard RLS boundary, ADR-0021 + the A4 rwr.tenant_id GUC from
-- migration 162); an *org* (e.g. a State) is the contracting parent that owns
-- many districts. This migration is strictly ADDITIVE + BACK-COMPAT:
--
--   * Org-tier tables carry `org_id`, NOT `tenant_id` — they live ABOVE the
--     tenant boundary (registry/parent-tier, like iam.tenant / iam.access_code)
--     so they are NOT tenant-scoped and get NO tenant_id RLS policy. They are
--     added to the EXEMPT set in mvp/scripts/audit-tenant-id.mjs.
--   * iam.tenant.org_id is NULLABLE. With org_id IS NULL the system behaves
--     BYTE-IDENTICALLY to today (no org claim is minted, no new required claims,
--     no changed query results). Existing tenants stay org-less.
--   * No RLS policy is created, altered, or dropped. The A4 GUC work is
--     untouched.
--
-- Idempotent (IF NOT EXISTS + ON CONFLICT + guarded seeds). Safe to re-run.
-- =============================================================================

BEGIN;

-- ---- iam.org ----------------------------------------------------------------
-- The contracting entity (e.g. a State). Parent tier above tenants.
CREATE TABLE IF NOT EXISTS iam.org (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  billing_mode TEXT NOT NULL DEFAULT 'per_district'
                 CHECK (billing_mode IN ('per_district','consolidated')),
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_id_idx ON iam.org (id);
COMMENT ON TABLE iam.org IS
  'ADR-0024 org tier: the contracting parent (a State) above tenants. NOT tenant-scoped.';

-- ---- iam.tenant.org_id ------------------------------------------------------
-- Each district is a tenant under an org. NULLABLE → back-compat: org-less
-- tenants behave exactly as today.
ALTER TABLE iam.tenant
  ADD COLUMN IF NOT EXISTS org_id UUID NULL
    REFERENCES iam.org(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tenant_org_id_idx ON iam.tenant (org_id);
COMMENT ON COLUMN iam.tenant.org_id IS
  'ADR-0024: parent org. NULL = standalone tenant (byte-identical to pre-A5.1).';

-- ---- iam.org_role -----------------------------------------------------------
-- Org-tier roles. org_id NULL = a global TEMPLATE role (visible to every org);
-- a non-NULL org_id would be an org-custom role (none seeded in A5.1).
CREATE TABLE IF NOT EXISTS iam.org_role (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NULL REFERENCES iam.org(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_role_org_id_idx ON iam.org_role (org_id);
-- Unique key per org; one row for the global template (org_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS org_role_org_key_uniq
  ON iam.org_role (org_id, key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS org_role_template_key_uniq
  ON iam.org_role (key) WHERE org_id IS NULL;
COMMENT ON COLUMN iam.org_role.org_id IS
  'NULL = global template org-role (state.admin/auditor/billing). Non-NULL = org-custom.';

-- Seed the global template org-roles (org_id NULL).
INSERT INTO iam.org_role (org_id, key, display_name) VALUES
  (NULL, 'state.admin',   'State Administrator'),
  (NULL, 'state.auditor', 'State Auditor'),
  (NULL, 'state.billing', 'State Billing')
ON CONFLICT DO NOTHING;

-- ---- iam.org_user_role ------------------------------------------------------
-- Binds a user (iam.user_profile.id — same FK style as iam.user_role) to an
-- org_role within an org.
CREATE TABLE IF NOT EXISTS iam.org_user_role (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES iam.org(id) ON DELETE CASCADE,
  user_ref      UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  org_role_key  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_ref, org_role_key)
);
CREATE INDEX IF NOT EXISTS org_user_role_org_id_idx ON iam.org_user_role (org_id);
CREATE INDEX IF NOT EXISTS org_user_role_user_idx   ON iam.org_user_role (user_ref);
COMMENT ON TABLE iam.org_user_role IS
  'ADR-0024: a user holds an org-tier role within an org. Authorizes org endpoints.';

-- ---- iam.org_scope_grant ----------------------------------------------------
-- Which child tenants an org-user may later DRILL INTO (A5.3 consumes this).
-- Created now, intentionally EMPTY.
CREATE TABLE IF NOT EXISTS iam.org_scope_grant (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES iam.org(id) ON DELETE CASCADE,
  user_ref              UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification_ceiling TEXT NULL,
  expires_at            TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_scope_grant_org_id_idx ON iam.org_scope_grant (org_id);
CREATE INDEX IF NOT EXISTS org_scope_grant_user_idx   ON iam.org_scope_grant (user_ref);
COMMENT ON TABLE iam.org_scope_grant IS
  'ADR-0024 A5.3: entitled child tenants an org-user may drill into. The tenant_id '
  'column here is the GRANTED CHILD district (a target), NOT a tenancy-scoping column '
  '— this table is org-tier and not RLS-scoped.';

-- ---- org permission bundle (catalog + grants) -------------------------------
-- Catalog org-tier permission keys the same way migration 119/160/161 seeds
-- perms. A5.2/A5.3 will ENFORCE org.rollup.view / org.drilldown; A5.1 only
-- catalogs + grants them so the resolved org context can carry them.
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('org.read',         'Read the org and its member districts',                 'platform'),
  ('org.rollup.view',  'View cross-district roll-up dashboards (A5.2)',         'platform'),
  ('org.drilldown',    'Entitled drill-down into a granted child district (A5.3)','platform'),
  ('org.billing.view', 'View consolidated org billing roll-up',                 'platform')
ON CONFLICT (key) DO NOTHING;

-- Bundle: state.admin → all org perms; state.auditor → read+rollup+drilldown;
-- state.billing → read+billing. Stored on the template org_role rows via a
-- mapping table so the resolver can expand org_role_key → permissions. We reuse
-- iam.role_permission semantics by introducing a tiny org-role→perm map.
CREATE TABLE IF NOT EXISTS iam.org_role_permission (
  org_role_key   TEXT NOT NULL,
  permission_key TEXT NOT NULL REFERENCES iam.permission(key) ON DELETE RESTRICT,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_role_key, permission_key)
);
COMMENT ON TABLE iam.org_role_permission IS
  'ADR-0024: org-role-key → permission bundle. Keyed by the template role key '
  '(state.admin/auditor/billing), org-agnostic. Not tenant-scoped.';

INSERT INTO iam.org_role_permission (org_role_key, permission_key) VALUES
  ('state.admin',   'org.read'),
  ('state.admin',   'org.rollup.view'),
  ('state.admin',   'org.drilldown'),
  ('state.admin',   'org.billing.view'),
  ('state.auditor', 'org.read'),
  ('state.auditor', 'org.rollup.view'),
  ('state.auditor', 'org.drilldown'),
  ('state.billing', 'org.read'),
  ('state.billing', 'org.billing.view')
ON CONFLICT DO NOTHING;

-- ---- demo seed (guarded + idempotent) ---------------------------------------
-- Seed an org `lone-star-water`, attach demoville-a (and acme-water if present),
-- and grant the demo admin (admin@demoville-a.local) a state.admin org role.
-- Every step no-ops when the prerequisite rows don't exist.
DO $$
DECLARE
  v_org_id     UUID;
  v_dv_id      UUID;
  v_acme_id    UUID;
  v_admin_id   UUID;
BEGIN
  -- Org (idempotent on slug).
  INSERT INTO iam.org (slug, display_name, billing_mode)
  VALUES ('lone-star-water', 'Lone Star Water Authority', 'consolidated')
  ON CONFLICT (slug) DO NOTHING;

  SELECT id INTO v_org_id FROM iam.org WHERE slug = 'lone-star-water';
  IF v_org_id IS NULL THEN
    RAISE NOTICE '[163] demo org not present; skipping seed.';
    RETURN;
  END IF;

  -- Attach demo districts (only when the tenant exists). org_id NULL elsewhere.
  SELECT id INTO v_dv_id   FROM iam.tenant WHERE slug = 'demoville-a';
  SELECT id INTO v_acme_id FROM iam.tenant WHERE slug = 'acme-water';

  IF v_dv_id IS NOT NULL THEN
    UPDATE iam.tenant SET org_id = v_org_id, updated_at = now()
      WHERE id = v_dv_id AND org_id IS DISTINCT FROM v_org_id;
  END IF;
  IF v_acme_id IS NOT NULL THEN
    UPDATE iam.tenant SET org_id = v_org_id, updated_at = now()
      WHERE id = v_acme_id AND org_id IS DISTINCT FROM v_org_id;
  END IF;

  -- Grant the demo admin a state.admin org role (only if the admin user exists).
  SELECT id INTO v_admin_id
    FROM iam.user_profile
   WHERE email = 'admin@demoville-a.local' AND tenant_id = v_dv_id
   LIMIT 1;

  IF v_admin_id IS NOT NULL THEN
    INSERT INTO iam.org_user_role (org_id, user_ref, org_role_key)
    VALUES (v_org_id, v_admin_id, 'state.admin')
    ON CONFLICT (org_id, user_ref, org_role_key) DO NOTHING;
  END IF;

  RAISE NOTICE '[163] org hierarchy demo seed complete (org=%, demoville=%, acme=%, admin=%).',
    v_org_id, v_dv_id, v_acme_id, v_admin_id;
END $$;

COMMIT;
