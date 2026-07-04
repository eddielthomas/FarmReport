-- =============================================================================
-- 115_iam_tenant_alias.sql — multi-key tenant lookup.
-- -----------------------------------------------------------------------------
-- Lets a tenant be resolved by:
--   - legacy slug (slug_legacy)        e.g. former-acme-name
--   - email domain (domain)            e.g. acme.example.com
--   - Keycloak realm slug (realm)      e.g. rwr-acme
--   - external system id (external_id) e.g. salesforce account id
-- The alias is globally unique across kinds; conflict on insert is a hard 409.
--
-- Tenant-scoped via tenant_id FK; cascade on tenant delete.
-- Idempotent. Additive. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.tenant_alias (
  alias       TEXT NOT NULL,
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('slug_legacy','domain','realm','external_id')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, alias)
);

-- Globally-unique alias (across tenants) for the resolver fast-path.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_alias_alias_uq
  ON iam.tenant_alias (alias);

CREATE INDEX IF NOT EXISTS tenant_alias_tenant_idx
  ON iam.tenant_alias (tenant_id);

CREATE INDEX IF NOT EXISTS tenant_alias_kind_idx
  ON iam.tenant_alias (kind);

COMMENT ON TABLE iam.tenant_alias IS
  'Multi-key tenant lookup. Lets old slugs, email domains, and Keycloak realm names resolve to the canonical tenant id.';
