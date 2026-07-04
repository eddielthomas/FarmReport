// =============================================================================
// revocation.mjs — JTI blocklist gate (post-requireAuth).
// -----------------------------------------------------------------------------
// On every authenticated request, consults iam.token_revocation by jti. If the
// row exists AND expires_at > now(), the token is treated as revoked: middleware
// writes 401 token_revoked and the caller's handler is skipped.
//
// 30s in-process LRU. Cache stores both positive (revoked=true, with expiry) and
// negative (revoked=false) lookups to keep the hot path single-digit microseconds.
// Negative cache TTL is capped at 30s so a freshly-revoked token is detected
// within at most 30s in steady state.
// =============================================================================

import { q } from '../db/pool.mjs';
import { unauth } from '../http.mjs';

const POS_TTL_MS = 30 * 1000;
const NEG_TTL_MS = 30 * 1000;

// Map<jti, { at: number, revoked: boolean, expiresAt?: number }>
const cache = new Map();

export function invalidateRevocation(jti) {
  if (!jti) { cache.clear(); return; }
  cache.delete(String(jti));
}

export function _peekRevocationCache() { return cache; }

async function lookup(jti) {
  const { rows } = await q(
    `SELECT jti, expires_at FROM iam.token_revocation WHERE jti = $1 LIMIT 1`,
    [jti],
  );
  if (rows.length === 0) return { revoked: false };
  const expiresAt = new Date(rows[0].expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
    // Token already expired naturally — treat as not revoked (it cannot verify).
    return { revoked: false };
  }
  return { revoked: true, expiresAt };
}

// Returns true if the request may proceed; false if 401 token_revoked was written.
export async function checkRevocation(req, res) {
  const jti = req?.user?.jti;
  if (!jti) return true; // tokens without jti predate revocation tracking
  const now = Date.now();
  const hit = cache.get(String(jti));
  if (hit) {
    const ttl = hit.revoked ? POS_TTL_MS : NEG_TTL_MS;
    if (now - hit.at < ttl) {
      if (hit.revoked) { unauth(res, 'token_revoked'); return false; }
      return true;
    }
  }
  try {
    const r = await lookup(String(jti));
    cache.set(String(jti), { at: now, revoked: r.revoked, expiresAt: r.expiresAt });
    if (r.revoked) { unauth(res, 'token_revoked'); return false; }
    return true;
  } catch (err) {
    // On lookup failure, fail OPEN — do not lock the entire API out because a
    // single SELECT failed. Log it. Operators see the failure in the audit/log.
    console.error('[revocation] lookup_failed:', err?.message ?? err);
    return true;
  }
}
