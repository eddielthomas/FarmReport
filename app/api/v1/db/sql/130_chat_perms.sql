-- =============================================================================
-- 130_chat_perms.sql — EPIC-005 S3A chat permission catalog.
-- -----------------------------------------------------------------------------
-- Catalogs crm.chat.write + crm.chat.admin (crm.chat.read is already seeded
-- by 120_iam_rbac_seed.sql). Grants the chat triplet to tenant.admin,
-- sales.manager, sales.agent, ops.manager; re-sweeps platform.admin and
-- tenant.admin so every catalog perm is reachable from those roles.
--
-- Idempotent. ON CONFLICT DO NOTHING everywhere.
-- =============================================================================

BEGIN;

-- ---- 1) Catalog new permissions --------------------------------------------
INSERT INTO iam.permission (key, description, scope_kind) VALUES
  ('crm.chat.write', 'Post to chat conversations the caller is a member of', 'tenant'),
  ('crm.chat.admin', 'Manage every chat conversation in tenant (bypass membership)', 'tenant')
ON CONFLICT (key) DO NOTHING;

-- ---- 2a) Re-sweep platform.admin (all permissions) -------------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 2b) Re-sweep tenant.admin (every non-platform.*) ---------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, p.key
    FROM iam.role r CROSS JOIN iam.permission p
   WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
     AND p.key NOT LIKE 'platform.%'
ON CONFLICT DO NOTHING;

-- ---- 3) sales.manager (full chat read + write; no admin) -------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.chat.read',
           'crm.chat.write'
         ]) k
   WHERE r.key = 'sales.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 4) sales.agent (membership-gated; read + write) -----------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.chat.read',
           'crm.chat.write'
         ]) k
   WHERE r.key = 'sales.agent' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- ---- 5) ops.manager (case-conversation read + write) -----------------------
INSERT INTO iam.role_permission (role_id, permission_key)
  SELECT r.id, k FROM iam.role r,
         unnest(ARRAY[
           'crm.chat.read',
           'crm.chat.write'
         ]) k
   WHERE r.key = 'ops.manager' AND r.tenant_id IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
