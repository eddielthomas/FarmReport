-- =============================================================================
-- 101_audit_event.sql — append-only audit log for mutations
-- -----------------------------------------------------------------------------
-- Captures who/what/when for every high-risk write across iam, sales, ops.
-- Intentionally tenant-scoped (tenant_id NOT NULL) so multi-tenant queries
-- stay isolated. Inserts are fire-and-forget from the API layer; failures
-- to write must never block the originating mutation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS iam.audit_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  actor_id     UUID,
  actor_email  TEXT,
  action       TEXT NOT NULL,          -- e.g. 'create', 'update', 'delete', 'assign'
  resource     TEXT NOT NULL,          -- e.g. 'sales.lead', 'iam.user', 'ops.case'
  resource_id  TEXT,
  payload      JSONB DEFAULT '{}'::jsonb,
  request_id   TEXT,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_event_tenant_created_idx
  ON iam.audit_event (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_event_tenant_resource_idx
  ON iam.audit_event (tenant_id, resource, created_at DESC);
