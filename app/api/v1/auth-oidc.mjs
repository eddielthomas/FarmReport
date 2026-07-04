// =============================================================================
// auth-oidc.mjs — P4: Keycloak OIDC authorization-code login (opt-in).
// -----------------------------------------------------------------------------
// A REAL OIDC code-grant flow that activates ONLY when Keycloak is configured
// (KEYCLOAK_ISSUER_URL && KEYCLOAK_CLIENT_ID present). When unconfigured every
// handler is a clean 404 no-op so the existing dev-login + invite flows keep
// working unchanged.
//
// Flow:
//   GET /auth/oidc/login    -> 302 to Keycloak authorize endpoint (state + PKCE
//                              stored in short cookies).
//   GET /auth/oidc/callback -> exchange ?code at the token endpoint, decode the
//                              id_token (or hit userinfo), resolve tenant, upsert
//                              iam.user_profile, mint the SAME app session token
//                              the rest of the platform expects, then 302 to the
//                              SPA handoff URL.
//
// Token parity: we re-use `sign` (HS256) + `resolveOrgContextForTenant` — the
// exact two building blocks auth.mjs#mintTenantToken uses — so the minted token
// is byte-identical to a dev-login/invite token. requireAuth() does not change.
//
// Deps: Node built-ins (crypto, URL) + global fetch + jsonwebtoken (decode only).
// =============================================================================

import { randomBytes, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { q } from './db/pool.mjs';
import { sign } from './middleware/auth.mjs';
import { send } from './http.mjs';
import { resolveOrgContextForTenant } from './iam/orgs.mjs';

// Short-lived cookies that carry the per-request OIDC handshake state. They are
// HttpOnly (never read by JS) and Lax (survive the top-level redirect back from
// Keycloak). 10-minute lifetime — only needs to outlive the user's login click.
const STATE_COOKIE     = 'rwr.oidc_state';
const VERIFIER_COOKIE  = 'rwr.oidc_verifier';
const HANDSHAKE_TTL_SEC = 10 * 60;

// ---- configuration ----------------------------------------------------------

export function oidcConfigured() {
  return !!process.env.KEYCLOAK_ISSUER_URL && !!process.env.KEYCLOAK_CLIENT_ID;
}

// Trailing-slash-safe issuer base.
function issuerBase() {
  return String(process.env.KEYCLOAK_ISSUER_URL || '').replace(/\/+$/, '');
}
function authorizeUrl()  { return issuerBase() + '/protocol/openid-connect/auth'; }
function tokenUrl()      { return issuerBase() + '/protocol/openid-connect/token'; }
function userinfoUrl()   { return issuerBase() + '/protocol/openid-connect/userinfo'; }

// Resolve the redirect_uri Keycloak will bounce back to. Prefer the explicit
// env (must EXACTLY match a Valid Redirect URI registered on the client);
// otherwise derive from the inbound request's forwarded host/proto.
function resolveRedirectUri(req) {
  const fromEnv = process.env.KEYCLOAK_REDIRECT_URI;
  if (fromEnv) return fromEnv;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
  return `${proto}://${host}/api/v1/auth/oidc/callback`;
}

// ---- PKCE -------------------------------------------------------------------
// base64url(no padding) of raw bytes.
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeCodeVerifier() {
  // 32 random bytes -> 43-char base64url string (RFC 7636 §4.1: 43..128 chars).
  return b64url(randomBytes(32));
}
function codeChallengeS256(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}
function makeState() {
  return b64url(randomBytes(16));
}

// ---- cookies (zero-dep header strings, mirrors accessGate.mjs pattern) -------
function readCookie(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw || typeof raw !== 'string') return null;
  for (const p of raw.split(';')) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() !== name) continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch { /* leave raw */ }
    return v || null;
  }
  return null;
}
function buildCookie(name, value, maxAge) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  // Secure unless we're plainly on local dev HTTP (browsers reject Secure on
  // http:// for non-localhost). KEYCLOAK_ISSUER_URL is https in any real setup.
  if (process.env.NODE_ENV === 'production' || issuerBase().startsWith('https')) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
function clearedCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', value);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', existing.concat(value));
  else res.setHeader('Set-Cookie', [String(existing), value]);
}

// ---- token mint (parity with auth.mjs#mintTenantToken) ----------------------
// Re-implemented from the SAME primitives so the emitted JWT is byte-identical
// to a dev-login token. mintTenantToken is not exported from auth.mjs and this
// file must not edit shared modules, so we inline the identical logic here.
async function mintTenantToken(user, tenant) {
  const claims = {
    sub:         user.id,
    email:       user.email,
    tenant_id:   user.tenant_id,
    roles:       user.roles,
    tenant_slug: tenant.slug,
  };
  let org = null;
  try {
    org = await resolveOrgContextForTenant(user.id, user.tenant_id);
  } catch (err) {
    console.error('[auth-oidc] org_resolve_failed:', err?.message ?? err);
  }
  if (org) {
    claims.org = { org_id: org.org_id, org_slug: org.org_slug, org_roles: org.org_roles };
  }
  return { token: sign(claims), org };
}

// ---- role mapping -----------------------------------------------------------
// Map Keycloak roles to app role keys. We accept top-level `roles` (custom
// mapper) or `realm_access.roles` (Keycloak default). Roles are passed through
// verbatim; if you need a translation table, edit ROLE_MAP below. Default: [].
const ROLE_MAP = {
  // 'keycloak-realm-role': 'app:role:key',
};
function mapRoles(claims) {
  const raw = Array.isArray(claims?.roles)
    ? claims.roles
    : (Array.isArray(claims?.realm_access?.roles) ? claims.realm_access.roles : []);
  const mapped = raw
    .map((r) => ROLE_MAP[r] ?? r)
    .filter((r) => typeof r === 'string' && r.length > 0);
  // De-dup, preserve order.
  return [...new Set(mapped)];
}

