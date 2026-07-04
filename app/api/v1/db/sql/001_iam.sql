-- =============================================================================
-- 001_iam.sql — identity & tenancy
-- -----------------------------------------------------------------------------
-- Adds the iam schema with tenant + user_profile tables. Every business table
-- in later migrations references iam.tenant via FK ON DELETE CASCADE.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS iam;

CREATE TABLE IF NOT EXISTS iam.tenant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',   -- active | suspended | trial
  plan         TEXT NOT NULL DEFAULT 'mvp',      -- mvp | pro | enterprise
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam.user_profile (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL,
  roles        TEXT[] NOT NULL DEFAULT ARRAY['dashboard:view']::TEXT[],
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS user_profile_tenant_idx ON iam.user_profile (tenant_id);
