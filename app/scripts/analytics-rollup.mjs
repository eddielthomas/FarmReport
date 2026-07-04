#!/usr/bin/env node
// =============================================================================
// scripts/analytics-rollup.mjs — CLI backfill / refresh for analytics rollups.
// -----------------------------------------------------------------------------
// Usage:
//   node scripts/analytics-rollup.mjs --tenant <uuid|all> --from YYYY-MM-DD --to YYYY-MM-DD
//
// Defaults: --tenant all, last 90 days ending today.
// Idempotent — each (tenant, day) UPSERTs into 7 analytics.* rollup tables.
// =============================================================================

import pg from 'pg';
import { computeTenantBackfill } from '../api/v1/analytics/rollup.mjs';

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);

function parseArgs(argv) {
  const out = { tenant: 'all', from: null, to: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant')   out.tenant = argv[++i];
    else if (a === '--from') out.from  = argv[++i];
    else if (a === '--to')   out.to    = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/analytics-rollup.mjs --tenant <uuid|all> --from YYYY-MM-DD --to YYYY-MM-DD');
      process.exit(0);
    }
  }
  if (!out.to) out.to = new Date().toISOString().slice(0, 10);
  if (!out.from) {
    const d = new Date(out.to + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 89);
    out.from = d.toISOString().slice(0, 10);
  }
  return out;
}

async function listTenants(filter) {
  if (filter && filter !== 'all') {
    return [{ id: filter, slug: '(arg)' }];
  }
  const { rows } = await pool.query(
    `SELECT id, slug FROM iam.tenant WHERE status IN ('active','trial') ORDER BY slug`,
  );
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const tenants = await listTenants(args.tenant);
  console.log(`analytics-rollup: ${tenants.length} tenant(s) x [${args.from} .. ${args.to}]`);
  let totalOk = 0, totalFail = 0, totalRows = 0;
  for (const t of tenants) {
    console.log(`\n-- tenant=${t.slug} id=${t.id} --`);
    const r = await computeTenantBackfill(t.id, args.from, args.to, { log: (m) => console.log(m) });
    totalOk += r.ok;
    totalFail += r.fail;
    totalRows += r.totalRows;
  }
  console.log(`\nsummary: ok=${totalOk} fail=${totalFail} rows_written=${totalRows}`);
  await pool.end();
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await pool.end().catch(() => {});
  process.exit(2);
});
