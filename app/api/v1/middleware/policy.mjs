// =============================================================================
// policy.mjs — permission hydration + requirePermission gate (Sprint 1B).
// -----------------------------------------------------------------------------
// Resolves the caller's effective permissions from:
//   1) iam.user_role JOIN iam.role JOIN iam.role_permission     (canonical)
//   2) iam.scope_grant rows (expires_at filtered)                (ad-hoc)
//   3) Legacy roles[] array on the JWT (compat shim mapping legacy keys to
//      canonical permission bundles via LEGACY_ROLE_TO_PERMS).
//
// Exposes:
//   - hydratePermissions(req)  — mutates req.user with .permissions / .roleKeys
//   - requirePermission(req, res, key)  — 403 + audit on miss
//
// Caches per (user_id, tenant_id) for 60s in-process. Cache is best-effort; any
// DB failure soft-defaults to the legacy roles[] shim so requests still flow.
// =============================================================================

import { q } from '../db/pool.mjs';
import { forbid } from '../http.mjs';
import { recordAudit } from '../audit.mjs';

const CACHE_TTL_MS = 60 * 1000;

// Map<`${user_id}|${tenant_id}`, { at, perms: Set<string>, roleKeys: string[] }>
const cache = new Map();

export function _peekCache() { return cache; }
export function invalidatePermissions(userId) {
  if (!userId) { cache.clear(); return; }
  for (const k of cache.keys()) {
    if (k.startsWith(String(userId) + '|')) cache.delete(k);
  }
}

// Bust the in-process policy cache wholesale. Used by /iam/admin/bust-policy-
// cache after migrations that mutate role -> permission mappings (Sprint 9.1
// 145 + 146). Returns the number of entries evicted.
export function bustAllPermissions() {
  const n = cache.size;
  cache.clear();
  return n;
}

// Compat shim: legacy roles[] array on the JWT mapped to the canonical
// permission bundle. Keeps `roles.includes('sales:manage')` callers working.
const LEGACY_ROLE_TO_PERMS = {
  'platform:admin': new Set([
    'platform.admin.all',
    'crm.lead.read','crm.lead.write','crm.lead.assign','crm.lead.delete',
    'crm.contact.read','crm.contact.write',
    'crm.organization.read','crm.organization.write',
    'crm.client.read','crm.client.write',
    'crm.project.read','crm.project.write','crm.project.scan',
    'crm.scene.read','crm.scene.write',
    'crm.detection.read','crm.detection.verify',
    'crm.registration.read','crm.registration.manage',
    'crm.opportunity.read','crm.opportunity.write',
    'crm.dashboard.view','crm.dashboard.revenue.view',
    'crm.chat.read','crm.chat.export','crm.analytics.view',
    'cases.read','cases.manage',
    'iam.users.read','iam.users.manage',
    'iam.roles.read','iam.roles.manage',
    'iam.teams.read','iam.teams.manage',
    'data.read.global','data.read.assigned',
    'audit.read','audit.export',
    'report.read','report.generate','report.export',
  ]),
  'sales:manage': new Set([
    'crm.lead.read','crm.lead.write','crm.lead.assign','crm.lead.delete',
    'crm.contact.read','crm.contact.write',
    'crm.organization.read','crm.organization.write',
    'crm.client.read','crm.client.write',
    'crm.project.read','crm.project.write','crm.project.scan',
    'crm.scene.read','crm.scene.write',
    'crm.registration.read','crm.registration.manage',
    'crm.opportunity.read','crm.opportunity.write',
    'crm.dashboard.view','crm.dashboard.revenue.view',
    'crm.chat.read','crm.chat.write','crm.chat.export','crm.analytics.view',
    'data.read.global',
    'iam.users.read','iam.teams.read',
    // Embedded FieldOpsPanel (sales/CRM dashboards) — mirror sales.manager (mig 145).
    'field.job.read','field.location.read.tenant','field.upload.read','field.geofence.read',
    'report.read','report.generate','report.export',
  ]),
  'ops:manage': new Set([
    'cases.read','cases.manage',
    'crm.lead.read','crm.contact.read',
    // Ops curate projects + request scans + review/verify detections.
    'crm.project.read','crm.project.write','crm.project.scan',
    'crm.scene.read','crm.scene.write',
    'crm.detection.read','crm.detection.verify',
    'crm.registration.read','crm.registration.manage',
    'crm.dashboard.view','data.read.global','iam.teams.read',
    // Field dispatch + FieldOpsPanel (ops dashboard) — mirror ops.manager (mig 144/146)
    // so ops users authenticating via the legacy `ops:manage` bundle (not the
    // canonical ops.manager/ops.coordinator iam.role) can read jobs + tech
    // positions and use the field ops channel. Fixes 403 on /field/jobs +
    // /field/technicians/positions that drove the FieldOpsPanel render loop.
    'field.job.read','field.job.write','field.job.assign',
    'field.location.read.tenant','field.upload.read','field.task.manage',
    'field.geofence.read','ops.dispatch.field',
    'crm.chat.read','crm.chat.write',
    'report.read','report.generate','report.export',
  ]),
  'analytics:view': new Set([
    'crm.analytics.view','crm.dashboard.view','crm.dashboard.revenue.view',
    'report.read','report.generate','report.export',
  ]),
  'dashboard:view': new Set(['crm.dashboard.view']),
  'customer:view':  new Set([
    'crm.lead.read','crm.contact.read','crm.chat.read','crm.dashboard.view','data.read.assigned',
    // Customer portal reads its own projects + scenes (scoped to identity in SQL).
    // Without crm.project.read the portal's /customer/me/projects 403s and the
    // map never gets the AOI to load indicators.
    'crm.project.read','crm.scene.read',
  ]),
  'vendor:view': new Set([
    'crm.lead.read','crm.dashboard.view','data.read.assigned',
  ]),
  // Field technician — dev-login seeds this bundle into user_profile.roles[]
  // (no iam.user_role row), so without this shim entry the demo/bundle field
  // user resolves to ZERO permissions and 403s on every field action. Mirrors
  // the field.technician grants in migration 144.
  'field.technician': new Set([
    'field.job.read','field.location.write','field.checkin',
    'field.upload.write','field.upload.read','field.task.complete',
    // Field tech posts verification results that graduate a detection (P5).
    'crm.project.read','crm.detection.read','crm.detection.verify',
    'crm.dashboard.view','data.read.assigned',
    'report.read',
  ]),
};

