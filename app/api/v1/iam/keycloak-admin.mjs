// =============================================================================
// keycloak-admin.mjs — minimal Keycloak Admin REST client (service account).
// -----------------------------------------------------------------------------
// Lets RWR provision SSO users (e.g. invite a customer to their portal) without
// anyone touching the Keycloak console. Uses a confidential service-account
// client (client_credentials grant) with realm-management `manage-users`.
//
// DORMANT until configured — kcAdminConfigured() gates every caller:
//   KEYCLOAK_ISSUER_URL          (already set for OIDC login; e.g.
//                                 https://keycloak.eddiethomas.space/realms/rwr)
//   KEYCLOAK_ADMIN_CLIENT_ID     (e.g. rwr-admin)
//   KEYCLOAK_ADMIN_CLIENT_SECRET (the service-account client secret)
//
// Derives the admin base from the issuer:
//   issuer  = …/realms/<realm>
//   server  = … (issuer without /realms/<realm>)
//   admin   = <server>/admin/realms/<realm>
// =============================================================================

const ISSUER = (process.env.KEYCLOAK_ISSUER_URL || '').replace(/\/+$/, '');
const ADMIN_CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID || '';
const ADMIN_CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || '';

function parts() {
  const m = ISSUER.match(/^(.*)\/realms\/([^/]+)$/);
  if (!m) return null;
  return { server: m[1], realm: m[2], issuer: ISSUER, adminBase: `${m[1]}/admin/realms/${m[2]}` };
}

export function kcAdminConfigured() {
  return Boolean(ISSUER && ADMIN_CLIENT_ID && ADMIN_CLIENT_SECRET && parts());
}

let _tok = null, _exp = 0;
async function adminToken() {
  if (_tok && Date.now() < _exp - 30_000) return _tok;
  const p = parts();
  const r = await fetch(`${p.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ADMIN_CLIENT_ID,
      client_secret: ADMIN_CLIENT_SECRET,
    }).toString(),
  });
  if (!r.ok) throw new Error(`kc admin token failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  _tok = j.access_token;
  _exp = Date.now() + (Number(j.expires_in) || 60) * 1000;
  return _tok;
}

async function kc(path, { method = 'GET', body } = {}) {
  const p = parts();
  const tok = await adminToken();
  const r = await fetch(`${p.adminBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r;
}

// Look up a user by exact email; returns the Keycloak user rep or null.
async function findByEmail(email) {
  const r = await kc(`/users?email=${encodeURIComponent(email)}&exact=true`);
  if (!r.ok) throw new Error(`kc find user ${r.status}`);
  const arr = await r.json();
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

// Create (or find) a Keycloak user, set a temporary password, set the
// tenant_slug attribute, and grant the given realm roles. Idempotent on email.
// Returns { id, created, email }.
export async function ensureUser({ email, firstName, lastName, tenantSlug, roles = [], tempPassword,
                                   emailVerified = true, requiredActions }) {
  if (!kcAdminConfigured()) throw new Error('keycloak_admin_not_configured');
  if (!email) throw new Error('email_required');

  let user = await findByEmail(email);
  let created = false;
  if (!user) {
    const res = await kc('/users', { method: 'POST', body: {
      username: email, email, enabled: true, emailVerified: Boolean(emailVerified),
      firstName: firstName || 'Customer', lastName: lastName || '',
      ...(Array.isArray(requiredActions) && requiredActions.length ? { requiredActions } : {}),
      attributes: tenantSlug ? { tenant_slug: [String(tenantSlug)] } : {},
    } });
    if (res.status !== 201 && res.status !== 409) {
      throw new Error(`kc create user ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    user = await findByEmail(email);
    created = res.status === 201;
  }
  if (!user?.id) throw new Error('kc user id missing after create');

  // tenant_slug attribute (ensure set even if the user pre-existed)
  if (tenantSlug) {
    await kc(`/users/${user.id}`, { method: 'PUT', body: {
      attributes: { ...(user.attributes || {}), tenant_slug: [String(tenantSlug)] },
    } }).catch(() => {});
  }

  // temporary password (forces reset on first login)
  if (tempPassword) {
    await kc(`/users/${user.id}/reset-password`, { method: 'PUT', body: {
      type: 'password', value: tempPassword, temporary: true,
    } });
  }

  // grant realm roles
  for (const roleName of roles) {
    const rr = await kc(`/roles/${encodeURIComponent(roleName)}`);
    if (rr.ok) {
      const role = await rr.json();
      await kc(`/users/${user.id}/role-mappings/realm`, { method: 'POST', body: [{ id: role.id, name: role.name }] }).catch(() => {});
    }
  }
  return { id: user.id, created, email };
}
