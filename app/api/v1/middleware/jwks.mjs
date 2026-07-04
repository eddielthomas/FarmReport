// =============================================================================
// jwks.mjs — Keycloak/OIDC JWKS verifier for mvp (ESM port).
// -----------------------------------------------------------------------------
// Ported from services/api-gateway/src/plugins/jwks.ts. Uses `jose` for remote
// JWKS fetch + signature verification. Cache TTL = 1 hour, with a 10 s cooldown
// on rotation-triggered re-fetch (retry-on-miss-once).
//
// Env contract:
//   - KEYCLOAK_JWKS_URL        e.g. https://keycloak/realms/rwr/protocol/openid-connect/certs
//   - KEYCLOAK_ISSUER_URL      e.g. https://keycloak/realms/rwr
//   - OIDC_AUDIENCE            comma-separated list (optional but recommended)
//
// Behavior:
//   - verifyJwks(token) -> claims object on success, throws on failure.
//   - Returns a normalized claims shape:
//       { sub, email, tenant_id, tenant, roles[], scope, iss, aud, exp }
//   - Roles are pulled from realm_access.roles (Keycloak default) or top-level
//     `roles` claim. tenant_id falls back to top-level `tenant`.
// =============================================================================

let _jose = null;
let _jwks = null;
let _cfg  = null;

export function jwksConfigured() {
  return !!process.env.KEYCLOAK_JWKS_URL && !!process.env.KEYCLOAK_ISSUER_URL;
}

function parseAudienceList(s) {
  if (!s) return undefined;
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

async function loadJose() {
  if (_jose) return _jose;
  try {
    _jose = await import('jose');
  } catch (err) {
    throw new Error(
      `jwks_init_failed: 'jose' package required but unavailable: ${err?.message ?? err}`,
    );
  }
  return _jose;
}

async function ensureJwks() {
  if (_jwks && _cfg) return { jose: _jose, jwks: _jwks, cfg: _cfg };
  const jwksUrl = process.env.KEYCLOAK_JWKS_URL;
  const issuer  = process.env.KEYCLOAK_ISSUER_URL;
  if (!jwksUrl || !issuer) {
    throw new Error('jwks_not_configured');
  }
  const audience = parseAudienceList(process.env.OIDC_AUDIENCE);
  const jose = await loadJose();
  _jwks = jose.createRemoteJWKSet(new URL(jwksUrl), {
    // 1h cache + 10s rotation cooldown (retry-on-miss-once).
    cacheMaxAge:      60 * 60 * 1000,
    cooldownDuration: 10 * 1000,
    timeoutDuration:  5  * 1000,
  });
  _cfg = { jwksUrl, issuer, audience };
  return { jose, jwks: _jwks, cfg: _cfg };
}

// Normalize verified payload to the claims shape requireAuth() expects.
function normalize(raw) {
  const scopeStr = typeof raw.scope === 'string' ? raw.scope : '';
  const roles = Array.isArray(raw.roles)
    ? raw.roles
    : (raw.realm_access && Array.isArray(raw.realm_access.roles)
        ? raw.realm_access.roles
        : []);
  const tenant = typeof raw.tenant_id === 'string'
    ? raw.tenant_id
    : (typeof raw.tenant === 'string' ? raw.tenant : null);
  return {
    sub:       String(raw.sub ?? ''),
    email:     typeof raw.email === 'string' ? raw.email : null,
    tenant_id: tenant,
    tenant,
    roles,
    scope:     scopeStr,
    iss:       typeof raw.iss === 'string' ? raw.iss : null,
    aud:       raw.aud,
    exp:       typeof raw.exp === 'number' ? raw.exp : null,
  };
}

// Verify a bearer token against the configured JWKS. Throws on failure.
export async function verifyJwks(token) {
  const { jose, jwks, cfg } = await ensureJwks();
  const { payload } = await jose.jwtVerify(token, jwks, {
    issuer:   cfg.issuer,
    audience: cfg.audience,
  });
  return normalize(payload);
}

// Test/ops helper: reset cache (used by hot-reload paths or rotation alarms).
export function resetJwksCache() {
  _jwks = null;
  _cfg  = null;
}
