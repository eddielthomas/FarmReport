// =============================================================================
// /api/v1/org/drilldown.mjs — Sprint A5.3 (ADR-0024) entitled drill-down.
// -----------------------------------------------------------------------------
// Where A5.2 lets the State see the FOREST (pre-aggregated roll-ups, never raw
// rows), A5.3 lets an entitled org-user drill into the TREES of SPECIFIC
// districts they have been granted — and ONLY those. This is an explicit,
// AUDITED capability, never an isolation bypass:
//
//   1. Entitlement — iam.org_scope_grant lists which child tenants the org-user
//      may drill into (with an optional per-grant classification ceiling +
//      expiry). Resolved by EMAIL so it works across the user's per-district
//      identities.
//   2. N RLS-scoped reads — for each ENTITLED district we open a district-tenant-
//      scoped connection (withTenantConn sets rwr.tenant_id to that district, and
//      app.clearance to min(caller, grant ceiling)) and run ONE query. RLS — incl.
//      the classification lattice — gates each read to that district's permitted
//      rows. Districts the caller is NOT granted are refused (403). Works across
//      pooled + dedicated districts (withTenantConn → resolvePool, the A4 path).
//   3. Audit — every cross-district read writes an iam.audit_event (target tenant,
//      actor, resource, row count) so "who looked at what" is forensically replayable.
//
// Endpoints:
//   GET  /api/v1/org/drilldown?resource=leads|cases[&district=<slug|uuid>]
//   POST /api/v1/org/scope-grants  { email, tenant_slug, classification_ceiling? }
//   GET  /api/v1/org/scope-grants
//
// All gated by the org claim + org.drilldown (read) / state.admin (grant mgmt).
// Org-less callers → 403, so the org_id IS NULL path is byte-identical.
// =============================================================================

import { q, withTenantConn } from '../db/pool.mjs';
import { ok, created, badReq, forbid, notFound } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const CLASS_ORDER = { public: 0, internal: 1, confidential: 2, secret: 3 };

// Whitelisted drill-down resources → the district business table + the columns
// we surface. Aggregates? No — this IS the raw-row path, but it is entitlement-
// gated + RLS-scoped + audited. Columns are explicit (no SELECT *).
const RESOURCES = {
  leads: {
    sql: `SELECT id, name, email, company, status, total_revenue, created_at
            FROM sales.lead ORDER BY created_at DESC LIMIT 200`,
  },
  cases: {
    sql: `SELECT id, title, status, investigation_type, priority, opened_at
            FROM ops.case ORDER BY opened_at DESC LIMIT 200`,
  },
};

function callerOrg(req) { return req?.user?.org ?? null; }

// Gate: org claim + org.drilldown permission (hydrated into req.user.permissions
// from the org role bundle). Returns the org block or null (after writing 403).
function requireDrilldown(req, res) {
  const org = callerOrg(req);
  if (!org?.org_id) { forbid(res, 'org_claim_required'); return null; }
  const perms = req?.user?.permissions;
  const allowed = perms && (perms.has('org.drilldown') || perms.has('platform.admin.all'));
  if (!allowed) { forbid(res, 'missing_permission:org.drilldown'); return null; }
  return org;
}

// state.admin on the active org may manage grants.
function requireOrgAdmin(req, res) {
  const org = callerOrg(req);
  if (!org?.org_id) { forbid(res, 'org_claim_required'); return null; }
  const roles = org.org_roles ?? [];
  if (!roles.includes('state.admin')) { forbid(res, 'requires_state_admin'); return null; }
  return org;
}

