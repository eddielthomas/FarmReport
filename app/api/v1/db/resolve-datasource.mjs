// =============================================================================
// resolve-datasource.mjs — OperationsOS A4 dedicated-isolation datasource router
// -----------------------------------------------------------------------------
// Maps a request's tenant to the pg Pool that should serve its queries:
//
//   isolation_mode='row-level' (default) | 'schema'  -> the SHARED pool.
//   isolation_mode='dedicated'                        -> a per-tenant Pool built
//       from a DSN in env var  RWR_DEDICATED_DSN_<SLUG>  (slug upper-cased,
//       non-alphanumerics -> '_'). If that env var is unset (the local case —
//       no dedicated DB exists), we log a one-time warning and FALL BACK to the
//       shared pool so behaviour is never worse than pooled.
//
// `isolation_mode` originates in iam.tenant (113_iam_tenant_registry.sql); the
// allowed values are 'row-level' | 'schema' | 'dedicated'. We treat anything
// other than 'dedicated' as the shared path. The default (shared) path is
// byte-identical to the prior hardcoded pool.connect() — no new round-trips.
//
// Dedicated pools are created lazily and cached per DSN. We never require a
// real dedicated DB to exist; the resolver degrades gracefully.
// =============================================================================

import pg from 'pg';

// The shared/pooled datasource. Imported lazily to avoid a circular import with
// pool.mjs (pool.mjs imports resolvePool; we import its `pool` only on demand).
let _sharedPool = null;
async function sharedPool() {
  if (!_sharedPool) {
    const mod = await import('./pool.mjs');
    _sharedPool = mod.pool;
  }
  return _sharedPool;
}

// Cache of dedicated pools keyed by DSN so we reuse connections.
const _dedicatedPools = new Map();
// Track which slugs we have already warned about (avoid log spam).
const _warnedSlugs = new Set();

// RWR_DEDICATED_DSN_<SLUG>  — slug normalised the same way deploy tooling does.
function dsnEnvKey(slug) {
  const norm = String(slug || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `RWR_DEDICATED_DSN_${norm}`;
}

function dedicatedPoolForDsn(dsn) {
  let p = _dedicatedPools.get(dsn);
  if (!p) {
    p = new pg.Pool({
      connectionString: dsn,
      max: Number(process.env.PGPOOL_MAX_DEDICATED ?? 5),
    });
    _dedicatedPools.set(dsn, p);
  }
  return p;
}

// resolvePool(tenant) -> a pg Pool (synchronous; returns the shared pool object
// directly for the default path, or null if it cannot yet be resolved, in which
// case the caller falls back to its own shared pool reference).
//
// `tenant` is the request's tenant object. We read isolation_mode + slug from
// it; both may be absent on minimal tenant objects, in which case we take the
// shared path.
export function resolvePool(tenant) {
  const mode = tenant?.isolation_mode ?? tenant?.isolationMode ?? 'row-level';

  // Default / shared path. Return null so the caller uses its already-imported
  // shared `pool` reference (keeps the hot path free of an async import).
  if (mode !== 'dedicated') return null;

  const slug = tenant?.slug ?? tenant?.tenant_slug ?? '';
  const key = dsnEnvKey(slug);
  const dsn = process.env[key];

  if (!dsn) {
    if (!_warnedSlugs.has(slug)) {
      _warnedSlugs.add(slug);
      console.warn(
        `[resolve-datasource] tenant '${slug}' is isolation_mode=dedicated but ` +
          `${key} is unset; falling back to the shared pool. ` +
          `(No dedicated DB configured in this environment.)`,
      );
    }
    return null; // fall back to shared pool
  }

  return dedicatedPoolForDsn(dsn);
}

// Async variant for callers that want the resolved Pool object explicitly
// (returns the shared pool rather than null on the default path). Not used on
// the hot request path; provided for tooling/tests.
export async function resolvePoolAsync(tenant) {
  return resolvePool(tenant) ?? (await sharedPool());
}

// Test/diagnostic helper: which env key would a slug map to.
export function _dsnEnvKeyForTest(slug) {
  return dsnEnvKey(slug);
}
