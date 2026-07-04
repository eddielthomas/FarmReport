-- =============================================================================
-- 124_iam_lifecycle_perms.sql — Sprint 2A permission seed.
-- -----------------------------------------------------------------------------
-- Catalogs the activity / revenue / vendor permissions used by /api/v1/crm/*.
-- Grants them to tenant.admin, sales.manager, and (where appropriate) sales.agent.
--
-- Idempotent (ON CONFLICT DO NOTHING).
-- =============================================================================

BEGIN;

-- ---- 1) Catalog new permissions --------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('crm.activity.read',  'Read CRM activity timeline',          'tenant'),
  ('crm.activity.write', 'Create manual CRM activity entries',  'tenant'),
  ('crm.revenue.read',   'Read revenue records',                'tenant'),
  ('crm.revenue.write',  'Create/transition revenue records',   'tenant'),
  ('crm.vendor.read',    'Read vendors',                        'tenant'),
  ('crm.vendor.write',   'Create/update vendors',               'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2a) Re-sweep platform.admin (ALL permissions) -------------------------
-- 120 seeded grants only against the catalog as it existed at that time. Any
-- new permission rows added in later migrations must re-trigger the sweep so
-- platform.admin keeps its blanket coverage invariant.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 2b) Re-sweep tenant.admin (everything except platform.*) --------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
     AND p.key NOT LIKE 'platform.%'
ON CONFLICT DO NOTHING;

-- ---- 3) Grant to sales.manager --------------------------------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.activity.read','crm.activity.write',
           'crm.revenue.read','crm.revenue.write',
           'crm.vendor.read','crm.vendor.write'
         ]) k
   WHERE r.key = 'sales.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) Grant to sales.agent (no revenue.write, no vendor.write) -----------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.activity.read','crm.activity.write',
           'crm.revenue.read',
           'crm.vendor.read'
         ]) k
   WHERE r.key = 'sales.agent' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
