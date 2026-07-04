// =============================================================================
// /api/v1 pg pool — uses the same env defaults as api/server.mjs and exposes
// a singleton Pool plus a small q() helper.
//
// Adds withTenantConn(req, fn): checks out a client, SET LOCAL app.tenant_id
// inside a transaction so RLS policies on iam.user_profile / iam.invite (and
// future iam.tenant_membership) gate queries to the caller's tenant.
//
// Sprint 5B — extends withTenantConn to also bind:
//   app.clearance   — caller's Bell-LaPadula clearance (default 'internal')
//   app.actor_id    — caller's iam.user_profile.id
//   app.request_id  — per-request UUID for correlation in audit rows
// All four settings are SET LOCAL so they live only for the transaction. The
// classification RLS policies (139_classification.sql) consult app.clearance
// alongside app.tenant_id.
//
// OperationsOS A4 — GUC convergence + tenancy hardening:
//   * Dual-set the tenant GUC: BOTH app.tenant_id (legacy/deprecated alias) AND
//     rwr.tenant_id (canonical) are bound to the same value in the same batch.
//     app.tenant_id is INTENTIONALLY kept set this sprint so policies not yet
//     migrated to rwr.tenant_id (incl. every app.clearance-combined policy)
//     keep isolating correctly. See ADR-0021.
//   * Dedicated isolation mode: the client is obtained from resolvePool(tenant)
//     so an isolation_mode='dedicated' tenant can be routed to a per-tenant DSN.
//     Default (row-level / shared pool) path is byte-identical to before.
// =============================================================================

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resolvePool } from './resolve-datasource.mjs';

const cfg = {
  host:     process.env.PGHOST     ?? 'localhost',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
  max:      Number(process.env.PGPOOL_MAX ?? 10),
};

export const pool = new pg.Pool(cfg);

export async function q(text, params) {
  return pool.query(text, params);
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// UUID guard — refuse to pass anything weird through to set_config.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowed Bell-LaPadula values; anything else (or empty) downgrades to ''
// which the SQL lattice helper treats as NULL-equivalent (default-allow).
const CLEARANCE_SET = new Set(['public','internal','confidential','secret']);

// Run `fn(client)` inside a transaction with the standard `app.*` bindings:
//   app.tenant_id  — required (uuid)
//   app.actor_id   — optional (uuid); '' when missing
//   app.clearance  — optional ('public'|'internal'|'confidential'|'secret');
//                    '' when missing → fn_clearance_meets returns TRUE
//                    (back-compat / default-allow)
//   app.request_id — optional; falls back to a fresh uuid so audit
//                    correlation always has *something*.
// Used by routes that touch RLS-protected tables. fn receives a pg Client.
export async function withTenantConn(req, fn) {
  const tid = req?.tenant?.id;
  if (!tid || !UUID_RE.test(String(tid))) {
    throw new Error('withTenantConn_requires_tenant');
  }
  const actorId   = req?.user?.sub && UUID_RE.test(String(req.user.sub)) ? String(req.user.sub) : '';
  const clearance = CLEARANCE_SET.has(req?.user?.clearance) ? String(req.user.clearance) : '';
  const reqId     = (typeof req?.requestId === 'string' && req.requestId.length > 0 && req.requestId.length < 256)
    ? req.requestId
    : randomUUID();

  // Route to the per-tenant pool for isolation_mode='dedicated'; otherwise this
  // returns the shared pool (default path — byte-identical to the prior
  // `pool.connect()`).
  const targetPool = resolvePool(req?.tenant) ?? pool;
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    // Bind the settings in a single round-trip. set_config(setting, value,
    // is_local=true) is safer than SET LOCAL with interpolation.
    //
    // GUC convergence (A4): rwr.tenant_id is the canonical tenant GUC;
    // app.tenant_id is kept set in parallel as a deprecated alias so policies
    // not yet migrated (incl. all app.clearance-combined ones) still isolate.
    // Both MUST receive the SAME value.
    await client.query(
      `SELECT
         set_config('app.tenant_id',  $1, true),
         set_config('rwr.tenant_id',  $1, true),
         set_config('app.actor_id',   $2, true),
         set_config('app.clearance',  $3, true),
         set_config('app.request_id', $4, true)`,
      [String(tid), actorId, clearance, reqId],
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
