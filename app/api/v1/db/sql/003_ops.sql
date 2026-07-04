-- =============================================================================
-- 003_ops.sql — Project Manager (case lifecycle)
-- -----------------------------------------------------------------------------
-- Cases drive the PM surface. Each case can be linked back to a map detection
-- via detection_id so the dashboard can deep-link into a case.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.case (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | assigned | in_progress | blocked | closed
  priority      TEXT NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  detection_id  TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS case_tenant_status_idx ON ops.case (tenant_id, status);
CREATE INDEX IF NOT EXISTS case_tenant_priority_idx ON ops.case (tenant_id, priority);

CREATE TABLE IF NOT EXISTS ops.case_assignment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  case_id      UUID NOT NULL REFERENCES ops.case(id) ON DELETE CASCADE,
  assignee_id  UUID NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS case_assignment_case_idx ON ops.case_assignment (tenant_id, case_id);

CREATE TABLE IF NOT EXISTS ops.case_activity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  case_id     UUID NOT NULL REFERENCES ops.case(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- comment | status_change | assignment | attachment
  body        TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_activity_case_idx ON ops.case_activity (tenant_id, case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.case_attachment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  case_id      UUID NOT NULL REFERENCES ops.case(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_attachment_case_idx ON ops.case_attachment (tenant_id, case_id);
