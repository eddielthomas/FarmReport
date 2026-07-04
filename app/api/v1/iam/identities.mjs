// =============================================================================
// /api/v1/iam/identities — global identity + membership administration.
// -----------------------------------------------------------------------------
// All endpoints are platform.admin-only (router enforces). Identities are
// cross-tenant; memberships are per-tenant grants. Mutations emit audit rows.
//
//   GET    /iam/identities                              list (filter by email/status)
//   POST   /iam/identities                              create
//   GET    /iam/identities/:id/memberships              list memberships
//   POST   /iam/identities/:id/memberships              upsert membership
//   DELETE /iam/identities/:id/memberships/:tenantId    revoke (soft)
//
// Cross-tenant tables (iam.identity, iam.tenant_membership lookups across
// tenants) are queried via the platform pool (no RLS context) — handlers are
// gated at the router by requireRole('platform:admin').
// =============================================================================

import { q, withTx } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const IDENTITY_COLS =
  'id, email, display_name, status, subject_provider, subject_id, mfa_required, last_login_at, created_at, updated_at';

// GET /iam/identities ?email=&status=&limit=&offset=
export async function list(req, res) {
  const url = new URL(req.url, 'http://x');
  const email  = url.searchParams.get('email');
  const status = url.searchParams.get('status');
  const limit  = Math.max(1, Math.min(Number(url.searchParams.get('limit')  ?? 100), 500));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

  const where = ['deleted_at IS NULL'];
  const params = [];
  if (email)  { params.push(email.toLowerCase());  where.push(`email = $${params.length}`); }
  if (status) { params.push(status);               where.push(`status = $${params.length}`); }
  params.push(limit);  const limIdx = params.length;
  params.push(offset); const offIdx = params.length;

  const { rows } = await q(
    `SELECT ${IDENTITY_COLS} FROM iam.identity
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );
  ok(res, rows);
}

// POST /iam/identities { email, display_name, subject_provider?, subject_id?, mfa_required? }
export async function create(req, res) {
  const body = (await readBody(req).catch(() => null)) || {};
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return badReq(res, 'email_required');
  const display_name = String(body.display_name ?? email.split('@')[0]).trim();
  const subject_provider = body.subject_provider ? String(body.subject_provider) : null;
  const subject_id       = body.subject_id       ? String(body.subject_id)       : null;
  const mfa_required     = Boolean(body.mfa_required);

  const { rows } = await q(
    `INSERT INTO iam.identity
       (email, display_name, status, subject_provider, subject_id, mfa_required)
     VALUES ($1, $2, 'disabled', $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING ${IDENTITY_COLS}`,
    [email, display_name, subject_provider, subject_id, mfa_required],
  );
  const row = rows[0];

  // Platform-level audit — tenant_id is NULL on this row's audit event, so we
  // stamp the caller's req.tenant if any was resolved; otherwise the audit
  // helper no-ops (safe: identity admin is a platform-scoped concern).
  recordAudit({
    req,
    action: 'iam.identity.create',
    resource: 'iam.identity',
    resourceId: row.id,
    payload: { after: { email, subject_provider, subject_id, mfa_required } },
  });
  created(res, row);
}

// GET /iam/identities/:id/memberships
export async function listMemberships(req, res, identityId) {
  if (!UUID_RE.test(identityId)) return badReq(res, 'invalid_identity_id');
  const { rows: idRows } = await q(
    `SELECT id, email, display_name, status FROM iam.identity WHERE id = $1`,
    [identityId],
  );
  if (idRows.length === 0) return notFound(res, 'identity_not_found');

  const { rows } = await q(
    `SELECT m.id, m.identity_id, m.tenant_id, m.user_id, m.roles, m.status,
            m.invited_by, m.invited_at, m.joined_at, m.revoked_at,
            t.slug AS tenant_slug, t.display_name AS tenant_display_name
       FROM iam.tenant_membership m
       JOIN iam.tenant t ON t.id = m.tenant_id
      WHERE m.identity_id = $1
      ORDER BY m.invited_at DESC`,
    [identityId],
  );
  ok(res, { identity: idRows[0], memberships: rows });
}

// POST /iam/identities/:id/memberships { tenant_id, roles[], status? }
export async function createMembership(req, res, identityId) {
  if (!UUID_RE.test(identityId)) return badReq(res, 'invalid_identity_id');
  const body = (await readBody(req).catch(() => null)) || {};
  const tenant_id = String(body.tenant_id ?? '').trim();
  if (!UUID_RE.test(tenant_id)) return badReq(res, 'tenant_id_required');
  const roles = Array.isArray(body.roles) ? body.roles.map((r) => String(r)) : [];
  if (roles.length === 0) return badReq(res, 'roles_required');
  const status = ['active','suspended','revoked'].includes(body.status) ? body.status : 'active';

  const result = await withTx(async (client) => {
    const before = await client.query(
      `SELECT id, roles, status FROM iam.tenant_membership
        WHERE identity_id = $1 AND tenant_id = $2 LIMIT 1`,
      [identityId, tenant_id],
    );
    const { rows } = await client.query(
      `INSERT INTO iam.tenant_membership
         (identity_id, tenant_id, roles, status, invited_by, joined_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'active' THEN now() ELSE NULL END)
       ON CONFLICT (identity_id, tenant_id) DO UPDATE
         SET roles  = EXCLUDED.roles,
             status = EXCLUDED.status,
             joined_at = COALESCE(iam.tenant_membership.joined_at,
                                  CASE WHEN EXCLUDED.status = 'active' THEN now() ELSE NULL END),
             revoked_at = CASE WHEN EXCLUDED.status = 'revoked' THEN now() ELSE NULL END
       RETURNING id, identity_id, tenant_id, roles, status, invited_at, joined_at, revoked_at`,
      [identityId, tenant_id, roles, status, req.user?.sub ?? null],
    );
    return { before: before.rows[0] ?? null, after: rows[0] };
  });

  // Attribute the audit to the target tenant.
  req.tenant = req.tenant ?? { id: tenant_id };
  recordAudit({
    req,
    action: 'iam.membership.create',
    resource: 'iam.tenant_membership',
    resourceId: result.after.id,
    payload: { before: result.before, after: result.after },
  });
  created(res, result.after);
}

// DELETE /iam/identities/:id/memberships/:tenantId
export async function revokeMembership(req, res, identityId, tenantId) {
  if (!UUID_RE.test(identityId) || !UUID_RE.test(tenantId)) return badReq(res, 'invalid_ids');

  const result = await withTx(async (client) => {
    const before = await client.query(
      `SELECT id, status, roles FROM iam.tenant_membership
        WHERE identity_id = $1 AND tenant_id = $2 LIMIT 1`,
      [identityId, tenantId],
    );
    if (before.rows.length === 0) return null;
    const { rows } = await client.query(
      `UPDATE iam.tenant_membership
          SET status = 'revoked', revoked_at = now()
        WHERE identity_id = $1 AND tenant_id = $2
        RETURNING id, identity_id, tenant_id, status, revoked_at`,
      [identityId, tenantId],
    );
    return { before: before.rows[0], after: rows[0] };
  });

  if (!result) return notFound(res, 'membership_not_found');

  req.tenant = req.tenant ?? { id: tenantId };
  recordAudit({
    req,
    action: 'iam.membership.revoke',
    resource: 'iam.tenant_membership',
    resourceId: result.after.id,
    payload: { before: result.before, after: result.after },
  });
  ok(res, result.after);
}
