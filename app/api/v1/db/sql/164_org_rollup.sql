-- =============================================================================
-- 164_org_rollup.sql — OperationsOS Phase A / Sprint A5.2 (ADR-0024 oversight).
-- -----------------------------------------------------------------------------
-- The State sees the FOREST, never the trees. This migration adds the ORG-TIER
-- aggregate store `analytics.org_rollup`. Each district publishes pre-aggregated,
-- classification-filtered metrics here; the State oversight dashboard reads ONLY
-- this table — never a raw district row, never a district tenant GUC.
--
-- This table lives ABOVE the tenant boundary (like iam.org / iam.tenant). Its
-- scoping key is `org_id`. `district_id` is a SOURCE REFERENCE to the child
-- tenant the aggregate was computed from — it is NOT a tenant-scoping column,
-- so this table carries NO tenant_id, NO RLS policy, and is added to the EXEMPT
-- set in mvp/scripts/audit-tenant-id.mjs (mirroring the A5.1 org-tier exemptions
-- iam.org / iam.org_user_role etc.).
--
-- The A4 rwr.tenant_id GUC and every existing RLS policy are UNTOUCHED.
--
-- REVERSIBLE: a clean DOWN that drops only what this migration creates is
-- documented at the foot of the file (commented; the runner applies UP only).
--
-- Idempotent (IF NOT EXISTS). BEGIN/COMMIT. Additive only.
-- =============================================================================

BEGIN;

-- ---- analytics.org_rollup ---------------------------------------------------
-- Org-tier aggregate store: one row per
-- (org_id, district_id, bucket_date, metric, classification).
-- Only AGGREGATES are written here — never row ids / PII.
CREATE TABLE IF NOT EXISTS analytics.org_rollup (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES iam.org(id) ON DELETE CASCADE,
  -- Source reference to the child tenant the aggregate was computed FROM. This
  -- is NOT a tenant-scoping column for this org-tier table (no RLS, no FK-driven
  -- isolation): the oversight read filters on org_id, never on a district GUC.
  district_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date    DATE NOT NULL,
  metric         TEXT NOT NULL,
  value          NUMERIC NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'internal',
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, district_id, bucket_date, metric, classification)
);

-- Oversight read path: filter by org_id + window + metric, newest first.
CREATE INDEX IF NOT EXISTS org_rollup_org_date_metric_idx
  ON analytics.org_rollup (org_id, bucket_date DESC, metric);

COMMENT ON TABLE analytics.org_rollup IS
  'ADR-0024 A5.2 org-tier roll-up store (above tenancy). Scoping key is org_id; '
  'district_id is a SOURCE reference to the child tenant, NOT a tenant-scoping '
  'column. NOT RLS-scoped. Holds only classification-tagged aggregates — no PII.';
COMMENT ON COLUMN analytics.org_rollup.district_id IS
  'Source child tenant the aggregate came from. A reference, NOT a scoping column.';
COMMENT ON COLUMN analytics.org_rollup.classification IS
  'Bell-LaPadula classification of the aggregate; the oversight read caps to the '
  'caller''s clearance/org-role ceiling.';

COMMIT;

-- =============================================================================
-- DOWN (reversible) — drops ONLY what this migration created. The runner applies
-- UP only; this block is documented for manual rollback / review.
--
--   BEGIN;
--   DROP INDEX IF EXISTS analytics.org_rollup_org_date_metric_idx;
--   DROP TABLE IF EXISTS analytics.org_rollup;
--   COMMIT;
-- =============================================================================
