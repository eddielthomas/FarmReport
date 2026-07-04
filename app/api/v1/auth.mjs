// =============================================================================
// /api/v1/auth — dev-mode login + invite-only registration.
// -----------------------------------------------------------------------------
// POST /auth/dev-login { tenant_slug, email } → { token, user }
//   - dev-only, gated upstream by NODE_ENV+ALLOW_DEV_LOGIN (router returns 404
//     in non-dev)
//   - resolves the tenant by slug
//   - upserts an iam.user_profile row for the email if missing
//   - signs a short-lived JWT with { sub, tenant_id, email, roles[] }
//
// POST /auth/register → 410 Gone (use /auth/register-with-invite instead)
// POST /auth/register-with-invite { token, display_name }
//   - looks up + atomically consumes the invite by token_hash
//   - creates iam.user_profile with the invite's role_keys
//   - returns a JWT — identical surface contract to /auth/dev-login
//
// Production replaces dev-login with a Keycloak code-grant flow; the token
// shape stays identical so requireAuth() doesn't change.
// =============================================================================

import { q } from './db/pool.mjs';
import { sign } from './middleware/auth.mjs';
import { readBody, ok, badReq, send, forbid } from './http.mjs';
import { recordAudit } from './audit.mjs';
import { consumeByPlaintext } from './iam/invites.mjs';
import { invalidatePermissions } from './middleware/policy.mjs';
import { resolveOrgContextForTenant } from './iam/orgs.mjs';

// Sprint A5.1 (ADR-0024) — mint a JWT with the standard per-tenant claims and,
// when the active tenant has a parent org AND the user holds an org-tier role,
// an additive `org` claim block. With org_id IS NULL (or no org-tier role) the
// minted token is BYTE-IDENTICAL to the pre-A5.1 shape — no new required claims.
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
    // Soft-fail: never block login on org resolution. Falls back to the exact
    // pre-A5.1 token shape (no org claim).
    console.error('[auth] org_resolve_failed:', err?.message ?? err);
  }
  if (org) {
    claims.org = {
      org_id:    org.org_id,
      org_slug:  org.org_slug,
      org_roles: org.org_roles,
    };
  }
  return { token: sign(claims), org };
}

// Sprint 12 — `dashboard:view` is now a STRICT entitlement to the ops map
// (dashboard.html) and is no longer the default. Demo bundles are trimmed so
// each role only carries the entitlements that match its surface:
//   * admin   → keeps dashboard:view (super-user + sees every surface)
//   * ops     → keeps dashboard:view (ops map is part of the ops cluster)
//   * analyst → keeps dashboard:view (analysts need the map for context)
//   * sales   → REMOVED — sales has its own pipeline UI, not the ops map
//   * field   → REMOVED — field techs use the field PWA only
//   * customer → REMOVED — customers have their own portal
//   * vendor  → REMOVED — vendors have their own portal
// The DEFAULT_ROLES fallback is now empty: an unknown demo email gets no
// surface entitlements and stays on login.html (server-side authz on every
// API call is still the actual security boundary; this is a UX guardrail).
const DEFAULT_ROLES = [];

// Dev-login demo accounts pick up role bundles by email prefix so the Login
// screen's quick-pick buttons land the right surface without any DB seeding.
// Real production users get roles via /iam/users + /iam/roles only.
// Farm personas. Every farm/* handler accepts a legacy fallback role via
// farmGate (farm:view for reads, farm:onboard for writes, alert:manage,
// report:generate), so these literal roles unlock the farm surfaces even before
// the dot-perms are hydrated. Keys match the Login demo picker (admin/buyer/
// ops/grower) plus the surface aliases still routed by the SolutionPack.
const DEMO_ROLE_BUNDLES = {
  'admin':    ['platform:admin','ops:manage','analytics:view','dashboard:view','farm:view','farm:onboard','farm.portfolio.view','report:generate','alert:manage'],
  'buyer':    ['farm:view','farm.portfolio.view','report:generate','dashboard:view'],
  'ops':      ['ops:manage','dashboard:view','farm:view','farm:onboard','alert:manage'],
  'grower':   ['customer:view','farm:view'],
  'analyst':  ['analytics:view','dashboard:view','farm:view','farm.portfolio.view'],
  'sales':    ['sales:manage','farm:view','farm.portfolio.view'],
  'field':    ['field.technician','field.job.read','field.location.write','field.checkin','field.upload.write','field.task.complete','farm:view'],
  'customer': ['customer:view','farm:view'],
  'vendor':   ['vendor:view','farm:view'],
};

