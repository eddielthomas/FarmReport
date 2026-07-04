-- =============================================================================
-- 125_billing_stream.sql — EPIC-005 S2B Billing Streams (named revenue streams).
-- -----------------------------------------------------------------------------
-- Adds:
--   - billing schema
--   - billing.stream — tenant-scoped named recurring/one-time revenue stream
--   - sales.revenue_record.stream_id (FK -> billing.stream, ON DELETE SET NULL)
--   - RLS + tenant_isolation policy on billing.stream
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS billing;

-- ---- billing.stream ---------------------------------------------------------
-- A named recurring or one-time revenue stream (e.g. "Annual subscription",
-- "Implementation fee", "Per-seat addon"). Tenant-scoped.
CREATE TABLE IF NOT EXISTS billing.stream (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('subscription','one_time','usage','milestone')),
  recurrence  TEXT CHECK (recurrence IS NULL OR recurrence IN ('monthly','quarterly','annual','custom')),
  currency    TEXT NOT NULL DEFAULT 'USD',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS stream_tenant_idx
  ON billing.stream (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stream_tenant_active_idx
  ON billing.stream (tenant_id, active);

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE billing.stream ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'billing' AND tablename = 'stream'
       AND policyname = 'stream_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY stream_tenant_iso ON billing.stream
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

COMMENT ON POLICY stream_tenant_iso ON billing.stream IS
  'tenant isolation; bypass via role rwr_platform (BYPASSRLS, provisioned by ops)';

-- ---- sales.revenue_record.stream_id ----------------------------------------
-- Add the stream_id FK column; idempotent so S2A may or may not have already
-- added it (it did not, at the time this migration was authored).
ALTER TABLE sales.revenue_record
  ADD COLUMN IF NOT EXISTS stream_id UUID;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'revenue_record_stream_id_fkey'
  ) THEN
    ALTER TABLE sales.revenue_record
      ADD CONSTRAINT revenue_record_stream_id_fkey
      FOREIGN KEY (stream_id) REFERENCES billing.stream(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS revenue_record_stream_idx
  ON sales.revenue_record (tenant_id, stream_id);

COMMENT ON TABLE billing.stream IS
  'Named revenue stream per tenant (subscription, one_time, usage, milestone).';

COMMIT;
