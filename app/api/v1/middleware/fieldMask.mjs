// =============================================================================
// fieldMask.mjs — per-role field-level masking (Sprint 1B / EPIC-002).
// -----------------------------------------------------------------------------
// Loads iam.field_policy on demand (lazy first-call; 60s refresh thereafter).
// Exposes applyFieldMask(req, resource, payload) which mutates the returned
// payload according to the most-restrictive policy across the caller's
// roleKeys for the given (resource, field).
//
//   action 'read'  -> keep value
//   action 'mask'  -> redact (e-mail keeps first letter; phones/long strings
//                     keep first two + last two characters; other types null)
//   action 'deny'  -> delete property entirely
//
// platform.admin bypass: callers carrying the `platform.admin.all` permission
// (or the legacy `platform:admin` role) get the unmasked payload.
//
// Cache shape: Map<`${role_key}|${resource}`, Map<field, action>>.
// =============================================================================

import { q } from '../db/pool.mjs';

const CACHE_TTL_MS = 60 * 1000;
let cacheAt = 0;
const cache = new Map();

const ACTION_RANK = { read: 0, mask: 1, deny: 2 };

export function _peekCache() { return cache; }
export function invalidateFieldPolicy() { cacheAt = 0; cache.clear(); }

async function refresh() {
  const { rows } = await q(
    `SELECT role_key, resource, field, action FROM iam.field_policy`,
  );
  cache.clear();
  for (const r of rows) {
    const k = `${r.role_key}|${r.resource}`;
    let m = cache.get(k);
    if (!m) { m = new Map(); cache.set(k, m); }
    m.set(r.field, r.action);
  }
  cacheAt = Date.now();
}

async function ensureFresh() {
  if (Date.now() - cacheAt < CACHE_TTL_MS) return;
  try {
    await refresh();
  } catch (err) {
    console.error('[fieldMask] refresh_failed:', err?.message ?? err);
    // Leave the previous cache in place; better stale-and-restrictive than
    // erroring out a request.
    cacheAt = Date.now();
  }
}

function redact(v) {
  if (v == null) return v;
  if (typeof v !== 'string') {
    // Non-strings cannot be partially redacted safely; drop to null.
    return null;
  }
  if (v.includes('@')) {
    const [u, d] = v.split('@');
    if (!u || !d) return '***';
    return `${u[0] ?? ''}***@${d}`;
  }
  if (v.length <= 4) return '****';
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

function maskOne(row, mergedPolicy) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const [field, action] of mergedPolicy) {
    if (action === 'deny') delete out[field];
    else if (action === 'mask') {
      if (Object.prototype.hasOwnProperty.call(out, field)) {
        out[field] = redact(out[field]);
      }
    }
  }
  return out;
}

// Build the most-restrictive merged policy across the caller's roleKeys for
// the given resource. Returns null when no policy applies (caller can short
// circuit and return rows untouched).
function mergedPolicyFor(roleKeys, resource) {
  if (!Array.isArray(roleKeys) || roleKeys.length === 0) return null;
  const merged = new Map();
  for (const role of roleKeys) {
    const p = cache.get(`${role}|${resource}`);
    if (!p) continue;
    for (const [field, action] of p) {
      const prev = merged.get(field);
      if (!prev || ACTION_RANK[action] > ACTION_RANK[prev]) {
        merged.set(field, action);
      }
    }
  }
  return merged.size === 0 ? null : merged;
}

// Synchronous mask using the in-memory cache. Returns mutated payload or the
// original (untouched) reference when no policy applies.
export function applyFieldMaskSync(req, resource, payload) {
  if (payload == null) return payload;
  const perms = req?.user?.permissions;
  if (perms && perms.has('platform.admin.all')) return payload;
  const legacyRoles = req?.user?.roles ?? [];
  if (legacyRoles.includes('platform:admin')) return payload;

  const roleKeys = req?.user?.roleKeys ?? [];
  // Also consider legacy role names as field-policy keys (vendor:view ->
  // vendor.viewer was already mapped into roleKeys by policy.mjs).
  const policy = mergedPolicyFor(roleKeys, resource);
  if (!policy) return payload;
  return Array.isArray(payload)
    ? payload.map((r) => maskOne(r, policy))
    : maskOne(payload, policy);
}

// Async variant — primes the cache on first call. Use this from request paths
// that don't know whether a previous request has populated the cache.
export async function applyFieldMask(req, resource, payload) {
  await ensureFresh();
  return applyFieldMaskSync(req, resource, payload);
}
