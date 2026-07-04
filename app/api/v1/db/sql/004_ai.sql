-- =============================================================================
-- 004_ai.sql — agent run log (lightweight bookkeeping for AI tasks)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS ai;

CREATE TABLE IF NOT EXISTS ai.agent_run (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued | running | succeeded | failed
  input        JSONB,
  output       JSONB,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_run_tenant_idx ON ai.agent_run (tenant_id, started_at DESC);