// ---- handlers ---------------------------------------------------------------

// GET /auth/oidc/login — kick off the authorization-code flow.
export async function loginRedirect(req, res) {
  if (!oidcConfigured()) {
    return send(res, 404, { success: false, error: 'oidc_not_configured' });
  }
  try {
    const state    = makeState();
    const verifier = makeCodeVerifier();
    const challenge = codeChallengeS256(verifier);
    const redirectUri = resolveRedirectUri(req);

    const u = new URL(authorizeUrl());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', process.env.KEYCLOAK_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');

    appendSetCookie(res, buildCookie(STATE_COOKIE, state, HANDSHAKE_TTL_SEC));
    appendSetCookie(res, buildCookie(VERIFIER_COOKIE, verifier, HANDSHAKE_TTL_SEC));

    res.writeHead(302, { Location: u.toString() });
    res.end();
  } catch (err) {
    send(res, 500, { success: false, error: 'oidc_login_failed', detail: String(err?.message ?? err) });
  }
}

// GET /auth/oidc/callback — finish the flow: exchange code, provision user,
// mint app token, hand off to the SPA.
export async function callback(req, res) {
  if (!oidcConfigured()) {
    return send(res, 404, { success: false, error: 'oidc_not_configured' });
  }
  try {
    const url = new URL(req.url, 'http://x');
    const code      = url.searchParams.get('code');
    const stateQ    = url.searchParams.get('state');
    const oidcError = url.searchParams.get('error');
    if (oidcError) {
      return send(res, 400, { success: false, error: 'oidc_provider_error', detail: oidcError });
    }
    if (!code) return send(res, 400, { success: false, error: 'missing_code' });

    // CSRF: the state we set on /login must come back unchanged.
    const stateCookie = readCookie(req, STATE_COOKIE);
    if (!stateCookie || !stateQ || stateCookie !== stateQ) {
      return send(res, 400, { success: false, error: 'state_mismatch' });
    }
    const verifier = readCookie(req, VERIFIER_COOKIE);
    if (!verifier) return send(res, 400, { success: false, error: 'missing_pkce_verifier' });

    const redirectUri = resolveRedirectUri(req);

    // ---- exchange the code for tokens --------------------------------------
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('client_id', process.env.KEYCLOAK_CLIENT_ID);
    form.set('redirect_uri', redirectUri);
    form.set('code', code);
    form.set('code_verifier', verifier);
    // Confidential client → include the secret. Public+PKCE clients omit it.
    if (process.env.KEYCLOAK_CLIENT_SECRET) {
      form.set('client_secret', process.env.KEYCLOAK_CLIENT_SECRET);
    }

    const tokenRes = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      return send(res, 502, { success: false, error: 'token_exchange_failed', status: tokenRes.status, detail: detail.slice(0, 500) });
    }
    const tokenSet = await tokenRes.json();
    const idToken     = tokenSet.id_token;
    const accessToken = tokenSet.access_token;

    // ---- derive identity claims --------------------------------------------
    // Decode the id_token over the already-TLS-verified token response. We do
    // not re-verify the RS256 signature here because the token came directly
    // from Keycloak's token endpoint over TLS (not an attacker-supplied bearer).
    let claims = idToken ? (jwt.decode(idToken) || {}) : {};

    // Fall back to /userinfo if the id_token lacked an email.
    if (!claims.email && accessToken) {
      try {
        const uiRes = await fetch(userinfoUrl(), {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (uiRes.ok) claims = { ...claims, ...(await uiRes.json()) };
      } catch { /* best-effort enrichment */ }
    }

    const email = String(claims.email ?? '').trim().toLowerCase();
    if (!email) return send(res, 400, { success: false, error: 'no_email_claim' });

    // ---- resolve tenant -----------------------------------------------------
    // Precedence: explicit token claim 'tenant_slug' / 'tenant' → env default.
    const tenantSlug = String(
      claims.tenant_slug ?? claims.tenant ?? process.env.KEYCLOAK_DEFAULT_TENANT_SLUG ?? '',
    ).trim().toLowerCase();
    if (!tenantSlug) return send(res, 400, { success: false, error: 'no_tenant_hint' });

    const { rows: trows } = await q(
      'SELECT id, slug, display_name FROM iam.tenant WHERE slug = $1 LIMIT 1',
      [tenantSlug],
    );
    if (trows.length === 0) return send(res, 400, { success: false, error: 'unknown_tenant_slug' });
    const tenant = trows[0];

    // ---- upsert user_profile (mirrors devLogin) -----------------------------
    const roles = mapRoles(claims);
    const displayName = String(claims.name ?? claims.preferred_username ?? email.split('@')[0]);
    const { rows: urows } = await q(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, email)
         DO UPDATE SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles
       RETURNING id, tenant_id, email, display_name, roles`,
      [tenant.id, email, displayName, roles],
    );
    const user = urows[0];

    // ---- mint app session token --------------------------------------------
    const { token } = await mintTenantToken(user, tenant);

    // ---- clear handshake cookies + hand off to the SPA ----------------------
    appendSetCookie(res, clearedCookie(STATE_COOKIE));
    appendSetCookie(res, clearedCookie(VERIFIER_COOKIE));

    const handoff = `/login.html?oidc_token=${encodeURIComponent(token)}`
      + `&tenant_id=${encodeURIComponent(user.tenant_id)}`
      + `&tenant_slug=${encodeURIComponent(tenant.slug)}`;
    res.writeHead(302, { Location: handoff });
    res.end();
  } catch (err) {
    send(res, 500, { success: false, error: 'oidc_callback_failed', detail: String(err?.message ?? err) });
  }
}
