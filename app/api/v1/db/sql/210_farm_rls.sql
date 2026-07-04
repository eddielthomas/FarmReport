-- =============================================================================
-- 210_farm_rls.sql — tenant-isolation RLS for EVERY farm.* table.
-- -----------------------------------------------------------------------------
-- Enables RLS + a pure tenant-iso policy on every farm table, following the
-- idempotent DO-block pattern in docs/03 §4.5 / 111_rls_iam.sql. Implemented as
-- a loop over the table list (same shape as 126_analytics_rollups) so the set is
-- maintained in one place; one `<table>_tenant_iso` policy is created per table.
--
-- GUC CHOICE (deviation from the docs/03 §4.5 sketch, which shows app.tenant_id):
-- the policies isolate on the CANONICAL `rwr.tenant_id` GUC established by
-- 162_guc_convergence. pool.mjs binds BOTH rwr.tenant_id and the legacy
-- app.tenant_id alias to the SAME value in the same batch (withTenantConn), so
-- runtime behavior is identical either way; rwr.tenant_id is the forward-canonical
-- name and is what scripts/qa-rls.mjs asserts pure-iso tables isolate on. See the
-- pool.mjs A4 header + ADR-0021.
--
-- Rollup relations in 207 are VIEWS, not tables — they inherit isolation from the
-- RLS on their base tables (invoker rights), so they need no policy of their own.
--
-- Cross-tenant admin (e.g. background ingest listing all gateway farms) uses the
-- ops-provisioned BYPASSRLS role, then binds the tenant GUC per per-farm upsert —
-- exactly the RWR ingest-alphageo.mjs pattern. Additive + idempotent.
-- =============================================================================

DO $$
DECLARE
  t   TEXT;
  pol TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'farm_profile','parcel','zone','asset','scan','observation',
      'derived_signal','alert','recommendation','report','action_feedback',
      'sensor_connector','imagery_scene',
      'sourcing_region','supplier',
      'risk_score','yield_at_risk','disruption_alert'
    ])
  LOOP
    EXECUTE format('ALTER TABLE farm.%I ENABLE ROW LEVEL SECURITY', t);
    pol := t || '_tenant_iso';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'farm' AND tablename = t AND policyname = pol
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON farm.%I '
        'USING (tenant_id = current_setting(''rwr.tenant_id'', true)::uuid) '
        'WITH CHECK (tenant_id = current_setting(''rwr.tenant_id'', true)::uuid)',
        pol, t);
    END IF;
  END LOOP;
END $$;
