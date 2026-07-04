// =============================================================================
// /api/v1/iam/teams — tenant-scoped team CRUD + memberships.
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, noContent } from '../http.mjs';
import { requireRole } from '../middleware/auth.mjs';
import { recordAudit } from '../audit.mjs';

const TEAM_COLS = 'id, tenant_id, slug, name, description, created_at, updated_at';

function slugify(s) {
  return String(s ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function list(req, res) {
  const { rows } = await q(
    `SELECT t.id, t.tenant_id, t.slug, t.name, t.description, t.created_at, t.updated_at,
            COALESCE(json_agg(json_build_object(
              'user_id', u.id, 'email', u.email, 'display_name', u.display_name,
              'role', tm.role, 'joined_at', tm.joined_at
            )) FILTER (WHERE u.id IS NOT NULL), '[]'::json) AS members
       FROM iam.team t
       LEFT JOIN iam.team_member tm ON tm.team_id = t.id
       LEFT JOIN iam.user_profile u ON u.id = tm.user_id AND u.status = 'active'
      WHERE t.tenant_id = $1
      GROUP BY t.id
      ORDER BY t.name`,
    [req.tenant.id],
  );
  ok(res, rows);
}

export async function create(req, res) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const name = String(body.name ?? '').trim();
  if (!name) return badReq(res, 'name_required');
  const slug = slugify(body.slug ?? name);
  const description = body.description ? String(body.description) : null;
  const { rows } = await q(
    `INSERT INTO iam.team (tenant_id, slug, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING ${TEAM_COLS}`,
    [req.tenant.id, slug, name, description],
  );
  recordAudit({ req, action: 'create', resource: 'iam.team', resourceId: rows[0].id, payload: { slug, name } });
  created(res, rows[0]);
}

export async function update(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const sets = [];
  const params = [id, req.tenant.id];
  let i = 3;
  if (body.name !== undefined)        { sets.push(`name = $${i++}`);        params.push(String(body.name)); }
  if (body.description !== undefined) { sets.push(`description = $${i++}`); params.push(body.description == null ? null : String(body.description)); }
  if (sets.length === 0) return badReq(res, 'no_fields_to_update');
  sets.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE iam.team SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2 RETURNING ${TEAM_COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'update', resource: 'iam.team', resourceId: id });
  ok(res, rows[0]);
}

export async function remove(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const { rows } = await q(
    `DELETE FROM iam.team WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, req.tenant.id],
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'delete', resource: 'iam.team', resourceId: id });
  noContent(res);
}

export async function listMembers(req, res, teamId) {
  // Ensure the team belongs to the caller's tenant before exposing roster.
  const guard = await q(
    `SELECT 1 FROM iam.team WHERE id = $1 AND tenant_id = $2`,
    [teamId, req.tenant.id],
  );
  if (guard.rows.length === 0) return notFound(res);
  const { rows } = await q(
    `SELECT u.id AS user_id, u.email, u.display_name, tm.role, tm.joined_at
       FROM iam.team_member tm
       JOIN iam.user_profile u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.tenant_id = $2 AND u.status = 'active'
      ORDER BY u.display_name`,
    [teamId, req.tenant.id],
  );
  ok(res, rows);
}

export async function addMember(req, res, teamId) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const userId = String(body.user_id ?? '').trim();
  const role   = String(body.role ?? 'member');
  if (!userId) return badReq(res, 'user_id_required');
  return withTx(async (client) => {
    // Ensure team + user both belong to this tenant.
    const guard = await client.query(
      `SELECT 1 FROM iam.team t, iam.user_profile u
        WHERE t.id = $1 AND t.tenant_id = $3
          AND u.id = $2 AND u.tenant_id = $3`,
      [teamId, userId, req.tenant.id],
    );
    if (guard.rows.length === 0) return notFound(res);
    const { rows } = await client.query(
      `INSERT INTO iam.team_member (tenant_id, team_id, user_id, role)
       VALUES ($3, $1, $2, $4)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, team_id, user_id, role, joined_at`,
      [teamId, userId, req.tenant.id, role],
    );
    recordAudit({ req, action: 'add_member', resource: 'iam.team', resourceId: teamId, payload: { user_id: userId, role } });
    created(res, rows[0]);
  });
}

export async function removeMember(req, res, teamId, userId) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const { rows } = await q(
    `DELETE FROM iam.team_member
      WHERE team_id = $1 AND user_id = $2 AND tenant_id = $3
      RETURNING id`,
    [teamId, userId, req.tenant.id],
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'remove_member', resource: 'iam.team', resourceId: teamId, payload: { user_id: userId } });
  noContent(res);
}
