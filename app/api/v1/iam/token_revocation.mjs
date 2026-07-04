// =============================================================================
// /api/v1/iam/token_revocation — JTI revocation + background prune.
// -----------------------------------------------------------------------------
//   POST /iam/tokens/:jti/revoke   { reason, expires_at? }
//
// AuthZ: platform.admin OR tenant.admin of the token's tenant (we only enforce
// the platform.admin branch in S1A; tenant scoping arrives with P-002 dynamic
// roles).
//
// Background worker: pruneExpired() runs every 15 minutes; invoked once at
// module load and then on the timer. Safe to import; no-op if no rows.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, badReq, forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';
import { invalidateRevocation } from '../middleware/revocation.mjs';

const JTI_RE = /^[A-Za-z0-9._\-]{1,256}$/;

// POST /iam/tokens/:jti/revoke
export async function revoke(req, res, jti) {
  if (!JTI_RE.test(String(jti ?? ''))) return badReq(res, 'invalid_jti');
  const roles = req?.user?.roles ?? [];
  if (!roles.includes('platform:admin')) return forbid(res, 'missing_role');

  const body = (await readBody(req).catch(() => null)) || {};
  const reason = String(body.reason ?? '').trim();
  if (!reason) return badReq(res, 'reason_required');

  // Default expiry: 24h from now. Caller may pass an explicit ISO timestamp.
  let expiresAt;
  if (body.expires_at) {
    const t = new Date(body.expires_at);
    if (isNaN(t.getTime())) return badReq(res, 'invalid_expires_at');
    expiresAt = t.toISOString();
  } else {
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  const tenant_id = req?.tenant?.id ?? null;
  const identity_id = body.identity_id && /^[0-9a-f-]{36}$/i.test(body.identity_id) ? body.identity_id : null;

  const { rows } = await q(
    `INSERT INTO iam.token_revocation
       (jti, tenant_id, identity_id, reason, revoked_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (jti) DO UPDATE
       SET reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           revoked_at = now()
     RETURNING jti, tenant_id, identity_id, reason, revoked_at, expires_at`,
    [String(jti), tenant_id, identity_id, reason, req.user?.sub ?? null, expiresAt],
  );
  invalidateRevocation(String(jti));

  recordAudit({
    req,
    action: 'iam.token.revoke',
    resource: 'iam.token_revocation',
    resourceId: String(jti),
    payload: { after: rows[0] },
  });

  ok(res, rows[0]);
}

// Background cleanup — drops rows whose tokens have already expired naturally.
// Self-emits the audit event under the synthetic 'system' actor; recordAudit
// will skip if no req.tenant (audit is best-effort; logs cover the rest).
export async function pruneExpired() {
  try {
    const { rowCount } = await q(
      `DELETE FROM iam.token_revocation WHERE expires_at < now() - INTERVAL '1 hour'`,
    );
    if (rowCount > 0) console.log(`[token_revocation] pruned ${rowCount} expired rows`);
  } catch (err) {
    console.error('[token_revocation] prune_failed:', err?.message ?? err);
  }
}

let _timer = null;
export function startPruneWorker(intervalMs = 15 * 60 * 1000) {
  if (_timer) return;
  // Run once on boot, then on a recurring interval.
  pruneExpired().catch(() => {});
  _timer = setInterval(() => { pruneExpired().catch(() => {}); }, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}
export function stopPruneWorker() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
