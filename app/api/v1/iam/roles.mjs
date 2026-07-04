// =============================================================================
// /api/v1/iam/roles — role + role-permission + user-role CRUD (Sprint 1B).
// -----------------------------------------------------------------------------
// Endpoints (all require AuthN + tenant):
//   GET    /iam/roles                       → list (system + tenant-custom)
//   GET    /iam/roles/:id                   → detail incl. permissions[]
//   POST   /iam/roles                       → create tenant-custom role
//   PATCH  /iam/roles/:id                   → rename / change parent
//   DELETE /iam/roles/:id                   → delete (refuse if is_system)
//   POST   /iam/roles/:id/permissions       → { add:[..], remove:[..] }
//   GET    /iam/users/:id/roles             → resolved roles + expiry
//   POST   /iam/users/:id/roles             → { role_id, expires_at? }
//   DELETE /iam/users/:id/roles/:roleId     → revoke
//
// Gates:
//   - reads      → iam.roles.read
//   - mutations  → iam.roles.manage     (user-role grants → iam.users.manage)
//
// Every mutating handler emits recordAudit() with { before, after } shape.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { ok, created, badReq, notFound, readBody, send } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { requirePermission } from '../middleware/policy.mjs';
import { invalidatePermissions } from '../middleware/policy.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- list ------------------------------------------------------------------
export async function list(req, res) {
  if (!requirePermission(req, res, 'iam.roles.read')) return;
  const { rows } = await q(
    `SELECT r.id, r.tenant_id, r.key, r.name, r.description, r.is_system,
            r.parent_role_id, r.created_at, r.updated_at
       FROM iam.role r
      WHERE r.tenant_id IS NULL OR r.tenant_id = $1
      ORDER BY r.is_system DESC, r.key`,
    [req.tenant.id],
  );
  ok(res, rows);
}

