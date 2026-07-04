// =============================================================================
// /api/v1/tenants — platform-admin tenant CRUD.
// =============================================================================

import { q, withTx } from './db/pool.mjs';
import { invalidateTenantCache } from './middleware/tenant.mjs';
import { readBody, ok, created, badReq, notFound } from './http.mjs';
import { requireRole } from './middleware/auth.mjs';
import { recordAudit } from './audit.mjs';

const COLS = 'id, slug, display_name, status, plan, created_at, updated_at';

export async function listTenants(req, res) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const { rows } = await q(`SELECT ${COLS} FROM iam.tenant ORDER BY display_name`);
  ok(res, rows);
}

export async function createTenant(req, res) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const slug = String(body.slug ?? '').trim().toLowerCase();
  const display_name = String(body.display_name ?? '').trim();
  const plan = (body.plan ?? 'mvp').toString();
  if (!slug || !display_name) return badReq(res, 'slug_and_display_name_required');
  const { rows } = await q(
    `INSERT INTO iam.tenant (slug, display_name, plan)
     VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [slug, display_name, plan],
  );
  invalidateTenantCache();
  // Stamp the new tenant onto req so the audit row attributes correctly even
  // though the caller has not yet resolved into this tenant via the header.
  req.tenant = { id: rows[0].id, slug: rows[0].slug };
  recordAudit({
    req,
    action: 'create',
    resource: 'iam.tenant',
    resourceId: rows[0].id,
    payload: { after: rows[0] },
  });
  created(res, rows[0]);
}

export async function getTenant(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const { rows } = await q(`SELECT ${COLS} FROM iam.tenant WHERE id = $1`, [id]);
  if (rows.length === 0) return notFound(res);
  ok(res, rows[0]);
}

// Lists active user profiles for the caller's current tenant. Used by the
// Project Manager assignment dropdown — no platform:admin role required, just
// a valid bearer token + tenant header (X-Tenant-Id resolves req.tenant).
export async function listTenantUsers(req, res) {
  const { rows } = await q(
    `SELECT id, email, display_name, roles
       FROM iam.user_profile
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY display_name`,
    [req.tenant.id],
  );
  ok(res, rows);
}

export async function updateTenant(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const fields = [];
  const params = [id];
  let i = 2;
  const changing = [];
  for (const k of ['display_name','status','plan']) {
    if (body[k] !== undefined) {
      fields.push(`${k} = $${i++}`); params.push(body[k]); changing.push(k);
    }
  }
  if (fields.length === 0) return badReq(res, 'no_fields_to_update');

  // Snapshot the row pre-change so the audit payload is symmetric.
  const beforeRes = await q(`SELECT ${COLS} FROM iam.tenant WHERE id = $1`, [id]);
  const before = beforeRes.rows[0] ?? null;
  if (!before) return notFound(res);

  // Suspension flow — transitioning into 'suspended' requires a reason and
  // inserts an open row into iam.tenant_suspension. Resuming OUT of 'suspended'
  // closes the most recent open row (sets ended_at).
  const transitioningToSuspended =
    body.status === 'suspended' && before.status !== 'suspended';
  const transitioningFromSuspended =
    before.status === 'suspended' && body.status && body.status !== 'suspended';
  const reason = String(body.reason ?? '').trim();
  if (transitioningToSuspended && !reason) {
    return badReq(res, 'reason_required_for_suspension');
  }

  fields.push('updated_at = now()');

  const updated = await withTx(async (client) => {
    const upd = await client.query(
      `UPDATE iam.tenant SET ${fields.join(', ')} WHERE id = $1 RETURNING ${COLS}`,
      params,
    );
    if (upd.rows.length === 0) return null;

    if (transitioningToSuspended) {
      await client.query(
        `INSERT INTO iam.tenant_suspension (tenant_id, reason, suspended_by, notes)
           VALUES ($1, $2, $3, $4)`,
        [id, reason, req.user?.sub ?? null, body.notes ?? null],
      );
    }
    if (transitioningFromSuspended) {
      await client.query(
        `UPDATE iam.tenant_suspension
            SET ended_at = now(), ended_by = $2
          WHERE tenant_id = $1 AND ended_at IS NULL`,
        [id, req.user?.sub ?? null],
      );
    }
    return upd.rows[0];
  });

  if (!updated) return notFound(res);
  invalidateTenantCache();
  req.tenant = { id: updated.id, slug: updated.slug };

  recordAudit({
    req,
    action: transitioningToSuspended ? 'iam.tenant.suspend'
          : transitioningFromSuspended ? 'iam.tenant.resume'
          : 'update',
    resource: 'iam.tenant',
    resourceId: id,
    payload: {
      before,
      after: updated,
      fields: changing,
      reason: transitioningToSuspended ? reason : undefined,
    },
  });
  ok(res, updated);
}
