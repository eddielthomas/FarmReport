-- =============================================================================
-- 161_reporting.sql — Sprint ③: Reporting engine.
-- -----------------------------------------------------------------------------
-- reports.report — a generated, point-in-time report computed by aggregating
-- across the CRM / ops / field / analytics schemas. Four report types:
--
--   exec          — leadership KPI snapshot (leads, clients, revenue, pipeline)
--   investigation — ops.case rollups by type/status + evidence/timeline volume
--   field         — field.job dispatch rollups by status + technician
--   sales         — pipeline funnel (leads -> opps -> proposals -> contracts)
--
-- `summary` holds the headline figures (cheap to list); `payload` holds the full
-- computed breakdown (returned on GET /reports/:id). Reports are immutable once
-- generated — re-running produces a new row, preserving history.
--
-- Tenant RLS: deny-by-default + FORCE so every access path must go through
-- withTenantConn() (which SET LOCAL app.tenant_id). Strictly additive +
-- idempotent. Re-runs are no-ops.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS reports;

CREATE TABLE IF NOT EXISTS reports.report (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES iam.tenant(id) ON DELETE CASCADE,
  report_type   TEXT NOT NULL
                  CHECK (report_type IN ('exec','investigation','field','sales')),
  title         TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by  UUID NULL REFERENCES iam.user_profile(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leading tenant_id index (audit:tenant gate) + the (tenant, type) and
-- (tenant, recency) hot paths for the list view.
CREATE INDEX IF NOT EXISTS report_tenant_created_idx
  ON reports.report (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS report_tenant_type_idx
  ON reports.report (tenant_id, report_type);

COMMENT ON TABLE reports.report IS
  'Generated point-in-time report (exec|investigation|field|sales). summary=headline figures, payload=full breakdown. Immutable; re-run creates a new row.';

-- ---- RLS: deny-by-default + FORCE -------------------------------------------
ALTER TABLE reports.report ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports.report FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='reports' AND tablename='report'
                AND policyname='report_tenant_iso') THEN
    DROP POLICY report_tenant_iso ON reports.report;
  END IF;
  CREATE POLICY report_tenant_iso ON reports.report
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
END $$;

-- ---- Permissions ------------------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('report.read',     'List and read generated reports',                 'tenant'),
  ('report.generate', 'Generate exec/investigation/field/sales reports', 'tenant'),
  ('report.export',   'Export a report (CSV/PDF download)',              'tenant')
ON CONFLICT (key) DO NOTHING;

-- Managers + leadership get the full read/generate/export set.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['report.read','report.generate','report.export']) k
   WHERE r.tenant_id IS NULL
     AND r.key IN ('tenant.admin','sales.manager','ops.manager','analytics.viewer')
ON CONFLICT DO NOTHING;

-- Sales agents may read + generate (their tenant-scoped pipeline reports).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['report.read','report.generate']) k
   WHERE r.tenant_id IS NULL AND r.key = 'sales.agent'
ON CONFLICT DO NOTHING;

-- Field technicians may read field reports.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, 'report.read' FROM iam.role r
   WHERE r.tenant_id IS NULL AND r.key = 'field.technician'
ON CONFLICT DO NOTHING;

-- platform.admin gets everything (incl. the report.* trio).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
     AND p.key IN ('report.read','report.generate','report.export')
ON CONFLICT DO NOTHING;

COMMIT;
