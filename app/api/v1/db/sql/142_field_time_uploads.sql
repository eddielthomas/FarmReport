-- =============================================================================
-- 142_field_time_uploads.sql — Sprint 9A: time-entry + multimedia (part 3/4).
-- -----------------------------------------------------------------------------
-- field.time_entry  — open/close pair gated by GPS validation
-- field.upload      — multimedia ledger backed by MinIO bucket rwr-field-uploads
--
-- Constraints:
--   - A user may have AT MOST ONE open time_entry (ended_at IS NULL); enforced
--     by a unique partial index.
--   - duration_seconds is GENERATED; cannot drift from started_at/ended_at.
--   - field.upload.gps_verification_mode records WHICH policy gated the file
--     so audit / forensics can replay the strict-vs-lenient decision.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---- field.time_entry -------------------------------------------------------
CREATE TABLE IF NOT EXISTS field.time_entry (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  job_id            UUID NOT NULL REFERENCES field.job(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  start_location    GEOGRAPHY(Point,4326) NULL,
  end_location      GEOGRAPHY(Point,4326) NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ NULL,
  duration_seconds  INTEGER GENERATED ALWAYS AS
                      (CASE WHEN ended_at IS NULL THEN NULL
                            ELSE EXTRACT(EPOCH FROM (ended_at - started_at))::int END) STORED,
  gps_strict        BOOLEAN NOT NULL DEFAULT TRUE,
  classification    TEXT NOT NULL DEFAULT 'internal'
                      CHECK (classification IN ('public','internal','confidential','secret')),
  audit_event_id    UUID NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_entry_tenant_user_idx
  ON field.time_entry (tenant_id, user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS time_entry_tenant_job_idx
  ON field.time_entry (tenant_id, job_id, started_at DESC);

-- Single open time_entry per user — partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_one_open_per_user_uidx
  ON field.time_entry (user_id) WHERE ended_at IS NULL;

COMMENT ON TABLE field.time_entry IS
  'Time-tracking row. Open while ended_at IS NULL; check-out closes it. At most one open row per user (time_entry_one_open_per_user_uidx).';

-- ---- field.upload -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS field.upload (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  job_id                      UUID NOT NULL REFERENCES field.job(id) ON DELETE CASCADE,
  user_id                     UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  original_filename           TEXT NOT NULL,
  mime_type                   TEXT NULL,
  byte_size                   BIGINT NOT NULL CHECK (byte_size >= 0),
  sha256                      TEXT NULL,
  storage_bucket              TEXT NOT NULL,
  storage_key                 TEXT NOT NULL,
  capture_location            GEOGRAPHY(Point,4326) NULL,
  capture_accuracy_m          NUMERIC(10,2) NULL,
  captured_at                 TIMESTAMPTZ NULL,
  gps_verified                BOOLEAN NOT NULL DEFAULT FALSE,
  gps_verification_mode       TEXT NOT NULL DEFAULT 'lenient'
                                CHECK (gps_verification_mode IN ('strict','lenient','none')),
  gps_distance_from_job_m     NUMERIC(12,2) NULL,
  classification              TEXT NOT NULL DEFAULT 'internal'
                                CHECK (classification IN ('public','internal','confidential','secret')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_tenant_job_idx
  ON field.upload (tenant_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_tenant_user_idx
  ON field.upload (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS upload_location_gist
  ON field.upload USING GIST (capture_location);

COMMENT ON TABLE field.upload IS
  'Multimedia uploaded against a field.job. storage_bucket/storage_key point at MinIO. gps_verified is set by handler based on distance to job + mode.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE field.time_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE field.upload     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['time_entry','upload']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'field' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON field.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON field.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
      pol, t);
  END LOOP;
END $$;

COMMIT;
