-- =============================================================================
-- 167_crm_scan_detection.sql — the scan + detection spine.
-- -----------------------------------------------------------------------------
-- Until now leak indicators lived ONLY as bundled JSON (sub-project 676251) or
-- as read-through relays to the AlphaGeoCore gateway. Nothing tied a client →
-- project → scan → detections inside RWR. This migration adds that spine so a
-- scan can be REQUESTED for a project's AOI, tracked through a status lifecycle,
-- and its resulting detections PERSISTED + attributed to the project.
--
-- Tables:
--   crm.scan       — one row per scan request/execution for a project AOI.
--                    Lifecycle: requested → queued → running → complete | failed.
--                    Carries the AOI snapshot, the upstream source + job id, and
--                    a result_summary (counts) once complete.
--   crm.detection  — one row per persisted indicator a scan surfaced. Carries
--                    geometry, scoring, and the dispatch-integrity provenance
--                    (integrity_mode / is_reference / dispatchable / tier) so the
--                    HARD RULE (never dispatch a reference) is enforceable from
--                    our own DB, not just the gateway.
--
-- RLS + Bell-LaPadula clearance bound to every row (same pattern as 150).
-- Strictly additive + idempotent.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS crm;

-- ---- crm.scan ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.scan (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification  TEXT NOT NULL DEFAULT 'internal'
                    CHECK (classification IN ('public','internal','confidential','secret')),
  project_id      UUID NOT NULL REFERENCES crm.project(id) ON DELETE CASCADE,
  -- Where the scan pulls from: 'gateway' (AlphaGeoCore pois-by-bbox / harvest),
  -- 'asterra' (Recover API), or 'bundled' (in-repo 676251 dataset).
  source          TEXT NOT NULL DEFAULT 'gateway'
                    CHECK (source IN ('gateway','asterra','bundled')),
  status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','queued','running','complete','failed','cancelled')),
  -- AOI snapshot at request time (so editing the project later doesn't rewrite
  -- what this scan actually covered).
  aoi_west        DOUBLE PRECISION NULL,
  aoi_south       DOUBLE PRECISION NULL,
  aoi_east        DOUBLE PRECISION NULL,
  aoi_north       DOUBLE PRECISION NULL,
  sub_project_id  TEXT NULL,                 -- upstream dataset id (e.g. 676251)
  gateway_job_id  TEXT NULL,                 -- upstream async job handle, if any
  result_summary  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {detections, confirmed, suspected, …}
  error           TEXT NULL,
  requested_by    UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ NULL,
  completed_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_tenant_project_idx
  ON crm.scan (tenant_id, project_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS scan_tenant_status_idx
  ON crm.scan (tenant_id, status);

COMMENT ON TABLE crm.scan IS
  'A scan request/execution for a crm.project AOI. Tracks the lifecycle from '
  'requested → complete and records the resulting detection counts. Detections '
  'discovered by the scan link back via crm.detection.scan_id.';

-- ---- crm.detection ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.detection (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  classification        TEXT NOT NULL DEFAULT 'internal'
                          CHECK (classification IN ('public','internal','confidential','secret')),
  scan_id               UUID NULL REFERENCES crm.scan(id) ON DELETE SET NULL,
  project_id            UUID NOT NULL REFERENCES crm.project(id) ON DELETE CASCADE,
  external_id           TEXT NULL,           -- upstream ogc_fid / detection id
  verification_result   TEXT NULL,           -- Suspected | Confirmed | …
  leak_type             TEXT NULL,
  severity              TEXT NULL CHECK (severity IS NULL OR severity IN ('high','medium','low')),
  status                TEXT NOT NULL DEFAULT 'suspected'
                          CHECK (status IN ('suspected','confirmed','valid_for_inspection',
                                            'sent_to_field','verified','false_positive','dispatched')),
  score                 NUMERIC NULL,
  era_score             NUMERIC NULL,
  risk_score            NUMERIC NULL,
  investigation_priority INTEGER NULL,
  lat                   DOUBLE PRECISION NULL,
  lon                   DOUBLE PRECISION NULL,
  geom                  GEOGRAPHY(GEOMETRY, 4326) NULL,
  -- Dispatch-integrity provenance (per RWR_AGENT_INSTRUCTIONS §0–2).
  integrity_mode        TEXT NULL,           -- real_lband_sar | cband_sar | reference_stamp | no_sar
  is_reference          BOOLEAN NULL,
  dispatchable          BOOLEAN NULL,
  tier                  TEXT NULL,           -- T2 | T3
  integrity_note        TEXT NULL,
  props                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at           TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per (project, external indicator) so re-scans upsert rather than dup.
  CONSTRAINT detection_project_external_uniq UNIQUE (project_id, external_id)
);

CREATE INDEX IF NOT EXISTS detection_tenant_project_idx
  ON crm.detection (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS detection_tenant_scan_idx
  ON crm.detection (tenant_id, scan_id);
CREATE INDEX IF NOT EXISTS detection_geom_gist
  ON crm.detection USING GIST (geom);

COMMENT ON TABLE crm.detection IS
  'A persisted leak indicator surfaced by a crm.scan, attributed to a project. '
  'Carries dispatch-integrity provenance so the never-dispatch-a-reference rule '
  'is enforceable from our own data.';

-- ---- RLS --------------------------------------------------------------------
ALTER TABLE crm.scan      ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.detection ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  pol TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['scan','detection']) LOOP
    pol := t || '_tenant_iso';
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'crm' AND tablename = t AND policyname = pol) THEN
      EXECUTE format('DROP POLICY %I ON crm.%I', pol, t);
    END IF;
    EXECUTE format(
      'CREATE POLICY %I ON crm.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '       AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification)) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid '
      '            AND iam.fn_clearance_meets(current_setting(''app.clearance'', true), classification))',
      pol, t);
  END LOOP;
END $$;

COMMIT;
