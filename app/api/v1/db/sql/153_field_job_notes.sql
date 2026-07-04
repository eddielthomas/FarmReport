-- =============================================================================
-- 153_field_job_notes.sql — Sprint S17: Field Job Management vertical slice.
-- -----------------------------------------------------------------------------
-- Adds:
--   1. field.job_note — free-text notes attached to a field.job. Same tenant
--      RLS posture as sibling field tables, plus FORCE ROW LEVEL SECURITY so
--      access ALWAYS goes through withTenantConn (which SET LOCAL app.tenant_id).
--   2. chat.conversation.scope_kind — extend the CHECK to allow the two new
--      field conversation kinds: 'field_job' (per-job thread) and 'field_ops'
--      (tenant-wide ops channel). Existing kinds are preserved.
--   3. iam.permission 'field.job.lifecycle' (Start/Pause/Resume/Complete) — but
--      lifecycle endpoints reuse the existing 'field.checkin' grant, so this is
--      catalogued for future granularity and granted to the same roles.
--   4. Chat read/write grants for field.technician so the per-job + ops channels
--      are usable from the field PWA.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS field;

-- ---- 1) field.job_note ------------------------------------------------------
CREATE TABLE IF NOT EXISTS field.job_note (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  job_id        UUID NOT NULL REFERENCES field.job(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  author_id     UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Leading tenant_id index (audit:tenant gate) + the (tenant, job, time) hot path.
CREATE INDEX IF NOT EXISTS job_note_tenant_job_created_idx
  ON field.job_note (tenant_id, job_id, created_at DESC);

COMMENT ON TABLE field.job_note IS
  'Free-text note attached to a field.job. author_id is the technician/manager who wrote it. Newest-first in the UI.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE field.job_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE field.job_note FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='field' AND tablename='job_note'
                AND policyname='job_note_tenant_iso') THEN
    DROP POLICY job_note_tenant_iso ON field.job_note;
  END IF;
  CREATE POLICY job_note_tenant_iso ON field.job_note
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

-- ---- 2) Extend chat.conversation.scope_kind CHECK ---------------------------
-- Add 'field_job' + 'field_ops' to the allowed scope kinds without dropping the
-- pre-existing values. Idempotent: re-derive the constraint each run.
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t   ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'chat' AND t.relname = 'conversation'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%scope_kind%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chat.conversation DROP CONSTRAINT %I', conname);
  END IF;
  ALTER TABLE chat.conversation
    ADD CONSTRAINT conversation_scope_kind_check
    CHECK (scope_kind IN
      ('lead','case','vendor','customer','team','project','field_job','field_ops'));
END $$;

-- ---- 2b) Extend field.job.status CHECK to allow 'paused' --------------------
-- S17 adds a pause/resume leg to the state machine: in_progress <-> paused and
-- paused -> on_site. The DB CHECK must permit the new value. Idempotent.
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t   ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'field' AND t.relname = 'job'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%'
     AND pg_get_constraintdef(c.oid) ILIKE '%in_progress%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE field.job DROP CONSTRAINT %I', conname);
  END IF;
  ALTER TABLE field.job
    ADD CONSTRAINT job_status_check
    CHECK (status IN (
      'commissioned','assigned','en_route','on_site','in_progress',
      'paused','completed','verified','cancelled'));
END $$;

-- ---- 3) field.job.lifecycle permission --------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('field.job.lifecycle', 'Start / pause / resume / complete an assigned field job', 'tenant')
ON CONFLICT (key) DO NOTHING;

-- Grant lifecycle to roles that already hold field.checkin (technician/agent)
-- and to the manager roles, so the catalog stays coherent. The runtime
-- endpoints gate on field.checkin (no new seed strictly required) but we keep
-- lifecycle reachable for future tightening.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, 'field.job.lifecycle' FROM iam.role r
   WHERE r.tenant_id IS NULL
     AND r.key IN ('field.technician','sales.agent','ops.manager','sales.manager')
ON CONFLICT DO NOTHING;

-- ---- 4) Chat read/write grants for field.technician -------------------------
-- The per-job thread + ops channel reuse /chat/conversations/:id/messages which
-- gate on crm.chat.read / crm.chat.write. field.technician needs both.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['crm.chat.read','crm.chat.write']) k
   WHERE r.key = 'field.technician' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