// Map legacy → canonical role-keys for the roleKeys field.
const LEGACY_ROLE_KEY_MAP = {
  'platform:admin':  'platform.admin',
  'sales:manage':    'sales.manager',
  'ops:manage':      'ops.manager',
  'analytics:view':  'analytics.viewer',
  'dashboard:view':  'dashboard.viewer',
  'customer:view':   'customer.viewer',
  'vendor:view':     'vendor.viewer',
};

async function loadFromDb(userId) {
  // Role-based permissions via user_role -> role -> role_permission. Skips
  // expired user_role rows. We do NOT filter on tenant_id at the SQL layer
  // here — RLS handles that when the caller route sets app.tenant_id; this
  // helper is used in non-RLS contexts (auth middleware pre-tenant) so we
  // rely on the user_role.user_id PK to bound scope.
  const roleRes = await q(
    `SELECT DISTINCT r.key
       FROM iam.user_role ur
       JOIN iam.role r ON r.id = ur.role_id
      WHERE ur.user_id = $1
        AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId],
  );
  const roleKeys = roleRes.rows.map((r) => r.key);

  const permRes = await q(
    `SELECT DISTINCT rp.permission_key
       FROM iam.user_role ur
       JOIN iam.role_permission rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1
        AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId],
  );

  // Per-resource scope grants are not strictly part of the role-based perms
  // set (they are evaluated per-resource), but we expose them via roleKeys
  // metadata so downstream code may consult them.
  const scopeRes = await q(
    `SELECT permission, resource_type, resource_id
       FROM iam.scope_grant
      WHERE user_id = $1
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );

  // Sprint 5B — load iam.user_profile.clearance. Best-effort: if the column
  // is missing (pre-139 migration) the catch falls through and the caller
  // defaults to 'internal'. We do not filter on tenant_id here because the
  // user_profile primary key + non-RLS context applies.
  let clearance = 'internal';
  try {
    const clrRes = await q(
      `SELECT clearance FROM iam.user_profile WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (clrRes.rows[0]?.clearance) clearance = String(clrRes.rows[0].clearance);
  } catch (_e) { /* pre-migration: keep default */ }

  return {
    roleKeys,
    perms: new Set(permRes.rows.map((r) => r.permission_key)),
    scopeGrants: scopeRes.rows,
    clearance,
  };
}

