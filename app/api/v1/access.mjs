// =============================================================================
// /api/v1/access — Sprint 10B pilot access-code verification.
// -----------------------------------------------------------------------------
// POST /api/v1/access/verify { code }
//   - hashes the plaintext with sha256
//   - looks up an active row in iam.access_code (not revoked, not expired,
//     not at max_uses)
//   - on hit: atomically increments current_uses, mints a 1h pass token,
//             sets the rwr.access_pass cookie, returns { pass_token, expires_at }
//   - on miss: returns 401 invalid_code
//
// Audit:
//   Successes are written to iam.audit_event with action='access.verify.success'
//   and the matched access_code's tenant_id. Failures cannot attribute to a
//   tenant (the input is invalid by definition) so they are written to stderr
//   via console.warn with a structured prefix — the platform operator pulls
//   them out of the journal. This is deliberately the SAME tradeoff the
//   contact.mjs pre-tenant flow makes.
//
// Atomic increment guards against races: the UPDATE … WHERE current_uses <
// COALESCE(max_uses, 2^31) RETURNING * fails if the row already hit its cap,
// in which case we treat the attempt as a miss (capped codes are dead codes).
// =============================================================================

import { createHash } from 'node:crypto';
import { q } from './db/pool.mjs';
import { readBody, send, ok } from './http.mjs';
import {
  mintPassToken,
  buildPassCookie,
  appendSetCookie,
  PASS_TTL_SEC,
} from './middleware/accessGate.mjs';

// Hash helper. Lower-case hex digest to match the seed migration format.
export function hashCode(plaintext) {
  return createHash('sha256').update(String(plaintext)).digest('hex');
}

// Internal: record a failed attempt to stderr in a structured form. We
// avoid recordAudit() here because iam.audit_event requires a non-null
// tenant_id and a failed attempt has no tenant attribution by definition.
function logFailedAttempt({ ip, reason, hash }) {
  // Truncate hash to 12 chars so logs don't echo the full forge-target value.
  const short = typeof hash === 'string' ? hash.slice(0, 12) : '';
  console.warn(`[access.verify.fail] reason=${reason} ip=${ip ?? 'unknown'} hash_prefix=${short}`);
}

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

// POST /api/v1/access/verify
export async function verify(req, res) {
  let body;
  try {
    body = (await readBody(req)) || {};
  } catch (err) {
    if (err?.message === 'payload_too_large') return send(res, 413, { success: false, error: 'payload_too_large' });
    return send(res, 400, { success: false, error: 'invalid_json' });
  }
  const code = String(body?.code ?? '').trim();
  if (!code) return send(res, 400, { success: false, error: 'code_required' });

  const hash = hashCode(code);
  const ip = clientIp(req);

  // Atomic: increment current_uses iff still under cap AND not revoked AND
  // (no expiry OR expiry in the future). The RETURNING row tells us the
  // matched code's tenant for audit attribution.
  let row = null;
  try {
    const { rows } = await q(
      `UPDATE iam.access_code
          SET current_uses = current_uses + 1
        WHERE code_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_uses IS NULL OR current_uses < max_uses)
        RETURNING id, tenant_id, name, expires_at, max_uses, current_uses`,
      [hash],
    );
    row = rows[0] ?? null;
  } catch (err) {
    // DB failure path: do NOT echo SQL details to the client.
    console.error('[access.verify] db_error:', err?.message ?? err);
    return send(res, 500, { success: false, error: 'internal_error' });
  }

  if (!row) {
    logFailedAttempt({ ip, reason: 'unknown_or_capped_or_expired', hash });
    return send(res, 401, { success: false, error: 'invalid_code' });
  }

  // Success — mint a 1h pass token and set the cookie.
  let token;
  try {
    token = mintPassToken({ codeId: row.id, tenantId: row.tenant_id });
  } catch (err) {
    console.error('[access.verify] mint_failed:', err?.message ?? err);
    return send(res, 500, { success: false, error: 'internal_error' });
  }

  appendSetCookie(res, buildPassCookie(token));

  // Record success. Because the audit table requires a tenant_id and global
  // codes have tenant_id IS NULL, we INSERT directly only when the matched
  // code is tenant-scoped. Global-code successes are journaled to stderr.
  if (row.tenant_id) {
    try {
      await q(
        `INSERT INTO iam.audit_event
           (tenant_id, actor_id, actor_email, action, resource, resource_id,
            payload, request_id, ip, user_agent)
         VALUES ($1, NULL, NULL, 'access.verify.success', 'iam.access_code', $2,
                 $3::jsonb, $4, $5, $6)`,
        [
          row.tenant_id,
          row.id,
          JSON.stringify({
            code_name:    row.name,
            current_uses: row.current_uses,
            max_uses:     row.max_uses,
            scope:        'tenant',
          }),
          req?.requestId ?? null,
          ip,
          req?.headers?.['user-agent'] ?? null,
        ],
      );
    } catch (err) {
      // Audit failure must never block the response.
      console.error('[access.verify] audit_insert_failed:', err?.message ?? err);
    }
  } else {
    console.log(
      `[access.verify.success] scope=platform_global code_id=${row.id} ip=${ip ?? 'unknown'}`,
    );
  }

  // pass_token in the body is a convenience for callers that prefer the
  // X-Access-Pass header path (e.g. native mobile shells that don't carry
  // browser cookies). expires_at is ISO so the client can show a countdown.
  const expiresAt = new Date(Date.now() + PASS_TTL_SEC * 1000).toISOString();
  return ok(res, {
    pass_token: token,
    expires_at: expiresAt,
    scope:      row.tenant_id ? 'tenant' : 'platform_global',
  });
}
