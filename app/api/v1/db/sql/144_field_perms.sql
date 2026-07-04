-- =============================================================================
-- 144_field_perms.sql — Sprint 9A: field permissions + roles + tenant flags.
-- -----------------------------------------------------------------------------
-- Adds field.* permissions to iam.permission, the new system role
-- `field.technician`, and extends sales.agent + ops.manager with field perms
-- so existing agents/managers get the right field surface for free.
--
-- Tenant feature flag defaults:
--   field.geofence_strict_checkin = true   (hard reject check-in outside radius)
--   field.geofence_strict_upload  = false  (allow upload + flag gps_verified)
--
-- All inserts ON CONFLICT DO NOTHING — idempotent.
-- =============================================================================

BEGIN;

-- ---- 1) Permission catalog -------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('field.job.read',             'List/read field jobs in tenant',           'tenant'),
  ('field.job.write',            'Create / update field jobs',               'tenant'),
  ('field.job.assign',           'Assign or reassign field jobs',            'tenant'),
  ('field.location.write',       'Post own GPS position (technician)',       'tenant'),
  ('field.location.read.tenant', 'Read all technician positions in tenant',  'tenant'),
  ('field.checkin',              'Check in / out of a field job',            'tenant'),
  ('field.upload.write',         'Upload multimedia to a field job',         'tenant'),
  ('field.upload.read',          'Read uploads for a field job',             'tenant'),
  ('field.task.complete',        'Complete a sub-task on a field job',       'tenant'),
  ('field.task.manage',          'Create / delete sub-tasks on a field job', 'tenant'),
  ('field.geofence.read',        'Read geofence event log',                  'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2) System role: field.technician --------------------------------------
INSERT INTO iam.role (tenant_id, key, name, description, is_system) VALUES
  (NULL, 'field.technician', 'Field Technician',
   'Mobile technician. Posts own GPS, checks in/out, uploads multimedia.', true)
ON CONFLICT (key) WHERE tenant_id IS NULL DO NOTHING;

-- field.technician default grants.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'field.job.read',
           'field.location.write',
           'field.checkin',
           'field.upload.write',
           'field.upload.read',
           'field.task.complete',
           'crm.dashboard.view',
           'data.read.assigned'
         ]) k
   WHERE r.key = 'field.technician' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 3) Extend sales.agent (techs that double as agents) -------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'field.job.read',
           'field.location.write',
           'field.checkin',
           'field.upload.write',
           'field.upload.read',
           'field.task.complete'
         ]) k
   WHERE r.key = 'sales.agent' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) Extend ops.manager (manager panels embedded in ops dashboard) ------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'field.job.read',
           'field.job.write',
           'field.job.assign',
           'field.location.read.tenant',
           'field.upload.read',
           'field.task.manage',
           'field.geofence.read'
         ]) k
   WHERE r.key = 'ops.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 5) Extend sales.manager (manager panels embedded in sales/CRM) --------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'field.job.read',
           'field.job.write',
           'field.job.assign',
           'field.location.read.tenant',
           'field.upload.read',
           'field.task.manage',
           'field.geofence.read'
         ]) k
   WHERE r.key = 'sales.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 6) Tenant feature flag defaults (per-tenant, NULL row = default) ------
-- Use iam.tenant_feature_flag where any existing tenant has not opted in.
-- We seed defaults only for tenants that do not already have a row for the
-- key — agnostic to the JSONB column on iam.tenant.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM iam.tenant LOOP
    INSERT INTO iam.tenant_feature_flag (tenant_id, key, value, updated_by, updated_at)
      VALUES (t.id, 'field.geofence_strict_checkin', 'true'::jsonb, NULL, now())
    ON CONFLICT (tenant_id, key) DO NOTHING;
    INSERT INTO iam.tenant_feature_flag (tenant_id, key, value, updated_by, updated_at)
      VALUES (t.id, 'field.geofence_strict_upload', 'false'::jsonb, NULL, now())
    ON CONFLICT (tenant_id, key) DO NOTHING;
  END LOOP;
END $$;

COMMIT;
