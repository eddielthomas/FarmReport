-- =============================================================================
-- 301_farm_demo_tenants.sql — back the farm-reskinned tenant switcher with data.
-- -----------------------------------------------------------------------------
-- The QA sweep renamed the frontend demo tenants to farm slugs (demo-buyer,
-- acme-produce) and the in-app tenant switcher dev-logs-in as `admin@<slug>.local`.
-- This seed makes those references real so the switcher works:
--   • adds the `acme-produce` buyer tenant (Acme Produce Co.)
--   • adds `admin@<slug>.local` platform-admin accounts for both farm demo
--     tenants (the switcher's .local convention; the login picker uses .demo)
-- The RWR QA-fixture tenants (demoville-a / acme-water) are LEFT INTACT — the
-- qa:rls / smoke:rbac harness still references them. Idempotent.
-- =============================================================================

-- Second farm demo buyer tenant.
INSERT INTO iam.tenant (slug, display_name, plan)
VALUES ('acme-produce', 'Acme Produce Co.', 'pro')
ON CONFLICT (slug) DO NOTHING;

-- .local platform-admin accounts for the tenant switcher (demo-buyer created in 299).
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'admin@' || t.slug || '.local', 'Buyer Admin (' || t.display_name || ')',
       ARRAY['platform:admin','dashboard:view','farm:view','farm:onboard','report:generate','alert:manage']
  FROM iam.tenant t
 WHERE t.slug IN ('demo-buyer', 'acme-produce')
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles, display_name = EXCLUDED.display_name, status = 'active';
