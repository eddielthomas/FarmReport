-- =============================================================================
-- 146_ops_role_hierarchy.sql — Sprint 9.1: split operations from field work.
-- -----------------------------------------------------------------------------
-- The user observed that S9A conflated `ops.manager` (who dispatches jobs but
-- shouldn't have to do field labour) with `field.technician` (the boots-on-
-- ground role). Operations is a multi-tier discipline; this migration encodes
-- it explicitly.
--
-- Role tree (system roles, tenant_id IS NULL):
--
--   ops.manager           — sees ALL ops, can dispatch, can also do field work
--                           (back-compat preserved; S9A perms unchanged).
--   ops.coordinator       — middle tier. Dispatches jobs, sees workload, but
--                           does NOT perform field work directly. NEW.
--   ops.field_specialist  — INTERNAL ops staff who do field work. Identical
--                           perm bundle to field.technician + cases.read for
--                           operational context. NEW.
--   field.technician      — EXTERNAL vendor/contractor tech (unchanged). Same
--                           field perm bundle without cases.read.
--
-- NEW permission:
--   ops.dispatch.field — symbolic marker permission; UI uses it to decide
--                        whether to render the FieldOpsPanel + dispatch
--                        controls. Held by ops.manager + ops.coordinator
--                        + (via platform.admin.all CROSS JOIN below).
--
-- Every INSERT uses ON CONFLICT DO NOTHING — idempotent.
-- =============================================================================

BEGIN;

-- ---- 1) New permission ---------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('ops.dispatch.field',  'Dispatch field jobs + render dispatch panels', 'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2) Two new system roles --------------------------------------------
INSERT INTO iam.role (tenant_id, key, name, description, is_system) VALUES
  (NULL, 'ops.coordinator',
   'Operations Coordinator',
   'Dispatches jobs to specialists; sees all team workload; does not do field work.',
   true),
  (NULL, 'ops.field_specialist',
   'Field Specialist (Internal)',
   'Internal ops staff doing on-site field work. Mirrors field.technician + cases.read.',
   true)
ON CONFLICT (key) WHERE tenant_id IS NULL DO NOTHING;

-- ---- 3) ops.coordinator grants ------------------------------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'cases.read', 'cases.manage',
           'crm.lead.read', 'crm.contact.read',
           'crm.dashboard.view',
           'data.read.global',
           'field.job.read',
           'field.job.write',
           'field.job.assign',
           'field.location.read.tenant',
           'field.upload.read',
           'field.task.manage',
           'field.geofence.read',
           'ops.dispatch.field',
           'iam.users.read', 'iam.teams.read'
         ]) k
   WHERE r.key = 'ops.coordinator' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) ops.field_specialist grants -------------------------------------
-- Same field bundle as field.technician + cases.read so the specialist sees
-- the case that spawned the job. No ops.dispatch.field (specialists do work,
-- they do not dispatch it).
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'field.job.read',
           'field.location.write',
           'field.checkin',
           'field.upload.write',
           'field.upload.read',
           'field.task.complete',
           'cases.read',
           'crm.dashboard.view',
           'data.read.assigned'
         ]) k
   WHERE r.key = 'ops.field_specialist' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 5) Extend ops.manager with the new dispatch perm ---------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, 'ops.dispatch.field' FROM iam.role r
   WHERE r.key = 'ops.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 6) Re-grant platform.admin / tenant.admin everything (incl. new perm)
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
     AND p.key NOT LIKE 'platform.%'
ON CONFLICT DO NOTHING;

COMMIT;
