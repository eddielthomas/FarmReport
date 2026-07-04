// =============================================================================
// /api/v1/iam/users — tenant-scoped user (staff) CRUD.
// -----------------------------------------------------------------------------
// platform:admin can manage any tenant's users via X-Tenant-Id selection.
// sales:manage / ops:manage can list but not mutate.
// =============================================================================

import { q } from '../db/pool.mjs';
import { readBody, ok, created, badReq, notFound, noContent } from '../http.mjs';
import { requireRole } from '../middleware/auth.mjs';
import { recordAudit } from '../audit.mjs';
import { invalidatePermissions } from '../middleware/policy.mjs';
import { getActiveVertical } from '../../../../packages/config/verticals/index.mjs';

const COLS = 'id, tenant_id, email, display_name, roles, status, clearance, created_at';

// Sprint 5B (P-010 Phase 3) — Bell-LaPadula clearance set. Mirrors the SQL
// CHECK in 139_classification.sql. Self-elevation is blocked at the route
// layer (only platform:admin can set clearance via create/update).
const CLEARANCE_VALUES = new Set(['public','internal','confidential','secret']);

function sanitizeClearance(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().toLowerCase();
  return CLEARANCE_VALUES.has(s) ? s : null;
}

// Sprint 4B (P-009 Phase 1): extended with three canonical vendor roles.
// `vendor:view` / `vendor:manage` / `vendor:billing` are first-class roles now
// rather than the flat legacy `vendor:view` stub the MVP shipped with. The
// vendor role assignment path additionally requires MFA at the IdP layer
// (Keycloak `acr=aal2`) — see the create() handler below for the defensive
// defense-in-depth check that fails closed if mfa_required is not satisfied.
//
// Sprint A1 (OperationsOS SolutionPack): KNOWN_ROLES is now derived as
// platform-base ∪ activeVertical.roles. The RWR reference pack lists the EXACT
// role set below, so for RWR users KNOWN_ROLES is unchanged in practice. The
// literal fallback set is retained so the IAM surface keeps working byte-for-
// byte even if the pack fails to load (defensive, behaviour-preserving).
const FALLBACK_KNOWN_ROLES = [
  'platform:admin',
  'sales:manage',
  'ops:manage',
  'analytics:view',
  'dashboard:view',
  'customer:view',
  'vendor:view',
  'vendor:manage',
  'vendor:billing',
];

function resolveKnownRoles() {
  try {
    const pack = getActiveVertical();
    const merged = Array.isArray(pack?.knownRoles) && pack.knownRoles.length
      ? pack.knownRoles
      : FALLBACK_KNOWN_ROLES;
    // Union with the fallback so the merged set is always a SUPERSET of the
    // original platform roles — never a regression.
    return new Set([...FALLBACK_KNOWN_ROLES, ...merged]);
  } catch (e) {
    console.warn('[iam.users] SolutionPack load failed; using fallback KNOWN_ROLES', e?.message);
    return new Set(FALLBACK_KNOWN_ROLES);
  }
}

export const KNOWN_ROLES = resolveKnownRoles();

export function isVendorRole(role) {
  return typeof role === 'string' && role.startsWith('vendor:');
}