// Resolve the entitled districts for the caller within their org, BY EMAIL so a
// grant made against any of the caller's per-district identities is honoured.
// Org-tier registry reads only (iam.*) — no district business rows.
async function entitledDistricts(orgId, email) {
  const { rows } = await q(
    `SELECT g.tenant_id, g.classification_ceiling, t.slug, t.display_name
       FROM iam.org_scope_grant g
       JOIN iam.user_profile up ON up.id = g.user_ref
       JOIN iam.tenant t        ON t.id  = g.tenant_id
      WHERE g.org_id = $1 AND up.email = $2
        AND (g.expires_at IS NULL OR g.expires_at > now())`,
    [orgId, email],
  );
  // De-dupe by tenant_id (a user may hold the same grant via >1 profile),
  // keeping the LOWEST classification ceiling (most restrictive) per district.
  const byTenant = new Map();
  for (const r of rows) {
    const prev = byTenant.get(r.tenant_id);
    const rank = (c) => (c && c in CLASS_ORDER ? CLASS_ORDER[c] : CLASS_ORDER.internal);
    if (!prev || rank(r.classification_ceiling) < rank(prev.classification_ceiling)) {
      byTenant.set(r.tenant_id, r);
    }
  }
  return Array.from(byTenant.values());
}

// Effective clearance for a district read = min(caller clearance, grant ceiling).
function effectiveClearance(callerClr, grantCeiling) {
  const rank = (c) => (c && c in CLASS_ORDER ? CLASS_ORDER[c] : CLASS_ORDER.internal);
  const caller = callerClr && callerClr in CLASS_ORDER ? callerClr : 'internal';
  const ceil   = grantCeiling && grantCeiling in CLASS_ORDER ? grantCeiling : caller;
  return rank(ceil) < rank(caller) ? ceil : caller;
}

// =============================================================================
// GET /api/v1/org/drilldown?resource=&district=
// =============================================================================
export async function drilldown(req, res) {
  const org = requireDrilldown(req, res);
  if (!org) return;

  const url = new URL(req.url, 'http://x');
  const resourceKey = (url.searchParams.get('resource') || 'leads').toLowerCase();
  const resource = RESOURCES[resourceKey];
  if (!resource) return badReq(res, 'unknown_resource');
  const districtFilter = url.searchParams.get('district'); // slug or uuid, optional

  const entitled = await entitledDistricts(org.org_id, req.user?.email);
  if (entitled.length === 0) return forbid(res, 'no_entitled_districts');

  // Narrow to a single district if requested — and REFUSE if not entitled.
  let targets = entitled;
  if (districtFilter) {
    targets = entitled.filter((d) => d.tenant_id === districtFilter || d.slug === districtFilter);
    if (targets.length === 0) return forbid(res, 'tenant_not_entitled');
  }

  const districts = [];
  for (const d of targets) {
    // Synthetic district-scoped request: tenant = THIS district; actor = the real
    // caller; clearance = min(caller, grant ceiling). withTenantConn binds the
    // rwr.tenant_id GUC (+ app.clearance) so RLS + the classification lattice gate
    // the read to this district's permitted rows. resolvePool handles dedicated.
    const districtReq = {
      tenant:    { id: d.tenant_id },
      user:      { ...req.user, clearance: effectiveClearance(req.user?.clearance, d.classification_ceiling) },
      headers:   req.headers,
      socket:    req.socket,
      requestId: req.requestId,
    };

    let rows = [];
    try {
      rows = await withTenantConn(districtReq, async (client) => {
        const r = await client.query(resource.sql);
        return r.rows;
      });
    } catch (_e) { rows = []; }

    // Audit the cross-district read — target tenant + actor + resource + count.
    recordAudit({
      req: districtReq,
      action: 'org.drilldown.read',
      resource: `org.drilldown.${resourceKey}`,
      resourceId: d.tenant_id,
      payload: {
        org_id: org.org_id,
        district_id: d.tenant_id,
        district_slug: d.slug,
        resource: resourceKey,
        row_count: rows.length,
        effective_clearance: districtReq.user.clearance,
      },
    });

    districts.push({
      district_id:  d.tenant_id,
      tenant_slug:  d.slug,
      display_name: d.display_name,
      row_count:    rows.length,
      rows,
    });
  }

  ok(res, { org_id: org.org_id, resource: resourceKey, districts });
}

