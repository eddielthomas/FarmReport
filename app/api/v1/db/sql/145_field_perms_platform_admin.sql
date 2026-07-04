-- =============================================================================
-- 145_field_perms_platform_admin.sql — Sprint 9.1: ensure platform.admin owns
-- every field.* permission introduced by 144_field_perms.sql.
-- -----------------------------------------------------------------------------
-- The 120_iam_rbac_seed.sql CROSS JOIN ran BEFORE the 144 perms were added,
-- so the platform.admin role row never picked them up. This migration re-runs
-- the CROSS JOIN, restricted to perms keyed under field.*, and adds any
-- missing rows idempotently. Safe to re-apply.
--
-- Also re-applies the CROSS JOIN for tenant.admin (which also gets every
-- non-platform.* perm in the seed) so tenant admins inherit the new field
-- perms automatically.
-- =============================================================================

BEGIN;

-- Idempotent: backfill platform.admin with every field.* permission that
-- exists at apply time.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin'
     AND r.tenant_id IS NULL
     AND p.key LIKE 'field.%'
ON CONFLICT DO NOTHING;

-- Same backfill for tenant.admin.
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin'
     AND r.tenant_id IS NULL
     AND p.key LIKE 'field.%'
ON CONFLICT DO NOTHING;

COMMIT;
