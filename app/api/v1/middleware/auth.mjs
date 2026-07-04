// =============================================================================
// auth middleware — bearer-token verification.
// -----------------------------------------------------------------------------
// Two verification paths:
//   1) JWKS path  (Keycloak RS256, preferred prod):
//        - active when KEYCLOAK_JWKS_URL is set
//        - implemented in ./jwks.mjs
//   2) HS256 path (legacy dev / dev-login):
//        - JWT_SECRET env is REQUIRED in production
//        - active when JWKS is not configured, or when AUTH_FALLBACK_HS256=1
//
// Production fail-fast: if NODE_ENV==='production' and no JWT_SECRET and no
// JWKS URL, module init throws — the server refuses to boot with a weak default.
// =============================================================================

import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getHeader, unauth, forbid } from '../http.mjs';
import { verifyJwks, jwksConfigured } from './jwks.mjs';

const IS_PROD             = process.env.NODE_ENV === 'production';
const HAS_JWT_SECRET      = !!process.env.JWT_SECRET;
const HAS_JWKS_URL        = jwksConfigured();
const FALLBACK_HS256      = process.env.AUTH_FALLBACK_HS256 === '1';

// Fail-fast in production: refuse to boot with the old dev fallback secret.
if (IS_PROD && !HAS_JWT_SECRET && !HAS_JWKS_URL) {
  throw new Error(
    'auth_init_failed: NODE_ENV=production but neither JWT_SECRET nor KEYCLOAK_JWKS_URL is configured.',
  );
}

// HS256 secret — only used on the legacy path. In dev we still allow a
// well-known value so local smoke tests keep working without extra setup.
export const JWT_SECRET = process.env.JWT_SECRET
  ?? (IS_PROD ? null : 'dev-only-not-for-prod');
export const JWT_ISSUER = 'rwr-mvp';
export const JWT_TTL_SEC = Number(process.env.JWT_TTL_SEC ?? 60 * 60 * 8); // 8h

export function sign(payload) {
  if (!JWT_SECRET) {
    throw new Error('jwt_sign_unavailable: JWT_SECRET not configured');
  }
  // Always emit a jti so revocation/blocklist works. Callers may pre-set jti
  // (e.g. invite-token mint flows that need to record the hash). Otherwise we
  // assign a fresh randomUUID.
  const claims = { ...payload };
  if (!claims.jti) claims.jti = randomUUID();
  return jwt.sign(claims, JWT_SECRET, {
    issuer: JWT_ISSUER,
    expiresIn: JWT_TTL_SEC,
  });
}

export function verifyHs256(token) {
  if (!JWT_SECRET) throw new Error('jwt_verify_unavailable');
  return jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER });
}

// Legacy alias kept for callers — selects HS256 path.
export const verify = verifyHs256;

// Choose verification path:
//   - if JWKS configured AND not explicitly forcing fallback → JWKS only
//   - else if fallback enabled OR not prod → HS256
//   - else (prod, no JWKS, no fallback) → already threw at module init.
async function verifyToken(token) {
  if (HAS_JWKS_URL && !FALLBACK_HS256) {
    return await verifyJwks(token);
  }
  return verifyHs256(token);
}

// Returns { user } on success or null + writes 401 to res on failure.
// Routes that don't require a logged-in user can pass { allowAnonymous: true }.
export async function requireAuth(req, res, opts = {}) {
  const hdr = getHeader(req, 'authorization') ?? '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    if (opts.allowAnonymous) return { user: null };
    unauth(res, 'missing_bearer_token');
    return null;
  }
  try {
    const claims = await verifyToken(m[1]);
    const user = {
      sub:        claims.sub,
      email:      claims.email,
      tenant_id:  claims.tenant_id ?? claims.tenant ?? null,
      roles:      claims.roles ?? [],
      // Sprint A5.1 (ADR-0024) — additive org claim block. Absent (null) for
      // standalone tenants (org_id IS NULL) → byte-identical to pre-A5.1.
      org:        claims.org ?? null,
      jti:        claims.jti ?? null,
      aud:        claims.aud,
      acr:        claims.acr,
      exp:        claims.exp,
      permissions: new Set(),     // hydrated by policy.mjs at handler dispatch
      roleKeys:   [],             // canonical role keys (post-shim)
    };
    return { user };
  } catch (err) {
    unauth(res, 'invalid_token');
    return null;
  }
}

export function requireRole(req, res, role) {
  const roles = req.user?.roles ?? [];
  if (!roles.includes(role) && !roles.includes('platform:admin')) {
    forbid(res, 'missing_role:' + role);
    return false;
  }
  return true;
}

// Accept if the user carries ANY of the listed roles. platform:admin is always
// allowed (super-user). Writes 403 + returns false on miss.
export function requireAnyRole(req, res, ...allowed) {
  const roles = req.user?.roles ?? [];
  if (roles.includes('platform:admin')) return true;
  for (const r of allowed) if (roles.includes(r)) return true;
  forbid(res, 'missing_role:' + allowed.join('|'));
  return false;
}
