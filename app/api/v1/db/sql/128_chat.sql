-- =============================================================================
-- 128_chat.sql — EPIC-005 S3A Chat envelope (Phase 1 — schema only).
-- -----------------------------------------------------------------------------
-- Polymorphic chat envelope scoped over lead, case, vendor, customer, team,
-- project. Replaces lead-only sales.message at the read surface (sales.message
-- stays in place during the transition; backfill in 129_chat_backfill.sql).
--
-- Phase-1 surface (this file):
--   chat.conversation
--   chat.conversation_member
--   chat.message              (append-only via trigger)
--   chat.message_read
--   chat.attachment           (table only; phase 3 wires the upload pipeline)
--
-- All tenant-scoped tables carry tenant_id + FK to iam.tenant + leading
-- tenant_id index + RLS policy keyed on current_setting('app.tenant_id').
--
-- Idempotent. Additive only. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS chat;

-- ---- chat.conversation ------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat.conversation (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN
                  ('lead','case','vendor','customer','team','project')),
  scope_id     UUID NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','archived','locked','deleted')),
  channel      TEXT NOT NULL DEFAULT 'in_app'
                  CHECK (channel IN ('in_app','email','sms','external')),
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conv_tenant_scope_idx
  ON chat.conversation (tenant_id, scope_kind, scope_id);
CREATE INDEX IF NOT EXISTS conv_tenant_updated_idx
  ON chat.conversation (tenant_id, updated_at DESC);
COMMENT ON TABLE chat.conversation IS
  'Polymorphic chat envelope. scope_kind/scope_id points at any business entity.';

-- ---- chat.conversation_member -----------------------------------------------
CREATE TABLE IF NOT EXISTS chat.conversation_member (
  conversation_id    UUID NOT NULL REFERENCES chat.conversation(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL,
  role_in_convo      TEXT NOT NULL DEFAULT 'participant'
                       CHECK (role_in_convo IN ('owner','participant','observer','external')),
  joined_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at            TIMESTAMPTZ NULL,
  notify_on_message  BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (conversation_id, user_id)
);
-- Leading tenant_id index — required by the audit:tenant gate.
CREATE INDEX IF NOT EXISTS conv_member_tenant_idx
  ON chat.conversation_member (tenant_id, conversation_id);
CREATE INDEX IF NOT EXISTS conv_member_user_idx
  ON chat.conversation_member (user_id);
COMMENT ON TABLE chat.conversation_member IS
  'Membership-based authz: every read/write checks this table.';

-- ---- chat.message -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat.message (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES chat.conversation(id) ON DELETE CASCADE,
  sender_user_id   UUID NULL,
  sender_kind      TEXT NOT NULL DEFAULT 'agent'
                     CHECK (sender_kind IN ('agent','contact','vendor','system')),
  body             TEXT NOT NULL DEFAULT '',
  body_html        TEXT NULL,
  attachments      JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_id      UUID NULL REFERENCES chat.message(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Leading tenant_id indexes (audit:tenant gate + conversation hot path).
CREATE INDEX IF NOT EXISTS message_tenant_created_idx
  ON chat.message (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_tenant_conv_created_idx
  ON chat.message (tenant_id, conversation_id, created_at);

-- Append-only trigger — UPDATE / DELETE forbidden.
CREATE OR REPLACE FUNCTION chat.fn_message_immutable_guard()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'chat_message_immutable: % denied on chat.message', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chat_message_immutable ON chat.message;
CREATE TRIGGER trg_chat_message_immutable
  BEFORE UPDATE OR DELETE ON chat.message
  FOR EACH ROW EXECUTE FUNCTION chat.fn_message_immutable_guard();

COMMENT ON TABLE chat.message IS
  'Append-only — UPDATE/DELETE raise chat_message_immutable.';

-- ---- chat.message_read ------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat.message_read (
  message_id  UUID NOT NULL REFERENCES chat.message(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_read_tenant_idx
  ON chat.message_read (tenant_id, message_id);
CREATE INDEX IF NOT EXISTS message_read_user_idx
  ON chat.message_read (user_id);
COMMENT ON TABLE chat.message_read IS
  'Sparse read-receipts. Read = inserted row.';

-- ---- chat.attachment --------------------------------------------------------
-- Table only; phase 3 wires the upload + virus-scan pipeline.
CREATE TABLE IF NOT EXISTS chat.attachment (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  message_id         UUID NOT NULL REFERENCES chat.message(id) ON DELETE CASCADE,
  uploader_user_id   UUID NOT NULL,
  mime               TEXT NOT NULL,
  size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0),
  width              INTEGER NULL,
  height             INTEGER NULL,
  preview_url        TEXT NULL,
  storage_path       TEXT NOT NULL,
  checksum_sha256    TEXT NOT NULL,
  virus_scan_status  TEXT NOT NULL DEFAULT 'pending'
                       CHECK (virus_scan_status IN ('pending','clean','infected','error','skipped')),
  scanned_at         TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachment_tenant_created_idx
  ON chat.attachment (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachment_msg_idx
  ON chat.attachment (message_id);

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE chat.conversation        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.conversation_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.message             ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.message_read        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.attachment          ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['conversation','conversation_member','message','message_read','attachment'])
  LOOP
    pol := t || '_tenant_iso';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'chat' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON chat.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        pol, t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
