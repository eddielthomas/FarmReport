-- =============================================================================
-- 300_farm_demo_accounts.sql — dev-login demo accounts for the demo-buyer tenant
-- -----------------------------------------------------------------------------
-- The demo-buyer tenant (Demo Buyer Co) is created by 299_farm_seed_demo.sql,
-- which runs AFTER 100_demo_accounts.sql — so demo-buyer never received the
-- generic `<role>@<slug>.demo` login-picker accounts. This file seeds farm-
-- role demo accounts for it so /login.html can dev-login into the Report.Farm
-- surfaces:
--
--   admin@demo-buyer.demo  → platform:admin        (buyer admin — all surfaces)
--   buyer@demo-buyer.demo  → farm portfolio persona (portfolio + reports)
--   ops@demo-buyer.demo    → farm operations persona (onboarding + zones)
--   grower@demo-buyer.demo → grower persona         (own farms, read)
--
-- Roles use the canonical farm permission strings (211_farm_rbac_seed.sql) plus
-- the legacy prefix roles the middleware policy shim understands. Idempotent via
-- ON CONFLICT (tenant_id, email) DO UPDATE (mirrors 100_demo_accounts.sql).
-- Scoped to demo-buyer ONLY — does not touch other tenants.
-- =============================================================================

-- Buyer admin — full farm surface access.
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'admin@demo-buyer.demo', 'Demo Buyer Admin',
       ARRAY['platform:admin','dashboard:view',
             'farm:view','farm:onboard','report:generate','alert:manage']
FROM iam.tenant t WHERE t.slug = 'demo-buyer'
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles, display_name = EXCLUDED.display_name, status = 'active';

-- Buyer Success / portfolio persona — monitors the supplier portfolio, reads
-- reports, cannot edit farm boundaries.
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'buyer@demo-buyer.demo', 'Demo Buyer (Portfolio)',
       ARRAY['dashboard:view','farm:view','report:generate']
FROM iam.tenant t WHERE t.slug = 'demo-buyer'
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles, display_name = EXCLUDED.display_name, status = 'active';

-- Farm Operations persona — onboards farms, edits parcels/zones, manages alerts.
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'ops@demo-buyer.demo', 'Demo Farm Operations',
       ARRAY['ops:manage','dashboard:view','farm:view','farm:onboard','alert:manage']
FROM iam.tenant t WHERE t.slug = 'demo-buyer'
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles, display_name = EXCLUDED.display_name, status = 'active';

-- Grower persona — sees their own farms only (read).
INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
SELECT t.id, 'grower@demo-buyer.demo', 'Demo Grower',
       ARRAY['customer:view','farm:view']
FROM iam.tenant t WHERE t.slug = 'demo-buyer'
ON CONFLICT (tenant_id, email) DO UPDATE
  SET roles = EXCLUDED.roles, display_name = EXCLUDED.display_name, status = 'active';
