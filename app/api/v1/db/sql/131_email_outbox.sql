-- =============================================================================
-- 131_email_outbox.sql — EPIC-006 P-006 S3B Phase 2 durable email queue.
-- -----------------------------------------------------------------------------
-- Creates the `email` schema and `email.outbox` table.
--
-- Lifecycle:
--   queued -> sending -> sent
--             sending -> failed  (transient — next_attempt_at scheduled out)
--             sending -> dead_letter (attempts >= 5)
--
-- Rows are tenant-scoped (FK -> iam.tenant) so the same RLS pattern used by
-- analytics.* applies. The drain worker opens a tenant-bound transaction
-- (set_config app.tenant_id) before pulling rows; cross-tenant leakage is
-- prevented at the policy layer.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS email;

CREATE TABLE IF NOT EXISTS email.outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  recipient_email     TEXT NOT NULL,
  recipient_user_id   UUID,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','sent','failed','dead_letter')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at           TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant-leading index satisfies audit-tenant-id.mjs and supports per-tenant
-- queue inspection from the admin surface.
CREATE INDEX IF NOT EXISTS outbox_tenant_kind_idx
  ON email.outbox (tenant_id, kind, created_at DESC);

-- Drain hot path: rows ready to send.
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON email.outbox (status, next_attempt_at)
  WHERE status IN ('queued','sending');

CREATE INDEX IF NOT EXISTS outbox_dead_letter_idx
  ON email.outbox (created_at DESC)
  WHERE status = 'dead_letter';

-- updated_at maintenance trigger.
CREATE OR REPLACE FUNCTION email.outbox_touch_updated_at()
RETURNS TRIGGER AS $TR$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$TR$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'outbox_touch_updated_at_trg'
       AND tgrelid = 'email.outbox'::regclass
  ) THEN
    EXECUTE 'CREATE TRIGGER outbox_touch_updated_at_trg
             BEFORE UPDATE ON email.outbox
             FOR EACH ROW EXECUTE FUNCTION email.outbox_touch_updated_at()';
  END IF;
END $$;

-- RLS — tenant isolation policy matching analytics.* / sales.* pattern.
ALTER TABLE email.outbox ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'email' AND tablename = 'outbox' AND policyname = 'outbox_tenant_iso'
  ) THEN
    EXECUTE 'CREATE POLICY outbox_tenant_iso ON email.outbox
             USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)
             WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)';
  END IF;
END $$;

COMMENT ON TABLE  email.outbox IS
  'Durable email queue. Status: queued -> sending -> (sent | failed retry | dead_letter).';
COMMENT ON COLUMN email.outbox.kind IS
  'lead_created | lead_status_changed | meeting_scheduled | case_assigned | chat_alert | welcome | password_reset';
COMMENT ON COLUMN email.outbox.payload IS
  'Template-render input rendered at send-time by the drain worker.';
COMMENT ON COLUMN email.outbox.recipient_user_id IS
  'Resolved iam.user_profile.id when the recipient is an internal user. NULL for external addresses.';

COMMIT;
