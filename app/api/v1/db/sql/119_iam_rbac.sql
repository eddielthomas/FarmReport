-- =============================================================================
-- 119_iam_rbac.sql — Dynamic RBAC graph (EPIC-002 / Sprint 1B).
-- -----------------------------------------------------------------------------
-- Replaces the flat `iam.user_profile.roles TEXT[]` model with a relational
-- role/permission graph that tenant admins can mutate:
--   iam.permission        — canonical permission catalog (platform-wide)
--   iam.role              — system + tenant-custom roles
--   iam.role_permission   — role -> permission edge
--   iam.user_role         — user -> role grant (with expires_at)
--   iam.field_policy      — per-role field-level mask/deny policy
--   iam.scope_grant       — ad-hoc per-resource grants
--   iam.user_profile_roles_v — denormalized role-key view (legacy compat)
--
-- Keeps iam.user_profile.roles TEXT[] in sync via trigger so legacy code paths
-- (`roles.includes('sales:manage')`) continue to work through the deprecation
-- window. Removal is deferred to F-3 per the plan.
--
-- Idempotent (IF NOT EXISTS). Additive only. Safe to re-run.
-- =============================================================================

-- ---- iam.permission --------------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.permission (
  key         TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('platform','tenant','resource')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE iam.permission IS
  'Canonical permission keys. scope_kind drives whether grant is global / tenant-scoped / per-resource.';

-- ---- iam.role --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.role (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  parent_role_id  UUID NULL REFERENCES iam.role(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique key within a tenant (or globally for tenant_id IS NULL system roles).
CREATE UNIQUE INDEX IF NOT EXISTS role_tenant_key_uniq
  ON iam.role (tenant_id, key) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS role_system_key_uniq
  ON iam.role (key) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS role_tenant_idx ON iam.role (tenant_id);

COMMENT ON COLUMN iam.role.tenant_id IS
  'NULL means system role visible to every tenant. Non-NULL means tenant-custom role.';
COMMENT ON COLUMN iam.role.parent_role_id IS
  'Permission inheritance. Evaluator walks up the chain with cycle detection.';

-- ---- iam.role_permission ---------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.role_permission (
  role_id        UUID NOT NULL REFERENCES iam.role(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES iam.permission(key) ON DELETE RESTRICT,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX IF NOT EXISTS role_permission_perm_idx
  ON iam.role_permission (permission_key);

-- ---- iam.user_role ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.user_role (
  user_id     UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES iam.role(id) ON DELETE CASCADE,
  granted_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_role_role_idx ON iam.user_role (role_id);
CREATE INDEX IF NOT EXISTS user_role_expiry_idx
  ON iam.user_role (expires_at) WHERE expires_at IS NOT NULL;

-- ---- iam.field_policy ------------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.field_policy (
  role_key   TEXT NOT NULL,
  resource   TEXT NOT NULL,
  field      TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('read','mask','deny')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, resource, field)
);
COMMENT ON TABLE iam.field_policy IS
  'Per-role field-level policy. Default for unlisted (role,resource,field) is read.';

-- ---- iam.scope_grant -------------------------------------------------------
CREATE TABLE IF NOT EXISTS iam.scope_grant (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id   UUID NOT NULL,
  permission    TEXT NOT NULL REFERENCES iam.permission(key),
  granted_by    UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NULL,
  UNIQUE (user_id, resource_type, resource_id, permission)
);
-- Lookup index. Cannot include `expires_at > now()` in the predicate (now()
-- is not IMMUTABLE) so we use a plain partial index on the active subset
-- (expires_at IS NULL) plus a secondary index for the time-bounded subset.
-- Evaluator code filters expired rows in SQL with `expires_at > now()`.
CREATE INDEX IF NOT EXISTS scope_grant_lookup_idx
  ON iam.scope_grant (user_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS scope_grant_expires_idx
  ON iam.scope_grant (expires_at) WHERE expires_at IS NOT NULL;

-- ---- iam.user_profile_roles_v ---------------------------------------------
-- Denormalized "current role keys" view used by the compat shim and the trigger.
CREATE OR REPLACE VIEW iam.user_profile_roles_v AS
  SELECT up.id AS user_id,
         up.tenant_id,
         COALESCE(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), ARRAY[]::TEXT[]) AS roles
    FROM iam.user_profile up
    LEFT JOIN iam.user_role ur
      ON ur.user_id = up.id
     AND (ur.expires_at IS NULL OR ur.expires_at > now())
    LEFT JOIN iam.role r ON r.id = ur.role_id
   GROUP BY up.id, up.tenant_id;

COMMENT ON VIEW iam.user_profile_roles_v IS
  'Resolved role-key array per user_profile (expires_at filtered). Source of truth post-F3.';

-- ---- sync trigger: keep iam.user_profile.roles[] up to date ----------------
-- On INSERT/UPDATE/DELETE of iam.user_role, recompute roles[] for the affected
-- user_profile. Best-effort: legacy tokens already on a user keep working.
CREATE OR REPLACE FUNCTION iam.fn_sync_user_profile_roles()
  RETURNS TRIGGER AS $$
DECLARE
  uid UUID;
BEGIN
  uid := COALESCE(NEW.user_id, OLD.user_id);
  IF uid IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE iam.user_profile up
     SET roles = COALESCE((
       SELECT array_agg(r.key)
         FROM iam.user_role ur
         JOIN iam.role r ON r.id = ur.role_id
        WHERE ur.user_id = uid
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
     ), up.roles)
   WHERE up.id = uid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_user_profile_roles_ins ON iam.user_role;
DROP TRIGGER IF EXISTS trg_sync_user_profile_roles_upd ON iam.user_role;
DROP TRIGGER IF EXISTS trg_sync_user_profile_roles_del ON iam.user_role;
CREATE TRIGGER trg_sync_user_profile_roles_ins
  AFTER INSERT ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.fn_sync_user_profile_roles();
CREATE TRIGGER trg_sync_user_profile_roles_upd
  AFTER UPDATE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.fn_sync_user_profile_roles();
CREATE TRIGGER trg_sync_user_profile_roles_del
  AFTER DELETE ON iam.user_role
  FOR EACH ROW EXECUTE FUNCTION iam.fn_sync_user_profile_roles();

-- ---- RLS -------------------------------------------------------------------
-- iam.user_role is tenant-scoped via the role's tenant_id (system roles have
-- tenant_id IS NULL so they are visible to all tenants; explicit policy below).
ALTER TABLE iam.user_role ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'user_role'
       AND policyname  = 'user_role_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY user_role_tenant_iso ON iam.user_role
        USING (
          EXISTS (
            SELECT 1 FROM iam.user_profile up
             WHERE up.id = user_role.user_id
               AND up.tenant_id = current_setting('app.tenant_id', true)::uuid
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM iam.user_profile up
             WHERE up.id = user_role.user_id
               AND up.tenant_id = current_setting('app.tenant_id', true)::uuid
          )
        )
    $POL$;
  END IF;
END $$;

-- iam.scope_grant is implicitly tenant-scoped via the granted user_id.
ALTER TABLE iam.scope_grant ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'scope_grant'
       AND policyname  = 'scope_grant_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY scope_grant_tenant_iso ON iam.scope_grant
        USING (
          EXISTS (
            SELECT 1 FROM iam.user_profile up
             WHERE up.id = scope_grant.user_id
               AND up.tenant_id = current_setting('app.tenant_id', true)::uuid
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM iam.user_profile up
             WHERE up.id = scope_grant.user_id
               AND up.tenant_id = current_setting('app.tenant_id', true)::uuid
          )
        )
    $POL$;
  END IF;
END $$;

-- iam.role: tenant-custom roles are tenant-scoped; system roles (tenant_id IS
-- NULL) are visible to all tenants. Read predicate allows either.
ALTER TABLE iam.role ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'iam' AND tablename = 'role'
       AND policyname  = 'role_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY role_tenant_iso ON iam.role
        USING (tenant_id IS NULL
               OR tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id IS NULL
               OR tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

-- iam.permission and iam.field_policy are platform-wide; no RLS.

COMMENT ON POLICY user_role_tenant_iso  ON iam.user_role  IS
  'tenant isolation via user_profile.tenant_id; bypass via rwr_platform role.';
COMMENT ON POLICY scope_grant_tenant_iso ON iam.scope_grant IS
  'tenant isolation via user_profile.tenant_id; bypass via rwr_platform role.';
COMMENT ON POLICY role_tenant_iso       ON iam.role       IS
  'system roles (tenant_id IS NULL) are universally visible; tenant-custom roles isolated.';
