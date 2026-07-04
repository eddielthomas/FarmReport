-- =============================================================================
-- 211_farm_rbac_seed.sql — farm-domain RBAC catalog + role bundles.
-- -----------------------------------------------------------------------------
-- Mirrors 119/120: seeds farm permission keys into the platform-wide
-- iam.permission catalog and grants sensible bundles to existing system roles.
-- ON CONFLICT DO NOTHING everywhere → re-applies are no-ops.
--
-- Two key styles are seeded (both catalogued so either gate style resolves):
--   * dot-form (modern policy.mjs)   — farm.profile.read, farm.alert.manage, …
--   * colon-form legacy prefix gates — farm:view, farm:onboard, report:generate,
--     alert:manage, connector:manage, copilot:query (docs/01 §4).
--
-- New-user default (`farm:view`) is an application-layer concern (user_profile.
-- roles default) and is NOT changed here — the 001 default is intentionally left
-- untouched by this data-only seed.
-- =============================================================================

-- ---- 1) Permission catalog: dot-form (modern) ------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('farm.profile.read',    'Read farm profiles',                       'tenant'),
  ('farm.profile.write',   'Create/update farm profiles',              'tenant'),
  ('farm.zone.read',       'Read zones/parcels/assets',                'tenant'),
  ('farm.zone.write',      'Create/update zones/parcels/assets',       'tenant'),
  ('farm.scan.read',       'Read scans',                               'tenant'),
  ('farm.scan.request',    'Request a scan over a farm AOI',           'tenant'),
  ('farm.observation.read','Read observations',                        'tenant'),
  ('farm.alert.read',      'Read alerts',                              'tenant'),
  ('farm.alert.manage',    'Acknowledge/resolve/suppress alerts',      'tenant'),
  ('farm.report.read',     'Read reports',                             'tenant'),
  ('farm.report.generate', 'Generate/deliver reports',                 'tenant'),
  ('farm.connector.manage','Manage sensor connectors',                 'tenant'),
  ('farm.copilot.query',   'Query the onboarding/analysis copilot',    'tenant'),
  ('farm.portfolio.view',  'View buyer supply-chain portfolio rollups','tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2) Permission catalog: colon-form legacy prefix gates (docs/01 §4) -----
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('farm:view',        'Legacy prefix gate: view farm data',       'tenant'),
  ('farm:onboard',     'Legacy prefix gate: onboard a farm',       'tenant'),
  ('report:generate',  'Legacy prefix gate: generate reports',     'tenant'),
  ('alert:manage',     'Legacy prefix gate: manage alerts',        'tenant'),
  ('connector:manage', 'Legacy prefix gate: manage connectors',    'tenant'),
  ('copilot:query',    'Legacy prefix gate: query the copilot',    'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 3) Grant bundles to existing system roles -----------------------------
-- The 120 CROSS JOIN grants only ran at 120's apply time, so newly-added farm
-- keys must be explicitly granted here.

-- platform.admin: every farm permission (dot + colon).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
     AND (p.key LIKE 'farm.%' OR p.key IN
          ('farm:view','farm:onboard','report:generate','alert:manage',
           'connector:manage','copilot:query'))
ON CONFLICT DO NOTHING;

-- tenant.admin: every farm permission (dot + colon).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
     AND (p.key LIKE 'farm.%' OR p.key IN
          ('farm:view','farm:onboard','report:generate','alert:manage',
           'connector:manage','copilot:query'))
ON CONFLICT DO NOTHING;

-- analytics.viewer: read-only across the farm surface + portfolio.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'farm.profile.read','farm.zone.read','farm.scan.read',
           'farm.observation.read','farm.alert.read','farm.report.read',
           'farm.portfolio.view','farm:view'
         ]) k
   WHERE r.key = 'analytics.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- dashboard.viewer: the buyer portfolio view + basic farm read.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'farm.profile.read','farm.portfolio.view','farm:view'
         ]) k
   WHERE r.key = 'dashboard.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;
