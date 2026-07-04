-- =============================================================================
-- 151_project_scene_perms.sql — Sprint 14A: project + scene RBAC catalog.
-- -----------------------------------------------------------------------------
-- Permissions:
--   crm.project.read   — list / read customer projects
--   crm.project.write  — create / update / archive customer projects
--   crm.scene.read     — list / read saved scenes under a project
--   crm.scene.write    — create / update / delete scenes; set-default
--
-- Grants:
--   platform.admin / tenant.admin    — all four (handled by CROSS JOIN below)
--   ops.manager / ops.coordinator    — all four
--   sales.manager / sales.agent      — all four
--   customer.viewer                  — read-only (project.read + scene.read);
--                                      handler scopes to caller's projects.
--
-- All inserts ON CONFLICT DO NOTHING — idempotent.
-- =============================================================================

BEGIN;

-- ---- 1) Permission catalog -------------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('crm.project.read',  'List/read customer projects',                 'tenant'),
  ('crm.project.write', 'Create/update/archive customer projects',     'tenant'),
  ('crm.scene.read',    'Read saved map scenes for a project',          'tenant'),
  ('crm.scene.write',   'Create/update/delete scenes; set default',     'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2) Ops + sales role grants (write tier) -------------------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.project.read','crm.project.write',
           'crm.scene.read','crm.scene.write'
         ]) k
   WHERE r.tenant_id IS NULL
     AND r.key IN ('ops.manager','ops.coordinator',
                   'sales.manager','sales.agent')
ON CONFLICT DO NOTHING;

-- ---- 3) customer.viewer (read tier) ----------------------------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY['crm.project.read','crm.scene.read']) k
   WHERE r.tenant_id IS NULL AND r.key = 'customer.viewer'
ON CONFLICT DO NOTHING;

-- ---- 4) Re-grant platform.admin / tenant.admin everything (incl. new perms)
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
