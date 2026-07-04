-- =============================================================================
-- 157_case_timeline.sql — Sprint: Investigation Typing + Evidence + Timeline.
-- -----------------------------------------------------------------------------
-- ops.case_timeline — append-only chronological event log for an investigation
-- (ops.case). Distinct from ops.case_activity (which is the legacy PM comment /
-- status-change feed): the timeline is the investigation NARRATIVE the
-- Reporting engine renders as a dated sequence (typed, AOI set, evidence added,
-- status moved, field visit, etc.).
--
-- Append-only by contract. The API only INSERTs + SELECTs.
--
-- Tenant RLS: deny-by-default + FORCE.
--
-- Permissions: reuses the existing cases.read / cases.manage permission bundle
-- (already granted to ops.* + platform.admin roles and to the ops:manage /
-- platform:admin LEGACY bundles in middleware/policy.mjs). No new permission is
-- introduced, so demo ops:manage / platform:admin users work out of the box.
--
-- Strictly additive + idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.case_timeline (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  case_id     UUID NOT NULL REFERENCES ops.case(id) ON DELETE CASCADE,
  event_kind  TEXT NOT NULL,                 -- typed | aoi_set | evidence_added | status_change | note | field_visit | ...
  body        TEXT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leading tenant_id index (audit:tenant gate) + the (tenant, case, time) hot path.
CREATE INDEX IF NOT EXISTS case_timeline_tenant_case_occurred_idx
  ON ops.case_timeline (tenant_id, case_id, occurred_at DESC);

COMMENT ON TABLE ops.case_timeline IS
  'Append-only investigation narrative (ops.case). Feeds the Reporting engine timeline. No in-place mutation.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE ops.case_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.case_timeline FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='ops' AND tablename='case_timeline'
                AND policyname='case_timeline_tenant_iso') THEN
    DROP POLICY case_timeline_tenant_iso ON ops.case_timeline;
  END IF;
  CREATE POLICY case_timeline_tenant_iso ON ops.case_timeline
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

COMMIT;