// ---- detail ----------------------------------------------------------------
export async function detail(req, res, id) {
  if (!requirePermission(req, res, 'iam.roles.read')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_role_id');
  const { rows } = await q(
    `SELECT r.id, r.tenant_id, r.key, r.name, r.description, r.is_system,
            r.parent_role_id, r.created_at, r.updated_at,
            COALESCE(
              (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                 FROM iam.role_permission rp
                WHERE rp.role_id = r.id),
              ARRAY[]::TEXT[]
            ) AS permissions
       FROM iam.role r
      WHERE r.id = $1
        AND (r.tenant_id IS NULL OR r.tenant_id = $2)
      LIMIT 1`,
    [id, req.tenant.id],
  );
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

// ---- create ----------------------------------------------------------------
export async function create(req, res) {
  if (!requirePermission(req, res, 'iam.roles.manage')) return;
  const body = (await readBody(req)) || {};
  const key  = String(body.key  ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!key || !name) return badReq(res, 'key_and_name_required');
  const perms = Array.isArray(body.permissions) ? body.permissions : [];
  const parent = body.parent_role_id ?? null;
  if (parent && !UUID_RE.test(parent)) return badReq(res, 'invalid_parent_role_id');

  // System roles use tenant_id IS NULL — clients cannot mint them.
  const result = await withTx(async (client) => {
    const ins = await client.query(
      `INSERT INTO iam.role (tenant_id, key, name, description, is_system, parent_role_id)
       VALUES ($1, $2, $3, $4, false, $5)
       RETURNING id, tenant_id, key, name, description, is_system, parent_role_id`,
      [req.tenant.id, key, name, body.description ?? null, parent],
    );
    const role = ins.rows[0];
    if (perms.length > 0) {
      const values = perms.map((_p, i) => `($1, $${i + 2})`).join(',');
      await client.query(
        `INSERT INTO iam.role_permission (role_id, permission_key)
         VALUES ${values} ON CONFLICT DO NOTHING`,
        [role.id, ...perms],
      );
    }
    return role;
  });
  recordAudit({
    req,
    action: 'iam.role.create',
    resource: 'iam.role',
    resourceId: result.id,
    payload: { after: { key, name, permissions: perms } },
  });
  created(res, result);
}

// ---- update ----------------------------------------------------------------
export async function update(req, res, id) {
  if (!requirePermission(req, res, 'iam.roles.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_role_id');
  const body = (await readBody(req)) || {};
  const cur = await q(
    `SELECT id, name, description, parent_role_id, is_system, tenant_id
       FROM iam.role WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (cur.rows.length === 0) return notFound(res);
  if (cur.rows[0].is_system) return badReq(res, 'system_role_immutable');
  if (cur.rows[0].tenant_id !== req.tenant.id) return notFound(res);

  const fields = [];
  const params = [id];
  let i = 2;
  for (const k of ['name','description','parent_role_id']) {
    if (body[k] !== undefined) { fields.push(`${k} = $${i++}`); params.push(body[k]); }
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');
  fields.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE iam.role SET ${fields.join(', ')}
      WHERE id = $1
      RETURNING id, tenant_id, key, name, description, is_system, parent_role_id`,
    params,
  );
  recordAudit({
    req,
    action: 'iam.role.update',
    resource: 'iam.role',
    resourceId: id,
    payload: { before: cur.rows[0], after: rows[0] },
  });
  ok(res, rows[0]);
}

// ---- delete ----------------------------------------------------------------
export async function remove(req, res, id) {
  if (!requirePermission(req, res, 'iam.roles.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_role_id');
  const cur = await q(
    `SELECT id, tenant_id, key, is_system FROM iam.role WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (cur.rows.length === 0) return notFound(res);
  if (cur.rows[0].is_system)              return badReq(res, 'system_role_immutable');
  if (cur.rows[0].tenant_id !== req.tenant.id) return notFound(res);
  const inUse = await q(
    `SELECT count(*)::int AS n FROM iam.user_role WHERE role_id = $1`,
    [id],
  );
  if (inUse.rows[0].n > 0) return badReq(res, 'role_in_use');
  await q(`DELETE FROM iam.role WHERE id = $1`, [id]);
  recordAudit({
    req,
    action: 'iam.role.delete',
    resource: 'iam.role',
    resourceId: id,
    payload: { before: cur.rows[0] },
  });
  ok(res, { id });
}

// ---- toggle permissions ----------------------------------------------------
export async function setPermissions(req, res, id) {
  if (!requirePermission(req, res, 'iam.roles.manage')) return;
  if (!UUID_RE.test(id)) return badReq(res, 'invalid_role_id');
  const body = (await readBody(req)) || {};
  const add    = Array.isArray(body.add)    ? body.add    : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];
  if (add.length === 0 && remove.length === 0) return badReq(res, 'nothing_to_change');

  const role = await q(
    `SELECT id, key, tenant_id, is_system FROM iam.role WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (role.rows.length === 0) return notFound(res);
  if (role.rows[0].is_system) return badReq(res, 'system_role_immutable');
  if (role.rows[0].tenant_id !== req.tenant.id) return notFound(res);

  const before = await q(
    `SELECT permission_key FROM iam.role_permission WHERE role_id = $1`,
    [id],
  );
  await withTx(async (client) => {
    if (add.length) {
      const values = add.map((_p, i) => `($1, $${i + 2})`).join(',');
      await client.query(
        `INSERT INTO iam.role_permission (role_id, permission_key)
         VALUES ${values} ON CONFLICT DO NOTHING`,
        [id, ...add],
      );
    }
    if (remove.length) {
      await client.query(
        `DELETE FROM iam.role_permission
          WHERE role_id = $1 AND permission_key = ANY($2::TEXT[])`,
        [id, remove],
      );
    }
  });
  const after = await q(
    `SELECT permission_key FROM iam.role_permission WHERE role_id = $1`,
    [id],
  );
  recordAudit({
    req,
    action: 'iam.role.permission.update',
    resource: 'iam.role',
    resourceId: id,
    payload: {
      before: before.rows.map((r) => r.permission_key),
      after:  after.rows.map((r) => r.permission_key),
      added: add, removed: remove,
    },
  });
  ok(res, { id, permissions: after.rows.map((r) => r.permission_key) });
}

// ---- list user's roles -----------------------------------------------------
export async function listUserRoles(req, res, userId) {
  if (!requirePermission(req, res, 'iam.users.read')) return;
  if (!UUID_RE.test(userId)) return badReq(res, 'invalid_user_id');
  const { rows } = await q(
    `SELECT ur.user_id, ur.role_id, r.key, r.name, ur.granted_at, ur.expires_at
       FROM iam.user_role ur
       JOIN iam.role r ON r.id = ur.role_id
       JOIN iam.user_profile up ON up.id = ur.user_id
      WHERE ur.user_id = $1 AND up.tenant_id = $2
      ORDER BY r.key`,
    [userId, req.tenant.id],
  );
  ok(res, rows);
}

// ---- grant role to user ----------------------------------------------------
export async function grantUserRole(req, res, userId) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(userId)) return badReq(res, 'invalid_user_id');
  const body = (await readBody(req)) || {};
  const roleId = String(body.role_id ?? '').trim();
  if (!UUID_RE.test(roleId)) return badReq(res, 'invalid_role_id');
  const expires = body.expires_at ?? null;

  // Tenant scoping: user_profile + role must both belong to this tenant
  // (or the role is system / tenant_id IS NULL).
  const guard = await q(
    `SELECT up.id AS user_ok,
            r.id  AS role_ok
       FROM iam.user_profile up,
            iam.role r
      WHERE up.id = $1 AND up.tenant_id = $2
        AND r.id  = $3 AND (r.tenant_id IS NULL OR r.tenant_id = $2)
      LIMIT 1`,
    [userId, req.tenant.id, roleId],
  );
  if (guard.rows.length === 0) return notFound(res);

  await q(
    `INSERT INTO iam.user_role (user_id, role_id, granted_by, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, role_id) DO UPDATE
       SET expires_at = EXCLUDED.expires_at,
           granted_at = now()`,
    [userId, roleId, req.user?.sub ?? null, expires],
  );
  invalidatePermissions(userId);
  recordAudit({
    req,
    action: 'iam.user.role.grant',
    resource: 'iam.user_role',
    resourceId: userId,
    payload: { after: { role_id: roleId, expires_at: expires } },
  });
  ok(res, { user_id: userId, role_id: roleId, expires_at: expires });
}

// ---- revoke role from user -------------------------------------------------
export async function revokeUserRole(req, res, userId, roleId) {
  if (!requirePermission(req, res, 'iam.users.manage')) return;
  if (!UUID_RE.test(userId) || !UUID_RE.test(roleId)) {
    return badReq(res, 'invalid_id');
  }
  const guard = await q(
    `SELECT 1 FROM iam.user_profile WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [userId, req.tenant.id],
  );
  if (guard.rows.length === 0) return notFound(res);
  const { rowCount } = await q(
    `DELETE FROM iam.user_role WHERE user_id = $1 AND role_id = $2`,
    [userId, roleId],
  );
  if (rowCount === 0) return notFound(res);
  invalidatePermissions(userId);
  recordAudit({
    req,
    action: 'iam.user.role.revoke',
    resource: 'iam.user_role',
    resourceId: userId,
    payload: { before: { role_id: roleId } },
  });
  ok(res, { user_id: userId, role_id: roleId });
}
