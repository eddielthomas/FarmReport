// =============================================================================
// accessGate.mjs — Sprint 10B pilot access-code gate.
// -----------------------------------------------------------------------------
// Verifies the short-lived `rwr.access_pass` JWT issued by /api/v1/access/verify
// against the same HS256 secret used elsewhere. The pass token is the "human
// on the other side" marker — it is NOT a substitute for requireAuth() and
// NEVER conveys authorization claims (no tenant resolution, no role checks).
// The downstream auth.mjs + tenant.mjs middlewares still own real AuthN/AuthZ.
//
// Token shape (signed by access.mjs#mintPassToken):
//   {
//     iss:        'rwr-mvp',
//     access_pass: true,           // canonical claim — any other value rejected
//     code_id:    <uuid>,          // iam.access_code.id (for forensics)
//     tenant_id:  <uuid> | null,   // matched code's tenant (NULL = global)
//     iat, exp, jti
//   }
//
// Sources of the token (first hit wins):
//   1. Cookie header `rwr.access_pass`
//   2. Header `X-Access-Pass`
//
// Dev escape hatch:
//   NODE_ENV !== 'production' && SKIP_ACCESS_GATE === '1' → no-op (returns ok).
//   The escape hatch ALSO ensures any HTTP cookie-setting caller writes a
//   synthetic pass on the response so the downstream cookie check at the
//   static-HTML layer passes too — implemented in stampSyntheticPass().
//
// Exports:
//   requireAccessGate(req)            → { ok: true, claims } | { ok: false, reason }
//   readAccessPassFromReq(req)        → string | null
//   stampSyntheticPass(res)           → void (dev-only)
//   PASS_COOKIE_NAME                  → 'rwr.access_pass'
// =============================================================================

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { JWT_SECRET, JWT_ISSUER } from './auth.mjs';

export const PASS_COOKIE_NAME = 'rwr.access_pass';
export const PASS_HEADER_NAME = 'x-access-pass';

// 1-hour TTL per S10B spec. Override with RWR_ACCESS_PASS_TTL_SEC if you
// need shorter pilot windows.
export const PASS_TTL_SEC = Number(process.env.RWR_ACCESS_PASS_TTL_SEC ?? 60 * 60);

const SYNTHETIC_PASS_NAME = '__rwr_synthetic_access_pass__';

// ---- cookie parsing (zero deps) --------------------------------------------
// Conservative parser: splits on `;`, trims, supports `name=value` pairs.
// Returns the FIRST matching value (RFC 6265 allows multiples; we take first).
export function readCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    if (k !== name) continue;
    let v = p.slice(eq + 1).trim();
    // Strip surrounding quotes if any.
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch { /* leave raw on bad escape */ }
    return v || null;
  }
  return null;
}

export function readAccessPassFromReq(req) {
  // Header wins for programmatic callers (e.g. server-side fetches) so they
  // don't need to ferry cookies through. UI traffic uses the cookie.
  const hdr = req?.headers?.[PASS_HEADER_NAME];
  if (typeof hdr === 'string' && hdr.length > 0) return hdr;
  return readCookie(req, PASS_COOKIE_NAME);
}

// Sign a short-lived pass token. Caller passes the matched access_code row.
export function mintPassToken({ codeId, tenantId }) {
  if (!JWT_SECRET) {
    throw new Error('access_pass_unavailable: JWT_SECRET not configured');
  }
  return jwt.sign(
    {
      access_pass: true,
      code_id:    codeId ?? null,
      tenant_id:  tenantId ?? null,
      jti:        randomUUID(),
    },
    JWT_SECRET,
    {
      issuer:    JWT_ISSUER,
      expiresIn: PASS_TTL_SEC,
    },
  );
}

// Verify the pass token. Returns claims on success or null on any failure
// (expired, bad sig, missing claim). Never throws — the caller distinguishes
// missing/invalid via the wrapper requireAccessGate().
function verifyPassToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (!JWT_SECRET) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    if (claims?.access_pass !== true) return null;
    return claims;
  } catch {
    return null;
  }
}

// Dev escape hatch test. Centralised so both the API gate and the static-HTML
// gate consult the same predicate.
export function isEscapeHatchEnabled() {
  return process.env.NODE_ENV !== 'production'
      && process.env.SKIP_ACCESS_GATE === '1';
}

// Stamp a synthetic pass cookie on the response so static-HTML gates and
// downstream proxies also bypass during dev. Idempotent on the same response.
export function stampSyntheticPass(res) {
  if (!isEscapeHatchEnabled()) return;
  if (res?.[SYNTHETIC_PASS_NAME]) return;
  try {
    const tok = mintPassToken({ codeId: null, tenantId: null });
    appendSetCookie(res, buildPassCookie(tok));
    res[SYNTHETIC_PASS_NAME] = true;
  } catch { /* JWT_SECRET missing — escape hatch can't operate, just skip. */ }
}

// Build a Set-Cookie header value for the pass cookie. Caller decides whether
// to append (Set-Cookie) or replace. Secure flag is on by default; tests
// running over plain HTTP localhost can read it because browsers accept
// Secure cookies on http://localhost — but our QA harness reads from
// raw headers anyway. SameSite=Lax allows top-level navigation to gated
// pages from a redirect.
export function buildPassCookie(token, opts = {}) {
  const maxAge = opts.maxAge ?? PASS_TTL_SEC;
  const parts = [
    `${PASS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'SameSite=Lax',
    'Secure',
  ];
  // HttpOnly: false. The frontend needs to be able to detect presence via
  // document.cookie to short-circuit the access.html bounce. The token does
  // not convey any authorization claim so XSS exposure is bounded.
  return parts.join('; ');
}

export function buildClearedPassCookie() {
  return [
    `${PASS_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

// Append a single Set-Cookie entry; preserves any cookies already set on
// this response (Node http allows array-valued Set-Cookie headers).
export function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', existing.concat(value));
  } else {
    res.setHeader('Set-Cookie', [String(existing), value]);
  }
}

// Public API used by index.mjs (post-allowlist, pre-requireAuth) and by
// api/server.mjs (static-HTML gate).
//
// Returns { ok: true, claims } on success or { ok: false, reason } on miss.
// Never writes to res — caller decides whether to 401-json or 302-redirect.
export function requireAccessGate(req) {
  if (isEscapeHatchEnabled()) {
    return { ok: true, claims: { access_pass: true, dev_escape: true } };
  }
  const tok = readAccessPassFromReq(req);
  if (!tok) return { ok: false, reason: 'missing_access_pass' };
  const claims = verifyPassToken(tok);
  if (!claims) return { ok: false, reason: 'invalid_access_pass' };
  return { ok: true, claims };
}
