// =============================================================================
// /api/v1/iam/invites — admin-gated invite token mint + list.
// -----------------------------------------------------------------------------
// Replaces the open self-serve /auth/register flow. An invite carries:
//   - tenant_id          (taken from caller's req.tenant)
//   - email              (must be invited)
//   - role_keys[]        (subset of platform's known roles)
//   - expires_at         (caller-controlled hours-from-now)
//   - token_hash         (sha256 of the plaintext we return ONCE at mint)
//
// Security model:
//   - admin-only at the router layer (requireRole platform:admin)
//   - plaintext token returned in the response body and NEVER stored
//   - consumption goes through atomic UPDATE … RETURNING * to gate races
//   - audit emit on every mint
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { q, withTenantConn } from '../db/pool.mjs';
import { readBody, ok, created, badReq } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

// Roles a tenant admin can grant via invite. platform:admin is reserved and
// must be elevated separately by an existing platform admin.
const ALLOWED_ROLES = new Set([
  'sales:manage',
  'ops:manage',
  'analytics:view',
  'dashboard:view',
  'customer:view',
  'vendor:view',
]);

const TOKEN_BYTES = 32; // 256-bit token

export function hashToken(plaintext) {
  return createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

function mintToken() {
  // URL-safe base64 (no padding) so it's easy to paste into curl/Postman.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

// POST /iam/invites { email, role_keys[], expires_in_hours }
export async function create(req, res) {
  const body = (await readBody(req).catch(() => null)) || {};
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return badReq(res, 'email_required');

  const requested = Array.isArray(body.role_keys) ? body.role_keys : [];
  const role_keys = requested
    .map((r) => String(r).trim())
    .filter((r) => ALLOWED_ROLES.has(r));
  if (role_keys.length === 0) return badReq(res, 'role_keys_required');

  const ttlHours = Math.max(1, Math.min(Number(body.expires_in_hours ?? 72), 24 * 30));
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const plaintext = mintToken();
  const token_hash = hashToken(plaintext);

  const row = await withTenantConn(req, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO iam.invite
         (tenant_id, email, role_keys, invited_by, expires_at, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, email, role_keys, invited_by, created_at, expires_at`,
      [req.tenant.id, email, role_keys, req.user?.sub ?? null, expiresAt, token_hash],
    );
    return rows[0];
  });

  recordAudit({
    req,
    action: 'create',
    resource: 'iam.invite',
    resourceId: row.id,
    payload: { after: { email, role_keys, expires_at: row.expires_at } },
  });

  // Plaintext is returned ONCE; we never store or log it.
  created(res, { ...row, token: plaintext });
}

// GET /iam/invites — list outstanding invites for the caller's tenant.
export async function list(req, res) {
  const rows = await withTenantConn(req, async (client) => {
    const r = await client.query(
      `SELECT id, tenant_id, email, role_keys, invited_by, created_at,
              expires_at, consumed_at
         FROM iam.invite
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 500`,
      [req.tenant.id],
    );
    return r.rows;
  });
  ok(res, rows);
}

// Helper exposed for /auth/register-with-invite.
// Returns the consumed row or null if the token is invalid / expired / used.
export async function consumeByPlaintext(plaintext) {
  const token_hash = hashToken(plaintext);
  // Single atomic step — RLS is intentionally not engaged here because the
  // caller (anonymous /auth/register-with-invite) has no tenant yet. We
  // protect against cross-tenant peeks by SELECTING nothing back beyond the
  // invite's own tenant_id, which is exactly the tenant we're enrolling into.
  const { rows } = await q(
    `UPDATE iam.invite
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, tenant_id, email, role_keys, expires_at`,
    [token_hash],
  );
  return rows[0] ?? null;
}