function sanitizeRoles(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const r of input) {
    const s = String(r).trim();
    if (KNOWN_ROLES.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export async function list(req, res) {
  const { rows } = await q(
    `SELECT ${COLS} FROM iam.user_profile WHERE tenant_id = $1 ORDER BY display_name`,
    [req.tenant.id],
  );
  ok(res, rows);
}

export async function create(req, res) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const email = String(body.email ?? '').trim().toLowerCase();
  const display_name = String(body.display_name ?? '').trim();
  const roles = sanitizeRoles(body.roles) ?? ['dashboard:view'];
  if (!email || !display_name) return badReq(res, 'email_and_display_name_required');

  // Sprint 4B (P-009 Phase 1) defensive MFA gate — defense-in-depth only.
  // The proper enforcement lives at the IdP (Keycloak `acr=aal2` required-
  // action on any vendor:* role). This check rejects naive callers who try to
  // hand a vendor role to a freshly-created user without going through the
  // MFA enrollment flow. The flag `mfa_validated:true` on the request body is
  // what the invite-redemption flow sets after Keycloak signs back the TOTP
  // completion claim. Direct admin REST callers should set that bit only
  // after they have confirmed MFA out-of-band.
  const hasVendorRole = roles.some(isVendorRole);
  if (hasVendorRole && body.mfa_validated !== true) {
    return badReq(res, 'vendor_mfa_required');
  }

  // Sprint 5B (P-010 Phase 3) — clearance accepted only from platform:admin
  // (the requireRole gate above already enforces this). Invalid values reject
  // the request rather than silently defaulting so callers learn fast.
  let clearance = 'internal';
  if (body.clearance !== undefined) {
    const c = sanitizeClearance(body.clearance);
    if (!c) return badReq(res, 'invalid_clearance');
    clearance = c;
  }

  const { rows } = await q(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, clearance)
     VALUES ($1, $2, $3, $4::TEXT[], $5)
     ON CONFLICT (tenant_id, email) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           clearance    = EXCLUDED.clearance
     RETURNING ${COLS}`,
    [req.tenant.id, email, display_name, roles, clearance],
  );
  const userRow = rows[0];

  // Sprint 4B Phase 1: ensure every vendor user has a backing iam.vendor_profile
  // row so requireVendorScope can resolve it. Idempotent — UNIQUE(user_id)
  // collides on re-runs and the upsert touches updated_at only.
  if (hasVendorRole) {
    await q(
      `INSERT INTO iam.vendor_profile
         (tenant_id, user_id, category, status, primary_contact_email, mfa_required)
       VALUES ($1, $2, 'sales', 'active', $3, TRUE)
       ON CONFLICT (user_id) DO UPDATE
         SET updated_at = now(),
             primary_contact_email = COALESCE(iam.vendor_profile.primary_contact_email, EXCLUDED.primary_contact_email)`,
      [req.tenant.id, userRow.id, email],
    );
    recordAudit({
      req,
      action: 'iam.vendor_profile.create',
      resource: 'iam.vendor_profile',
      resourceId: userRow.id,
      payload: { after: { user_id: userRow.id, category: 'sales', status: 'active' } },
    });
  }

  recordAudit({ req, action: 'create', resource: 'iam.user', resourceId: userRow.id, payload: { email, roles } });
  created(res, userRow);
}

export async function update(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const body = (await readBody(req).catch(() => null)) || {};
  const sets = [];
  const params = [id, req.tenant.id];
  let i = 3;
  if (body.display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(String(body.display_name)); }
  if (body.status !== undefined)       { sets.push(`status = $${i++}`);       params.push(String(body.status)); }
  if (body.roles !== undefined) {
    const r = sanitizeRoles(body.roles);
    if (!r) return badReq(res, 'roles_must_be_array');
    // Sprint 4B (P-009 Phase 1) defensive MFA gate — same as create().
    if (r.some(isVendorRole) && body.mfa_validated !== true) {
      return badReq(res, 'vendor_mfa_required');
    }
    sets.push(`roles = $${i++}::TEXT[]`); params.push(r);
  }
  // Sprint 5B (P-010 Phase 3) clearance update. Users cannot self-elevate;
  // requireRole(platform:admin) above gates the entire handler, so the
  // canonical "no self-elevation" property is satisfied by the route gate.
  if (body.clearance !== undefined) {
    const c = sanitizeClearance(body.clearance);
    if (!c) return badReq(res, 'invalid_clearance');
    sets.push(`clearance = $${i++}`);
    params.push(c);
  }
  if (sets.length === 0) return badReq(res, 'no_fields_to_update');
  const { rows } = await q(
    `UPDATE iam.user_profile SET ${sets.join(', ')}
      WHERE id = $1 AND tenant_id = $2
      RETURNING ${COLS}`,
    params,
  );
  if (rows.length === 0) return notFound(res);
  // Sprint 5B — bust the policy.mjs cache when roles or clearance change so
  // the next request hits the fresh DB state. Idempotent on the cache layer.
  invalidatePermissions(id);
  recordAudit({ req, action: 'update', resource: 'iam.user', resourceId: id, payload: { fields: sets.map(s => s.split(' = ')[0]) } });
  ok(res, rows[0]);
}

export async function deactivate(req, res, id) {
  if (!requireRole(req, res, 'platform:admin')) return;
  const { rows } = await q(
    `UPDATE iam.user_profile SET status = 'inactive'
      WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, req.tenant.id],
  );
  if (rows.length === 0) return notFound(res);
  recordAudit({ req, action: 'deactivate', resource: 'iam.user', resourceId: id });
  noContent(res);
}