// Hydrate req.user.permissions + req.user.roleKeys. Idempotent — safe to call
// multiple times; uses cache when fresh.
export async function hydratePermissions(req) {
  if (!req?.user?.sub) return;
  const userId = req.user.sub;
  const tenantId = req.user.tenant_id ?? null;
  const cacheKey = `${userId}|${tenantId ?? ''}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    req.user.permissions = hit.perms;
    req.user.roleKeys    = hit.roleKeys;
    req.user.scopeGrants = hit.scopeGrants;
    req.user.clearance   = hit.clearance ?? 'internal';
    return;
  }

  // Compat shim: seed perms from legacy roles[] array on the token.
  const legacy = req.user.roles ?? [];
  const merged = new Set();
  const roleKeySet = new Set();
  for (const r of legacy) {
    const bundle = LEGACY_ROLE_TO_PERMS[r];
    if (bundle) for (const p of bundle) merged.add(p);
    const canonical = LEGACY_ROLE_KEY_MAP[r];
    if (canonical) roleKeySet.add(canonical);
    else if (typeof r === 'string') roleKeySet.add(r); // already canonical
  }

  let scopeGrants = [];
  let clearance  = 'internal';

  // Sprint A5.1 (ADR-0024) — org-tier permissions. When the token carries an
  // org claim (the active tenant has a parent org AND the user holds an org
  // role) we expand the org roles → org permission bundle and merge it into the
  // effective permission Set. With no org claim this loop is a no-op, so the
  // org_id IS NULL path is byte-identical to today. Best-effort: a DB miss
  // leaves the per-tenant perms untouched.
  const orgRoles = Array.isArray(req.user.org?.org_roles) ? req.user.org.org_roles : [];
  if (orgRoles.length > 0) {
    try {
      const orgPermRes = await q(
        `SELECT DISTINCT permission_key
           FROM iam.org_role_permission
          WHERE org_role_key = ANY($1::text[])`,
        [orgRoles],
      );
      for (const r of orgPermRes.rows) merged.add(r.permission_key);
      for (const k of orgRoles) roleKeySet.add(k);
    } catch (err) {
      console.error('[policy] org_perm_hydrate_failed:', err?.message ?? err);
    }
  }

  try {
    const db = await loadFromDb(userId);
    for (const p of db.perms) merged.add(p);
    for (const k of db.roleKeys) roleKeySet.add(k);
    scopeGrants = db.scopeGrants;
    if (db.clearance) clearance = db.clearance;
  } catch (err) {
    // Soft-fail — if the DB lookup fails (e.g. before migration applies) we
    // still serve the request using the legacy shim only. Log so ops can spot
    // chronic failures.
    console.error('[policy] hydrate_db_failed:', err?.message ?? err);
  }

  // Platform admin shortcut — `platform.admin.all` grants everything we know
  // about at evaluation time. Keep an explicit bypass marker so requirePermission
  // can fast-path.
  if (merged.has('platform.admin.all')) {
    // No-op; consumers test for either the explicit perm or platform.admin role.
  }

  const roleKeys = Array.from(roleKeySet);
  cache.set(cacheKey, { at: now, perms: merged, roleKeys, scopeGrants, clearance });
  req.user.permissions = merged;
  req.user.roleKeys    = roleKeys;
  req.user.scopeGrants = scopeGrants;
  req.user.clearance   = clearance;
}

// Returns true on success, writes 403 + emits audit and returns false on miss.
// Platform admin (`platform.admin.all`) bypasses every gate.
export function requirePermission(req, res, key) {
  const perms = req.user?.permissions;
  if (perms && (perms.has('platform.admin.all') || perms.has(key))) return true;

  try {
    recordAudit({
      req,
      action: 'authz.denied',
      resource: 'iam.permission',
      resourceId: null,
      payload: { required: key, role_keys: req.user?.roleKeys ?? [] },
    });
  } catch (_e) { /* audit best-effort */ }

  forbid(res, 'missing_permission:' + key);
  return false;
}

// Convenience — true/false without the response side-effect. Use when one of
// several permissions is acceptable (caller composes the response).
export function hasPermission(req, key) {
  const perms = req.user?.permissions;
  if (!perms) return false;
  return perms.has('platform.admin.all') || perms.has(key);
}
