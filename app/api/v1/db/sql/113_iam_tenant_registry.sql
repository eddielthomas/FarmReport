-- =============================================================================
-- 113_iam_tenant_registry.sql — extend iam.tenant into a full registry.
-- -----------------------------------------------------------------------------
-- Sprint 1A (CRM EPIC-001 Phase F-2). Adds registry-grade columns to iam.tenant
-- so downstream isolation, residency, and lifecycle work has a place to live.
--
-- Additive only. No column drops. Idempotent (IF NOT EXISTS / DO blocks for
-- check constraint creation). Safe to re-run.
-- =============================================================================

ALTER TABLE iam.tenant
  ADD COLUMN IF NOT EXISTS classification     TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS isolation_mode     TEXT NOT NULL DEFAULT 'row-level',
  ADD COLUMN IF NOT EXISTS region             TEXT NOT NULL DEFAULT 'us-east-1',
  ADD COLUMN IF NOT EXISTS data_residency     TEXT NOT NULL DEFAULT 'us',
  ADD COLUMN IF NOT EXISTS feature_flags      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS parent_tenant_id   UUID NULL REFERENCES iam.tenant(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dedicated_dsn      TEXT NULL,
  ADD COLUMN IF NOT EXISTS schema_name        TEXT NULL,
  ADD COLUMN IF NOT EXISTS contract_starts_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS contract_ends_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ NULL;

-- Idempotent CHECK constraint installs. ALTER TABLE ADD CONSTRAINT does not
-- support IF NOT EXISTS pre-PG17 so we guard via pg_constraint lookup.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_classification_chk' AND conrelid = 'iam.tenant'::regclass
  ) THEN
    ALTER TABLE iam.tenant
      ADD CONSTRAINT tenant_classification_chk
        CHECK (classification IN ('public','internal','confidential','secret'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_isolation_mode_chk' AND conrelid = 'iam.tenant'::regclass
  ) THEN
    ALTER TABLE iam.tenant
      ADD CONSTRAINT tenant_isolation_mode_chk
        CHECK (isolation_mode IN ('row-level','schema','dedicated'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_status_chk' AND conrelid = 'iam.tenant'::regclass
  ) THEN
    ALTER TABLE iam.tenant
      ADD CONSTRAINT tenant_status_chk
        CHECK (status IN ('active','trial','suspended','read_only','provisioning'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tenant_deleted_at_idx ON iam.tenant (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS tenant_classification_idx
  ON iam.tenant (classification);

CREATE INDEX IF NOT EXISTS tenant_parent_idx ON iam.tenant (parent_tenant_id)
  WHERE parent_tenant_id IS NOT NULL;

COMMENT ON COLUMN iam.tenant.classification    IS 'public | internal | confidential | secret. Drives downstream isolation strictness.';
COMMENT ON COLUMN iam.tenant.isolation_mode    IS 'row-level (default) | schema (per-tenant schema) | dedicated (separate DB DSN).';
COMMENT ON COLUMN iam.tenant.feature_flags     IS 'Free-form JSONB; structured per-key access via iam.tenant_feature_flag.';
COMMENT ON COLUMN iam.tenant.parent_tenant_id  IS 'Optional org-parent relationship (e.g. agency owns customer tenants).';
COMMENT ON COLUMN iam.tenant.deleted_at        IS 'Soft-delete tombstone; NULL = active row.';
COMMENT ON COLUMN iam.tenant.dedicated_dsn     IS 'PG DSN reference for isolation_mode=dedicated; secret material kept in the secret store.';
COMMENT ON COLUMN iam.tenant.schema_name       IS 'Per-tenant Postgres schema when isolation_mode=schema.';
