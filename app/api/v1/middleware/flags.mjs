// =============================================================================
// flags.mjs — per-tenant feature flag loader.
// -----------------------------------------------------------------------------
// After requireTenant() resolves req.tenant, this middleware merges two sources
// into req.tenant.flags:
//   1) iam.tenant.feature_flags   (JSONB column — coarse, all-or-nothing toggles)
//   2) iam.tenant_feature_flag    (per-key rows — fine-grained, audit-quality)
// Row-level keys win over JSONB keys (more recent + auditable).
//
// 60s in-process LRU keyed by tenant_id. Invalidated on PUT /iam/tenants/:id/flags
// via invalidateFlags(tenantId).
//
// On error, the middleware logs and leaves req.tenant.flags = {} — flag
// resolution must never block a request.
// =============================================================================

import { q } from '../db/pool.mjs';

const CACHE_TTL_MS = 60 * 1000;

// Map<tenantId, { at: number, flags: object }>
const cache = new Map();

export function invalidateFlags(tenantId) {
  if (!tenantId) { cache.clear(); return; }
  cache.delete(String(tenantId));
}

export function _peekCache() { return cache; }

async function loadFlags(tenantId) {
  // JSONB column from iam.tenant.
  const baseRes = await q(
    `SELECT feature_flags FROM iam.tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const base = baseRes.rows[0]?.feature_flags ?? {};

  const rowsRes = await q(
    `SELECT key, value FROM iam.tenant_feature_flag WHERE tenant_id = $1`,
    [tenantId],
  );
  const overrides = {};
  for (const r of rowsRes.rows) overrides[r.key] = r.value;

  return { ...base, ...overrides };
}

export async function hydrateFlags(req) {
  const tid = req?.tenant?.id;
  if (!tid) return; // pre-tenant routes — no-op
  const now = Date.now();
  const hit = cache.get(String(tid));
  if (hit && now - hit.at < CACHE_TTL_MS) {
    req.tenant.flags = hit.flags;
    return;
  }
  try {
    const flags = await loadFlags(tid);
    cache.set(String(tid), { at: now, flags });
    req.tenant.flags = flags;
  } catch (err) {
    // Soft failure — leave an empty object so route code doesn't NPE.
    console.error('[flags] hydrate_failed:', err?.message ?? err);
    req.tenant.flags = {};
  }
}
