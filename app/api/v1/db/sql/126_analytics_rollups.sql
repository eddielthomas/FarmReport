-- =============================================================================
-- 126_analytics_rollups.sql — EPIC-005 S2B daily rollup tables.
-- -----------------------------------------------------------------------------
-- Adds the analytics schema and 7 rollup tables + 1 audit table. Every table
-- is tenant-scoped (leading-tenant_id index + iam.tenant FK + RLS policy).
--
-- The rollup worker (mvp/api/v1/analytics/rollup.mjs) writes one row per
-- (tenant_id, bucket_date) tuple per rollup table, all in a single transaction.
-- ON CONFLICT … DO UPDATE so the compute is idempotent and safe to re-run.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---- analytics.daily_tenant_metrics ----------------------------------------
-- Headline KPI block, one row per (tenant, day).
CREATE TABLE IF NOT EXISTS analytics.daily_tenant_metrics (
  tenant_id               UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date             DATE NOT NULL,
  total_leads             INTEGER NOT NULL DEFAULT 0,
  pending_info_requests   INTEGER NOT NULL DEFAULT 0,
  open_leads              INTEGER NOT NULL DEFAULT 0,
  total_active_clients    INTEGER NOT NULL DEFAULT 0,
  archived_leads          INTEGER NOT NULL DEFAULT 0,
  contact_only            INTEGER NOT NULL DEFAULT 0,
  conversion_rate_bps     INTEGER NOT NULL DEFAULT 0,
  total_revenue           NUMERIC(18,4) NOT NULL DEFAULT 0,
  open_revenue            NUMERIC(18,4) NOT NULL DEFAULT 0,
  meetings_held           INTEGER NOT NULL DEFAULT 0,
  messages_sent           INTEGER NOT NULL DEFAULT 0,
  new_leads               INTEGER NOT NULL DEFAULT 0,
  new_clients             INTEGER NOT NULL DEFAULT 0,
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS daily_tenant_metrics_tenant_date_idx
  ON analytics.daily_tenant_metrics (tenant_id, bucket_date DESC);

-- ---- analytics.daily_user_metrics ------------------------------------------
-- Per-rep performance, one row per (tenant, user, day).
CREATE TABLE IF NOT EXISTS analytics.daily_user_metrics (
  tenant_id        UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL,
  bucket_date      DATE NOT NULL,
  leads_assigned   INTEGER NOT NULL DEFAULT 0,
  leads_converted  INTEGER NOT NULL DEFAULT 0,
  clients_owned    INTEGER NOT NULL DEFAULT 0,
  meetings_held    INTEGER NOT NULL DEFAULT 0,
  messages_sent    INTEGER NOT NULL DEFAULT 0,
  revenue_booked   NUMERIC(18,4) NOT NULL DEFAULT 0,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, user_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS daily_user_metrics_tenant_date_idx
  ON analytics.daily_user_metrics (tenant_id, bucket_date DESC);

-- ---- analytics.revenue_rollups ---------------------------------------------
-- Per-day per-stream per-status revenue. The Billing Streams tile groups on
-- stream_id; the income chart sums across streams.
CREATE TABLE IF NOT EXISTS analytics.revenue_rollups (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date      DATE NOT NULL,
  stream_id        UUID,
  status           TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  amount           NUMERIC(18,4) NOT NULL DEFAULT 0,
  record_count     INTEGER NOT NULL DEFAULT 0,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);
-- Logical uniqueness on (tenant, day, stream_id-nullable, status, currency).
-- Two partial unique indexes split on stream_id NULL so PG can treat them as
-- distinct buckets without resorting to COALESCE inside a PRIMARY KEY.
CREATE UNIQUE INDEX IF NOT EXISTS revenue_rollups_unique_stream_idx
  ON analytics.revenue_rollups (tenant_id, bucket_date, stream_id, status, currency)
  WHERE stream_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS revenue_rollups_unique_nostream_idx
  ON analytics.revenue_rollups (tenant_id, bucket_date, status, currency)
  WHERE stream_id IS NULL;
CREATE INDEX IF NOT EXISTS revenue_rollups_tenant_date_idx
  ON analytics.revenue_rollups (tenant_id, bucket_date DESC);
CREATE INDEX IF NOT EXISTS revenue_rollups_tenant_stream_idx
  ON analytics.revenue_rollups (tenant_id, stream_id, bucket_date DESC);

-- ---- analytics.lead_source_rollups -----------------------------------------
-- Per-day per-source new-lead count + conversion count + revenue.
CREATE TABLE IF NOT EXISTS analytics.lead_source_rollups (
  tenant_id        UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date      DATE NOT NULL,
  source           TEXT NOT NULL,
  new_leads        INTEGER NOT NULL DEFAULT 0,
  converted        INTEGER NOT NULL DEFAULT 0,
  total_revenue    NUMERIC(18,4) NOT NULL DEFAULT 0,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, bucket_date, source)
);
CREATE INDEX IF NOT EXISTS lead_source_rollups_tenant_date_idx
  ON analytics.lead_source_rollups (tenant_id, bucket_date DESC);

-- ---- analytics.conversion_rollups ------------------------------------------
-- Cohort funnel: leads created on bucket_date X, counted by how many reached
-- 'Lead' and 'Client' since.
CREATE TABLE IF NOT EXISTS analytics.conversion_rollups (
  tenant_id              UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date            DATE NOT NULL,
  cohort_size            INTEGER NOT NULL DEFAULT 0,
  to_lead                INTEGER NOT NULL DEFAULT 0,
  to_client              INTEGER NOT NULL DEFAULT 0,
  to_archived            INTEGER NOT NULL DEFAULT 0,
  median_days_to_lead    INTEGER,
  median_days_to_client  INTEGER,
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS conversion_rollups_tenant_date_idx
  ON analytics.conversion_rollups (tenant_id, bucket_date DESC);

-- ---- analytics.chat_activity_rollups ---------------------------------------
CREATE TABLE IF NOT EXISTS analytics.chat_activity_rollups (
  tenant_id            UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date          DATE NOT NULL,
  messages_inbound     INTEGER NOT NULL DEFAULT 0,
  messages_outbound    INTEGER NOT NULL DEFAULT 0,
  conversations_open   INTEGER NOT NULL DEFAULT 0,
  conversations_new    INTEGER NOT NULL DEFAULT 0,
  median_response_sec  INTEGER,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS chat_activity_rollups_tenant_date_idx
  ON analytics.chat_activity_rollups (tenant_id, bucket_date DESC);

-- ---- analytics.meeting_rollups ---------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.meeting_rollups (
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date        DATE NOT NULL,
  scheduled          INTEGER NOT NULL DEFAULT 0,
  held               INTEGER NOT NULL DEFAULT 0,
  cancelled          INTEGER NOT NULL DEFAULT 0,
  no_show            INTEGER NOT NULL DEFAULT 0,
  avg_duration_min   INTEGER,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, bucket_date)
);
CREATE INDEX IF NOT EXISTS meeting_rollups_tenant_date_idx
  ON analytics.meeting_rollups (tenant_id, bucket_date DESC);

-- ---- analytics.rollup_run --------------------------------------------------
-- Audit + idempotency gate. One row per (tenant, day) compute attempt.
CREATE TABLE IF NOT EXISTS analytics.rollup_run (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  bucket_date     DATE NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','error')),
  rows_written    INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  source_version  INTEGER NOT NULL DEFAULT 1,
  duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS rollup_run_tenant_date_idx
  ON analytics.rollup_run (tenant_id, bucket_date DESC);

-- ---- RLS on all analytics.* tables -----------------------------------------
DO $$
DECLARE
  t   TEXT;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'daily_tenant_metrics','daily_user_metrics','revenue_rollups',
      'lead_source_rollups','conversion_rollups','chat_activity_rollups',
      'meeting_rollups','rollup_run'
    ])
  LOOP
    EXECUTE format('ALTER TABLE analytics.%I ENABLE ROW LEVEL SECURITY', t);
    pol := t || '_tenant_iso';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'analytics' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON analytics.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol, t);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE analytics.daily_tenant_metrics  IS 'Headline KPI rollup per (tenant, day).';
COMMENT ON TABLE analytics.daily_user_metrics    IS 'Per-rep rollup per (tenant, user, day).';
COMMENT ON TABLE analytics.revenue_rollups       IS 'Revenue per (tenant, day, stream_id, status, currency).';
COMMENT ON TABLE analytics.lead_source_rollups   IS 'New-lead count per (tenant, day, source).';
COMMENT ON TABLE analytics.conversion_rollups    IS 'Cohort funnel per (tenant, day).';
COMMENT ON TABLE analytics.chat_activity_rollups IS 'Chat volume per (tenant, day).';
COMMENT ON TABLE analytics.meeting_rollups       IS 'Meeting counts per (tenant, day).';
COMMENT ON TABLE analytics.rollup_run            IS 'Compute audit; one row per (tenant, day, attempt).';

COMMIT;
