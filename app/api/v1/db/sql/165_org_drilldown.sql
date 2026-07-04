-- =============================================================================
-- 165_org_drilldown.sql — Sprint A5.3 (ADR-0024): entitled cross-district
-- drill-down — demo grant seed.
-- -----------------------------------------------------------------------------
-- The drill-down feature itself is code (api/v1/org/drilldown.mjs). The table it
-- reads — iam.org_scope_grant — already exists from A5.1 (migration 163), and the
-- org.drilldown permission is already catalogued + bundled to state.admin /
-- state.auditor there. This migration only SEEDS a demo entitlement so the
-- feature is demoable out of the box: it grants the demo org admin
-- (admin@demoville-a.local, who holds state.admin on lone-star-water) the right
-- to drill into BOTH demo districts.
--
-- Cross-district drill-down is an EXPLICIT, AUDITED capability — never an
-- isolation bypass. The grant is the entitlement; the read path runs one
-- RLS-scoped query per granted district and writes an iam.audit_event per access.
--
-- Idempotent + guarded (no-ops when the org / user / tenants are absent).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_org_id   UUID;
  v_dv_id    UUID;
  v_acme_id  UUID;
  v_admin_id UUID;
BEGIN
  SELECT id INTO v_org_id   FROM iam.org    WHERE slug = 'lone-star-water';
  SELECT id INTO v_dv_id    FROM iam.tenant WHERE slug = 'demoville-a';
  SELECT id INTO v_acme_id  FROM iam.tenant WHERE slug = 'acme-water';

  IF v_org_id IS NULL THEN
    RAISE NOTICE '[165] demo org absent; skipping drill-down grant seed.';
    RETURN;
  END IF;

  -- The org admin (state.admin), resolved to their demoville-a profile id.
  SELECT id INTO v_admin_id
    FROM iam.user_profile
   WHERE email = 'admin@demoville-a.local' AND tenant_id = v_dv_id
   LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE NOTICE '[165] demo admin absent; skipping drill-down grant seed.';
    RETURN;
  END IF;

  -- Grant drill-down into each demo district (idempotent on the natural key).
  IF v_dv_id IS NOT NULL THEN
    INSERT INTO iam.org_scope_grant (org_id, user_ref, tenant_id, classification_ceiling)
    SELECT v_org_id, v_admin_id, v_dv_id, 'internal'
     WHERE NOT EXISTS (
       SELECT 1 FROM iam.org_scope_grant
        WHERE org_id = v_org_id AND user_ref = v_admin_id AND tenant_id = v_dv_id);
  END IF;
  IF v_acme_id IS NOT NULL THEN
    INSERT INTO iam.org_scope_grant (org_id, user_ref, tenant_id, classification_ceiling)
    SELECT v_org_id, v_admin_id, v_acme_id, 'internal'
     WHERE NOT EXISTS (
       SELECT 1 FROM iam.org_scope_grant
        WHERE org_id = v_org_id AND user_ref = v_admin_id AND tenant_id = v_acme_id);
  END IF;

  RAISE NOTICE '[165] drill-down demo grants seeded (org=%, admin=%, demoville=%, acme=%).',
    v_org_id, v_admin_id, v_dv_id, v_acme_id;
END $$;

COMMIT;
