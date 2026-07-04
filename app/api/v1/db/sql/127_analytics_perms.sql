-- =============================================================================
-- 127_analytics_perms.sql — EPIC-005 S2B analytics permission catalog.
-- -----------------------------------------------------------------------------
-- Catalogs the analytics permissions used by /api/v1/analytics/* and
-- /api/v1/billing/streams. Grants them to platform.admin (via re-sweep),
-- tenant.admin (via re-sweep), sales.manager, and analytics.viewer.
--
-- Idempotent (ON CONFLICT DO NOTHING).
-- =============================================================================

BEGIN;

-- ---- 1) Catalog permissions ------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('crm.analytics.view',         'Read dashboard analytics',              'tenant'),
  ('crm.analytics.revenue.view', 'Read revenue rollups + billing streams','tenant'),
  ('crm.analytics.export',       'Export analytics rollups',              'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2a) Re-sweep platform.admin (ALL permissions) -------------------------
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

-- ---- 3) Grant to sales.manager (full read incl. revenue + export) ----------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.analytics.view',
           'crm.analytics.revenue.view',
           'crm.analytics.export'
         ]) k
   WHERE r.key = 'sales.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) Grant to analytics.viewer (read-only, no export) -------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.analytics.view',
           'crm.analytics.revenue.view'
         ]) k
   WHERE r.key = 'analytics.viewer' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