// =============================================================================
// POST /api/v1/org/scope-grants  { email, tenant_slug, classification_ceiling? }
// state.admin grants an org-user drill-down into a child district of the org.
// =============================================================================
export async function createGrant(req, res) {
  const org = requireOrgAdmin(req, res);
  if (!org) return;

  const body = req.body ?? (await readJson(req));
  const email = String(body?.email ?? '').trim().toLowerCase();
  const tenantSlug = String(body?.tenant_slug ?? '').trim();
  const ceiling = body?.classification_ceiling && body.classification_ceiling in CLASS_ORDER
    ? body.classification_ceiling : null;
  if (!email || !tenantSlug) return badReq(res, 'email_and_tenant_slug_required');

  // The target district MUST belong to this org (no granting outside the org).
  const { rows: tRows } = await q(
    `SELECT id FROM iam.tenant WHERE slug = $1 AND org_id = $2 LIMIT 1`,
    [tenantSlug, org.org_id],
  );
  if (tRows.length === 0) return badReq(res, 'tenant_not_in_org');
  const tenantId = tRows[0].id;

  // Resolve the grantee to a user_profile id within the org (any district).
  const { rows: uRows } = await q(
    `SELECT up.id FROM iam.user_profile up
       JOIN iam.tenant t ON t.id = up.tenant_id
      WHERE up.email = $1 AND t.org_id = $2
      ORDER BY (up.tenant_id = $3) DESC
      LIMIT 1`,
    [email, org.org_id, tenantId],
  );
  if (uRows.length === 0) return badReq(res, 'grantee_not_in_org');
  const userRef = uRows[0].id;

  const { rows: gRows } = await q(
    `INSERT INTO iam.org_scope_grant (org_id, user_ref, tenant_id, classification_ceiling)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id, org_id, user_ref, tenant_id, classification_ceiling, created_at`,
    [org.org_id, userRef, tenantId, ceiling],
  );
  // ON CONFLICT DO NOTHING returns no row if the grant already existed — fetch it.
  let grant = gRows[0];
  if (!grant) {
    const { rows: ex } = await q(
      `SELECT id, org_id, user_ref, tenant_id, classification_ceiling, created_at
         FROM iam.org_scope_grant
        WHERE org_id=$1 AND user_ref=$2 AND tenant_id=$3 LIMIT 1`,
      [org.org_id, userRef, tenantId]);
    grant = ex[0] ?? null;
  }

  recordAudit({
    req,
    action: 'org.scope_grant.create',
    resource: 'iam.org_scope_grant',
    resourceId: grant?.id ?? null,
    payload: { org_id: org.org_id, grantee_email: email, tenant_slug: tenantSlug, classification_ceiling: ceiling },
  });

  created(res, grant);
}

// GET /api/v1/org/scope-grants — list the org's grants (admin) or the caller's.
export async function listGrants(req, res) {
  const org = callerOrg(req);
  if (!org?.org_id) return forbid(res, 'org_claim_required');
  const isAdmin = (org.org_roles ?? []).includes('state.admin');
  const { rows } = await q(
    `SELECT g.id, g.user_ref, g.tenant_id, t.slug AS tenant_slug,
            up.email AS grantee_email, g.classification_ceiling, g.expires_at, g.created_at
       FROM iam.org_scope_grant g
       JOIN iam.tenant t        ON t.id  = g.tenant_id
       JOIN iam.user_profile up ON up.id = g.user_ref
      WHERE g.org_id = $1 ${isAdmin ? '' : 'AND up.email = $2'}
      ORDER BY g.created_at DESC`,
    isAdmin ? [org.org_id] : [org.org_id, req.user?.email],
  );
  ok(res, { org_id: org.org_id, grants: rows });
}

// Minimal JSON body reader (index.mjs may not pre-parse for these routes).
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
