-- =============================================================================
-- 006_demo_accounts.sql — normalized demo accounts per tenant
-- -----------------------------------------------------------------------------
-- Idempotent: 5 demo accounts per tenant covering each role perspective.
--   admin@<slug>.demo     → platform:admin    (all-surfaces)
--   sales@<slug>.demo     → sales:manage      (pipeline + analytics)
--   ops@<slug>.demo       → ops:manage        (operations + pm)
--   analyst@<slug>.demo   → analytics:view    (analytics only)
--   customer@<slug>.demo  → customer:view     (customer portal)
-- Used by the /login.html demo picker.
-- =============================================================================

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'admin@'    || t.slug || '.demo', 'Demo Admin',    ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view']
FROM iam.tenant t
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles,
      display_name = EXCLUDED.display_name,
      status = 'active';

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'sales@'    || t.slug || '.demo', 'Demo Sales',    ARRAY['sales:manage','dashboard:view']
FROM iam.tenant t
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles,
      display_name = EXCLUDED.display_name,
      status = 'active';

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'ops@'      || t.slug || '.demo', 'Demo Operations', ARRAY['ops:manage','dashboard:view']
FROM iam.tenant t
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles,
      display_name = EXCLUDED.display_name,
      status = 'active';

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'analyst@'  || t.slug || '.demo', 'Demo Analyst',  ARRAY['analytics:view','dashboard:view']
FROM iam.tenant t
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles,
      display_name = EXCLUDED.display_name,
      status = 'active';

INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'customer@' || t.slug || '.demo', 'Demo Customer', ARRAY['customer:view']
FROM iam.tenant t
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles,
      display_name = EXCLUDED.display_name,
      status = 'active';

-- Corrective sweep: earlier runs of this file granted sales@*.demo the
-- analytics:view role, which leaks cross-functional dashboards. Re-running
-- this migration converges existing rows to the trimmed role set.
UPDATE iam.user_profile
   SET roles = ARRAY['sales:manage','dashboard:view']
 WHERE email LIKE 'sales@%.demo';
