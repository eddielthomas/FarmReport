// =============================================================================
// email/prefs.mjs — tenant + user email preference resolver.
// -----------------------------------------------------------------------------
// Single source of truth for "should we send this email kind to this user".
//
// Precedence:
//   1. explicit user pref  (iam.user_email_pref.enabled)   — wins absolutely
//   2. tenant pref         (iam.tenant_email_pref.enabled)
//   3. built-in default    (DEFAULTS map)
//
// Cache: 60s LRU keyed by (tenantId, userId, kind). Invalidated on PATCH by
// setTenantPref / setUserPref. The cache is in-process — multi-process
// deployments will see at-most-60s staleness across replicas. That is the
// acceptable interim until P-004's pg_notify channel is wired.
// =============================================================================

import { withTenantConn } from '../db/pool.mjs';

export const KINDS = Object.freeze([
  'lead_created',
  'lead_status_changed',
  'meeting_scheduled',
  'case_assigned',
  'chat_alert',
]);

// Default-on for everything except chat_alert (per the spec — chat alerts are
// opt-in to avoid spamming ops with every conversation).
const DEFAULTS = Object.freeze({
  lead_created:         true,
  lead_status_changed:  true,
  meeting_scheduled:    true,
  case_assigned:        true,
  chat_alert:           false,
});

const CACHE_TTL_MS = 60 * 1000;
// key: `${tenantId}|${userId ?? '-'}|${kind}` -> { at, enabled }
const cache = new Map();

function cacheKey(tenantId, userId, kind) {
  return `${tenantId ?? '-'}|${userId ?? '-'}|${kind}`;
}

export function bustCache(tenantId, userId) {
  for (const k of Array.from(cache.keys())) {
    if (tenantId && !k.startsWith(`${tenantId}|`)) continue;
    if (userId && !k.includes(`|${userId}|`)) continue;
    cache.delete(k);
  }
}

export function _peekCache() { return cache; }

// ----- core resolver ---------------------------------------------------------
// `shouldSend(kind, tenantId, userId)` returns true/false.
// - Pure read; never mutates.
// - Tolerates DB failure (soft-defaults to DEFAULTS[kind]).
export async function shouldSend(kind, tenantId, userId) {
  if (!KINDS.includes(kind)) return DEFAULTS[kind] ?? true;
  const ck = cacheKey(tenantId, userId, kind);
  const now = Date.now();
  const hit = cache.get(ck);
  if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.enabled;

  let enabled = DEFAULTS[kind] ?? true;
  try {
    if (tenantId && userId) {
      const r = await _readUserPref(tenantId, userId, kind);
      if (r !== null) enabled = r;
      else {
        const t = await _readTenantPref(tenantId, kind);
        if (t !== null) enabled = t;
      }
    } else if (tenantId) {
      const t = await _readTenantPref(tenantId, kind);
      if (t !== null) enabled = t;
    }
  } catch (err) {
    console.error('[email.prefs] shouldSend_failed:', err?.message ?? err);
  }
  cache.set(ck, { at: now, enabled });
  return enabled;
}

// ----- direct DB readers (no caching layer; used by shouldSend + REST GETs) --
async function _readUserPref(tenantId, userId, kind) {
  return withTenantConn({ tenant: { id: tenantId } }, async (client) => {
    const { rows } = await client.query(
      `SELECT enabled FROM iam.user_email_pref
        WHERE tenant_id = $1 AND user_id = $2 AND kind = $3`,
      [tenantId, userId, kind],
    );
    if (rows.length === 0) return null;
    return Boolean(rows[0].enabled);
  });
}

async function _readTenantPref(tenantId, kind) {
  return withTenantConn({ tenant: { id: tenantId } }, async (client) => {
    const { rows } = await client.query(
      `SELECT enabled FROM iam.tenant_email_pref
        WHERE tenant_id = $1 AND kind = $2`,
      [tenantId, kind],
    );
    if (rows.length === 0) return null;
    return Boolean(rows[0].enabled);
  });
}

// ----- bulk fetches for the REST surface -------------------------------------
export async function getTenantPrefs(tenantId) {
  const rows = await withTenantConn({ tenant: { id: tenantId } }, (client) =>
    client.query(
      `SELECT kind, enabled, updated_at, updated_by
         FROM iam.tenant_email_pref WHERE tenant_id = $1`,
      [tenantId],
    ),
  ).then((r) => r.rows);
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return KINDS.map((kind) => {
    const r = byKind.get(kind);
    return {
      kind,
      enabled: r ? Boolean(r.enabled) : (DEFAULTS[kind] ?? true),
      configured: Boolean(r),
      updated_at: r?.updated_at ?? null,
      updated_by: r?.updated_by ?? null,
    };
  });
}

export async function getUserPrefs(tenantId, userId) {
  const rows = await withTenantConn({ tenant: { id: tenantId } }, (client) =>
    client.query(
      `SELECT kind, enabled, updated_at
         FROM iam.user_email_pref WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    ),
  ).then((r) => r.rows);
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return KINDS.map((kind) => {
    const r = byKind.get(kind);
    return {
      kind,
      enabled: r ? Boolean(r.enabled) : null,   // null = inherit tenant/default
      configured: Boolean(r),
      updated_at: r?.updated_at ?? null,
    };
  });
}

// ----- writes (PATCH endpoints call these) -----------------------------------
export async function setTenantPref(tenantId, kind, enabled, updatedBy = null) {
  if (!KINDS.includes(kind)) throw new Error(`invalid_kind:${kind}`);
  await withTenantConn({ tenant: { id: tenantId } }, async (client) => {
    await client.query(
      `INSERT INTO iam.tenant_email_pref (tenant_id, kind, enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, kind) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [tenantId, kind, !!enabled, updatedBy],
    );
  });
  bustCache(tenantId, null);
}

export async function setUserPref(tenantId, userId, kind, enabled) {
  if (!KINDS.includes(kind)) throw new Error(`invalid_kind:${kind}`);
  await withTenantConn({ tenant: { id: tenantId } }, async (client) => {
    await client.query(
      `INSERT INTO iam.user_email_pref (tenant_id, user_id, kind, enabled, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, user_id, kind) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             updated_at = now()`,
      [tenantId, userId, kind, !!enabled],
    );
  });
  bustCache(tenantId, userId);
}

export function defaultForKind(kind) {
  return DEFAULTS[kind] ?? true;
}
