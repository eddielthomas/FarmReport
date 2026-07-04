-- =============================================================================
-- 143_field_geofence.sql — Sprint 9A: geofence/spoofing event log (part 4/4).
-- -----------------------------------------------------------------------------
-- Append-only ledger of geofence transitions per (job, user). Recorded by the
-- location, check-in, and upload handlers whenever the technician crosses
-- in/out of a job's radius, drifts far from their own last-known position
-- (suspected spoofing), or check-in / check-out commits.
--
-- UPDATE/DELETE blocked by trigger so the trail is forensic-grade.
--
-- Idempotent. Additive only.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS field.geofence_event (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  job_id       UUID NULL REFERENCES field.job(id) ON DELETE SET NULL,
  user_id      UUID NOT NULL REFERENCES iam.user_profile(id) ON DELETE CASCADE,
  event_kind   TEXT NOT NULL
                 CHECK (event_kind IN ('entered','exited','near','far_drift','spoofing_suspected','checkin','checkout')),
  location     GEOGRAPHY(Point,4326) NULL,
  distance_m   NUMERIC(12,2) NULL,
  captured_at  TIMESTAMPTZ NULL,
  posted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS geofence_event_tenant_job_idx
  ON field.geofence_event (tenant_id, job_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS geofence_event_tenant_user_idx
  ON field.geofence_event (tenant_id, user_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS geofence_event_kind_idx
  ON field.geofence_event (tenant_id, event_kind, posted_at DESC);

-- Append-only guard.
CREATE OR REPLACE FUNCTION field.fn_geofence_event_immutable()
  RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'field_geofence_event_immutable: % denied', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_geofence_event_immutable ON field.geofence_event;
CREATE TRIGGER trg_geofence_event_immutable
  BEFORE UPDATE OR DELETE ON field.geofence_event
  FOR EACH ROW EXECUTE FUNCTION field.fn_geofence_event_immutable();

COMMENT ON TABLE field.geofence_event IS
  'Append-only geofence/spoofing event log. UPDATE/DELETE blocked by trg_geofence_event_immutable. event_kind in (entered,exited,near,far_drift,spoofing_suspected,checkin,checkout).';

-- RLS
ALTER TABLE field.geofence_event ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='field' AND tablename='geofence_event'
                AND policyname='geofence_event_tenant_iso') THEN
    DROP POLICY geofence_event_tenant_iso ON field.geofence_event;
  END IF;
  CREATE POLICY geofence_event_tenant_iso ON field.geofence_event
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

COMMIT;
