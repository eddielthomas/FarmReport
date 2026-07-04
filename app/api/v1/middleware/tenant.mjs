// =============================================================================
// tenant middleware — validates X-Tenant-Id and stamps req.tenant.
// -----------------------------------------------------------------------------
// All /api/v1 business routes (everything except /auth/* and /tenants admin
// endpoints) MUST be wrapped with this so we never accidentally cross-leak
// data between tenants. The header MAY be a UUID or the tenant slug — both
// resolve to the same iam.tenant row.
// =============================================================================

import { getHeader, badReq, forbid } from '../http.mjs';
import { q } from '../db/pool.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory tenant cache. Tenants rarely change; we refresh on cache miss.
const cache = new Map();   // key: id|slug → row
let cacheStamp = 0;
const CACHE_TTL_MS = 30_000;

async function resolveTenant(idOrSlug) {
  const isUuid = UUID_RE.test(idOrSlug);
  const now = Date.now();
  if (now - cacheStamp > CACHE_TTL_MS) { cache.clear(); cacheStamp = now; }
  if (cache.has(idOrSlug)) return cache.get(idOrSlug);
  const { rows } = await q(
    `SELECT id, slug, display_name, status, plan
       FROM iam.tenant
      WHERE ${isUuid ? 'id = $1' : 'slug = $1'}
      LIMIT 1`,
    [idOrSlug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  cache.set(row.id, row);
  cache.set(row.slug, row);
  return row;
}

export async function requireTenant(req, res) {
  // 1) explicit header wins
  let key = getHeader(req, 'x-tenant-id');
  // 2) fall back to token's tenant_id if no header was sent
  if (!key && req.user?.tenant_id) key = req.user.tenant_id;
  if (!key) { badReq(res, 'missing_tenant_header'); return null; }

  const tenant = await resolveTenant(key.trim());
  if (!tenant) { badReq(res, 'unknown_tenant'); return null; }
  if (tenant.status !== 'active' && tenant.status !== 'trial') {
    forbid(res, 'tenant_suspended');
    return null;
  }

  // 3) if a token is present, the header tenant MUST match the token tenant
  if (req.user?.tenant_id && req.user.tenant_id !== tenant.id) {
    // Platform admins can act on any tenant.
    const isAdmin = (req.user.roles ?? []).includes('platform:admin');
    if (!isAdmin) { forbid(res, 'tenant_mismatch'); return null; }
  }

  return tenant;
}

export function invalidateTenantCache() { cache.clear(); cacheStamp = 0; }
