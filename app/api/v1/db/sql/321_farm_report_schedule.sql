-- =============================================================================
-- 321_farm_report_schedule.sql — automated report runs (scheduled delivery).
-- -----------------------------------------------------------------------------
-- Report.Farm's thesis is autonomous: it watches the farm and ships SCHEDULED
-- reports + urgent alerts on its own. This table drives the scheduler worker
-- (api/report-scheduler.mjs): each active row with next_run_at <= now() has its
-- report generated (reusing farm/reports.mjs buildAndStoreReport), delivered to
-- `recipients`, and its next_run_at advanced by the cadence.
--
-- Tenant RLS: deny-by-default + FORCE. The cross-tenant worker iterates tenants
-- and SET LOCAL app.tenant_id per tenant, so every read still passes the policy.
-- Strictly additive + idempotent.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS farm.report_schedule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  farm_id       UUID NULL REFERENCES farm.farm_profile(id) ON DELETE CASCADE,
  report_type   TEXT NOT NULL DEFAULT 'field'
                  CHECK (report_type IN ('field','executive-monthly')),
  cadence       TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  recipients    TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  next_run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at   TIMESTAMPTZ NULL,
  created_by    UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_schedule_due_idx
  ON farm.report_schedule (active, next_run_at);
CREATE INDEX IF NOT EXISTS report_schedule_tenant_idx
  ON farm.report_schedule (tenant_id, created_at DESC);

COMMENT ON TABLE farm.report_schedule IS
  'Drives the report scheduler worker: due active rows generate + deliver a report, then advance next_run_at by cadence.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE farm.report_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm.report_schedule FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='farm' AND tablename='report_schedule'
                AND policyname='report_schedule_tenant_iso') THEN
    DROP POLICY report_schedule_tenant_iso ON farm.report_schedule;
  END IF;
  CREATE POLICY report_schedule_tenant_iso ON farm.report_schedule
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

-- Scheduling reuses the existing farm report permission set (report:generate /
-- farm.report.generate) — no new permission needed.

COMMIT;
