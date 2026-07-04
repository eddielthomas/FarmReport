-- =============================================================================
-- 133_calendar_sync.sql — EPIC-007 P-007 Phase 1: extend sales.meeting + add
-- sales.meeting_conflict for two-way calendar sync reconciliation.
-- -----------------------------------------------------------------------------
-- Depends on: 002_sales.sql (sales.meeting), 116_iam_identity.sql (user_profile).
-- All new columns/tables are additive. Idempotent. Safe to re-run.
--
-- Phase scope:
--   - Extend sales.meeting with provider/external_id/etag/sync_token/...
--   - Unique partial index on (tenant_id, provider, external_id) for
--     non-internal rows (idempotent ingest from Google/Outlook/iCal).
--   - sales.meeting_conflict — append-only conflict log; UPDATE only allowed to
--     set the resolved_at / resolved_by / resolution columns once.
--   - Backfill existing meetings to provider='internal' / status='scheduled'.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- 1) Extend sales.meeting -----------------------------------------------
ALTER TABLE sales.meeting
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS external_id     TEXT,
  ADD COLUMN IF NOT EXISTS etag            TEXT,
  ADD COLUMN IF NOT EXISTS sync_token      TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_id        UUID,
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version         INT NOT NULL DEFAULT 1;

-- CHECK constraints (NOT VALID-style, applied via DO block so re-runs do not
-- collide on the constraint name).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'meeting_provider_check'
       AND conrelid = 'sales.meeting'::regclass
  ) THEN
    ALTER TABLE sales.meeting
      ADD CONSTRAINT meeting_provider_check
      CHECK (provider IN ('internal','google','outlook','ical'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'meeting_status_check'
       AND conrelid = 'sales.meeting'::regclass
  ) THEN
    ALTER TABLE sales.meeting
      ADD CONSTRAINT meeting_status_check
      CHECK (status IN ('scheduled','tentative','cancelled','completed'));
  END IF;
  -- owner_id FK to iam.user_profile (SET NULL on delete so we never orphan a
  -- meeting row when a user is removed).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'meeting_owner_fk'
       AND conrelid = 'sales.meeting'::regclass
  ) THEN
    ALTER TABLE sales.meeting
      ADD CONSTRAINT meeting_owner_fk
      FOREIGN KEY (owner_id) REFERENCES iam.user_profile(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique partial index: external provider rows must be unique per (tenant, provider).
CREATE UNIQUE INDEX IF NOT EXISTS meeting_external_uniq
  ON sales.meeting (tenant_id, provider, external_id)
  WHERE provider != 'internal';

CREATE INDEX IF NOT EXISTS meeting_owner_idx
  ON sales.meeting (tenant_id, owner_id, start_at DESC);

CREATE INDEX IF NOT EXISTS meeting_provider_synced_idx
  ON sales.meeting (tenant_id, provider, last_synced_at);

-- ---- 2) sales.meeting_conflict (append-only) -------------------------------
CREATE TABLE IF NOT EXISTS sales.meeting_conflict (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  meeting_id      UUID NOT NULL REFERENCES sales.meeting(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google','outlook','ical')),
  conflict_kind   TEXT NOT NULL CHECK (conflict_kind IN
                    ('push_412','pull_etag_mismatch','provider_deleted','local_deleted')),
  local_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  remote_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  resolution      TEXT CHECK (resolution IS NULL OR resolution IN
                    ('keep_local','keep_remote','merge','dismissed'))
);
CREATE INDEX IF NOT EXISTS meeting_conflict_tenant_open_idx
  ON sales.meeting_conflict (tenant_id, detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS meeting_conflict_meeting_idx
  ON sales.meeting_conflict (tenant_id, meeting_id);

-- Append-only invariant: forbid DELETE; on UPDATE, only the resolution
-- columns may change. resolved_at, once set, is write-once.
CREATE OR REPLACE FUNCTION sales.fn_meeting_conflict_guard()
  RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'meeting_conflict_immutable: DELETE denied on sales.meeting_conflict'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id            IS DISTINCT FROM NEW.id            OR
       OLD.tenant_id     IS DISTINCT FROM NEW.tenant_id     OR
       OLD.meeting_id    IS DISTINCT FROM NEW.meeting_id    OR
       OLD.provider      IS DISTINCT FROM NEW.provider      OR
       OLD.conflict_kind IS DISTINCT FROM NEW.conflict_kind OR
       OLD.local_payload IS DISTINCT FROM NEW.local_payload OR
       OLD.remote_payload IS DISTINCT FROM NEW.remote_payload OR
       OLD.detected_at   IS DISTINCT FROM NEW.detected_at
    THEN
      RAISE EXCEPTION 'meeting_conflict_immutable: only resolution columns may be updated'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
      RAISE EXCEPTION 'meeting_conflict_immutable: resolved_at is write-once'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meeting_conflict_guard ON sales.meeting_conflict;
CREATE TRIGGER trg_meeting_conflict_guard
  BEFORE UPDATE OR DELETE ON sales.meeting_conflict
  FOR EACH ROW EXECUTE FUNCTION sales.fn_meeting_conflict_guard();

-- ---- 3) RLS ----------------------------------------------------------------
ALTER TABLE sales.meeting_conflict ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'sales'
       AND tablename  = 'meeting_conflict'
       AND policyname = 'meeting_conflict_tenant_iso'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY meeting_conflict_tenant_iso ON sales.meeting_conflict
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)
    $POL$;
  END IF;
END $$;

COMMENT ON TABLE sales.meeting_conflict IS
  'Append-only conflict log for two-way calendar sync. UPDATE only sets resolution.';

-- ---- 4) Backfill existing meetings -----------------------------------------
-- Defensive: even though the new columns default to 'internal'/'scheduled' for
-- new INSERTs, pre-existing rows added via ADD COLUMN DEFAULT in older PG
-- versions might end up NULL. NOT NULL guards prevent that, but the UPDATE
-- here is harmless on already-populated rows.
UPDATE sales.meeting
   SET provider = 'internal'
 WHERE provider IS NULL OR provider = '';

UPDATE sales.meeting
   SET status = 'scheduled'
 WHERE status IS NULL OR status = '';

-- Best-effort owner_id backfill: pick the oldest user_profile per tenant. If
-- the tenant has no users yet, owner_id stays NULL (which is allowed).
UPDATE sales.meeting m
   SET owner_id = sub.owner_id
  FROM (
    SELECT DISTINCT ON (tenant_id) tenant_id, id AS owner_id
      FROM iam.user_profile
      ORDER BY tenant_id, created_at ASC
  ) sub
 WHERE m.owner_id IS NULL
   AND m.tenant_id = sub.tenant_id;

COMMIT;