function rolesForDemoEmail(email) {
  const idx = email.indexOf('@');
  if (idx < 1) return DEFAULT_ROLES;
  const prefix = email.slice(0, idx);
  if (DEMO_ROLE_BUNDLES[prefix]) return DEMO_ROLE_BUNDLES[prefix];
  // Allow per-client demo identities like `customer-pp@…` / `ops-houston@…`:
  // fall back to the bundle keyed by the segment before the first '-'.
  const base = prefix.split('-')[0];
  return DEMO_ROLE_BUNDLES[base] || DEFAULT_ROLES;
}

export async function devLogin(req, res) {
  const body = (await readBody(req).catch(() => null)) || {};
  const tenant_slug = String(body.tenant_slug ?? '').trim().toLowerCase();
  const email       = String(body.email ?? '').trim().toLowerCase();
  if (!tenant_slug || !email) return badReq(res, 'tenant_slug_and_email_required');

  const { rows: trows } = await q(
    'SELECT id, slug, display_name FROM iam.tenant WHERE slug = $1 LIMIT 1',
    [tenant_slug],
  );
  if (trows.length === 0) return badReq(res, 'unknown_tenant_slug');
  const tenant = trows[0];

  // Pick role bundle by demo email prefix. On conflict we OVERWRITE roles
  // so demo users always reflect the current bundle (e.g. after S9.1's
  // ops.coordinator/field_specialist split).
  const seededRoles = rolesForDemoEmail(email);

  const { rows: urows } = await q(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, email)
       DO UPDATE SET display_name = EXCLUDED.display_name, roles = EXCLUDED.roles
     RETURNING id, tenant_id, email, display_name, roles`,
    [tenant.id, email, email.split('@')[0], seededRoles],
  );
  const user = urows[0];

  // Sprint 5B — dev-login is a fresh credential checkpoint. Bust the
  // policy.mjs per-user cache so the next /api/v1 hit re-reads user_profile
  // (picking up out-of-band clearance / role mutations made via SQL or via
  // /iam/users between sessions).
  invalidatePermissions(user.id);

  const { token, org } = await mintTenantToken(user, tenant);

  // Stamp tenant on req so recordAudit can attribute correctly.
  req.tenant = { id: user.tenant_id, slug: tenant.slug };
  recordAudit({
    req,
    action: 'dev_login',
    resource: 'iam.user_profile',
    resourceId: user.id,
    payload: { after: { email: user.email, roles: user.roles } },
  });

  ok(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      tenant_id:    user.tenant_id,
      tenant_slug:  tenant.slug,
      roles:        user.roles,
      org:          org ? { org_id: org.org_id, org_slug: org.org_slug, org_roles: org.org_roles } : null,
    },
  });
}

// =============================================================================
// POST /auth/switch-tenant { tenant_slug }
// -----------------------------------------------------------------------------
// Re-mints the caller's JWT for a DIFFERENT district (tenant) they belong to.
// Validates membership: the caller (by email) MUST have an iam.user_profile row
// in the target tenant. On success the new token's tenant_id claim is the target
// district (plus the additive org claim when that district has a parent org).
// 403 when the caller is not a member of the target tenant.
//
// Reuses the SAME mint path as dev-login (mintTenantToken) — no forked signer.
// =============================================================================
export async function switchTenant(req, res) {
  const body = (await readBody(req).catch(() => null)) || {};
  const target = String(body.tenant_slug ?? '').trim().toLowerCase();
  if (!target) return badReq(res, 'tenant_slug_required');

  const email = String(req.user?.email ?? '').trim().toLowerCase();
  if (!email) return badReq(res, 'no_caller_email');

  // Resolve the target tenant.
  const { rows: trows } = await q(
    'SELECT id, slug, display_name, status FROM iam.tenant WHERE slug = $1 LIMIT 1',
    [target],
  );
  if (trows.length === 0) return badReq(res, 'unknown_tenant_slug');
  const tenant = trows[0];
  if (tenant.status !== 'active' && tenant.status !== 'trial') {
    return forbid(res, 'tenant_suspended');
  }

  // Membership check: the caller must have a user_profile in the target tenant.
  const { rows: urows } = await q(
    `SELECT id, tenant_id, email, display_name, roles
       FROM iam.user_profile
      WHERE tenant_id = $1 AND email = $2
      LIMIT 1`,
    [tenant.id, email],
  );
  if (urows.length === 0) return forbid(res, 'not_a_member_of_tenant');
  const user = urows[0];

  // Re-mint via the shared path → tenant_id claim is now the target district.
  invalidatePermissions(user.id);
  const { token, org } = await mintTenantToken(user, tenant);

  // Audit the switch (mutation of the caller's active context).
  req.tenant = { id: user.tenant_id, slug: tenant.slug };
  recordAudit({
    req,
    action: 'auth.switch_tenant',
    resource: 'iam.tenant',
    resourceId: tenant.id,
    payload: { after: { tenant_slug: tenant.slug, email, org_id: org?.org_id ?? null } },
  });

  ok(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      tenant_id:    user.tenant_id,
      tenant_slug:  tenant.slug,
      roles:        user.roles,
      org:          org ? { org_id: org.org_id, org_slug: org.org_slug, org_roles: org.org_roles } : null,
    },
  });
}

export async function whoami(req, res) {
  // requireAuth already ran upstream; req.user is present.
  ok(res, { user: req.user });
}

// =============================================================================
// POST /auth/register — DEPRECATED. Returns 410 Gone.
// -----------------------------------------------------------------------------
// Self-serve registration is disabled (CRM Sprint 0 F-1 security blocker).
// Use POST /auth/register-with-invite with a single-use token minted by an
// admin via POST /iam/invites.
// =============================================================================
export async function register(req, res) {
  send(res, 410, {
    success: false,
    error: 'gone',
    detail: 'self_serve_registration_disabled',
    hint:   'POST /auth/register-with-invite with { token, display_name }',
  });
}

// =============================================================================
// POST /auth/register-with-invite { token, display_name }
// -----------------------------------------------------------------------------
// Atomically consumes the invite (UPDATE … WHERE consumed_at IS NULL ...),
// reads tenant_id + email + role_keys from the invite row (NOT from caller),
// upserts an iam.user_profile, returns a JWT.
// =============================================================================
export async function registerWithInvite(req, res) {
  const body = (await readBody(req).catch(() => null)) || {};
  const tokenPlain   = String(body.token ?? '').trim();
  const display_name = String(body.display_name ?? '').trim();
  if (!tokenPlain) return badReq(res, 'token_required');

  const invite = await consumeByPlaintext(tokenPlain);
  if (!invite) return badReq(res, 'invalid_or_expired_invite');

  // tenant lookup for the JWT's tenant_slug claim
  const { rows: trows } = await q(
    'SELECT id, slug FROM iam.tenant WHERE id = $1 LIMIT 1',
    [invite.tenant_id],
  );
  if (trows.length === 0) return badReq(res, 'invite_tenant_missing');
  const tenant = trows[0];

  const email = invite.email;
  const fallbackName = display_name || email.split('@')[0];

  const { rows: urows } = await q(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, email)
       DO UPDATE SET display_name = EXCLUDED.display_name,
                     roles        = EXCLUDED.roles
     RETURNING id, tenant_id, email, display_name, roles`,
    [tenant.id, email, fallbackName, invite.role_keys],
  );
  const user = urows[0];

  const { token, org } = await mintTenantToken(user, tenant);

  // Stamp tenant on req so audit emits with the correct attribution.
  req.tenant = { id: user.tenant_id, slug: tenant.slug };
  recordAudit({
    req,
    action: 'register_with_invite',
    resource: 'iam.user_profile',
    resourceId: user.id,
    payload: {
      after: { email: user.email, roles: user.roles },
      invite_id: invite.id,
    },
  });

  ok(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      tenant_id:    user.tenant_id,
      tenant_slug:  tenant.slug,
      roles:        user.roles,
      org:          org ? { org_id: org.org_id, org_slug: org.org_slug, org_roles: org.org_roles } : null,
    },
  });
}
