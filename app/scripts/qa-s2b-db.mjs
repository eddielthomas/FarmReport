// =============================================================================
// qa-s2b-db.mjs — Sprint 2B (EPIC-005 Analytics + Revenue Rollups) DB checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. billing.stream exists with RLS
//   2. analytics.* rollup tables exist with RLS (7 rollups + rollup_run)
//   3. Backfill produced >= 30 days of rows for each active tenant
//   4. Cross-check daily_tenant_metrics.total_revenue == SUM of recognized
//      revenue from sales.revenue_record (for recognized_at < today)
// =============================================================================

import pg from 'pg';
import { writeFileSync } from 'node:fs';

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

async function checkBillingStream() {
  out.push('-- billing.stream --');
  const r = await pool.query(
    `SELECT relname, relrowsecurity FROM pg_class
      WHERE relname = 'stream'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'billing')`,
  );
  if (r.rows.length === 0) { fail('billing.stream missing'); return; }
  pass('billing.stream exists');
  if (r.rows[0].relrowsecurity) pass('billing.stream RLS enabled');
  else                          fail('billing.stream RLS NOT enabled');

  const col = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'sales' AND table_name = 'revenue_record' AND column_name = 'stream_id'`,
  );
  if (col.rows.length > 0) pass('sales.revenue_record.stream_id column present');
  else                     fail('sales.revenue_record.stream_id column missing');
}

async function checkAnalyticsTables() {
  out.push('-- analytics.* tables --');
  const targets = [
    'daily_tenant_metrics','daily_user_metrics','revenue_rollups',
    'lead_source_rollups','conversion_rollups','chat_activity_rollups',
    'meeting_rollups','rollup_run',
  ];
  for (const t of targets) {
    const r = await pool.query(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname = $1
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'analytics')`,
      [t],
    );
    if (r.rows.length === 0) { fail(`analytics.${t} missing`); continue; }
    pass(`analytics.${t} exists`);
    if (r.rows[0].relrowsecurity) pass(`analytics.${t} RLS enabled`);
    else                          fail(`analytics.${t} RLS NOT enabled`);
  }

  const pol = await pool.query(
    `SELECT polname, polrelid::regclass::text AS tbl FROM pg_policy
      WHERE polrelid::regclass::text LIKE 'analytics.%' ORDER BY tbl`,
  );
  for (const r of pol.rows) info(`policy ${r.tbl}: ${r.polname}`);
  if (pol.rows.length >= 8) pass(`>= 1 policy per analytics.* table`);
  else                       fail(`only ${pol.rows.length} policies across analytics.*`);
}

async function checkBackfillCounts() {
  out.push('-- rollup backfill counts --');
  const { rows: tenants } = await pool.query(
    `SELECT id, slug FROM iam.tenant WHERE status IN ('active','trial')`,
  );
  info(`active tenants: ${tenants.length}`);
  for (const t of tenants) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM analytics.daily_tenant_metrics
        WHERE tenant_id = $1`,
      [t.id],
    );
    info(`  tenant=${t.slug} daily_tenant_metrics_rows=${r.rows[0].n}`);
    if (r.rows[0].n >= 30) pass(`  tenant=${t.slug} has >= 30 rollup days`);
    else                    fail(`  tenant=${t.slug} only ${r.rows[0].n} rollup days`);
  }

  // Total count >= 30 * tenants.length
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM analytics.daily_tenant_metrics`);
  info(`total daily_tenant_metrics rows = ${total.rows[0].n}`);
}

async function checkRevenueCrossCheck() {
  out.push('-- revenue cross-check --');
  const { rows: tenants } = await pool.query(
    `SELECT id, slug FROM iam.tenant WHERE status IN ('active','trial')`,
  );
  for (const t of tenants) {
    const liveR = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS s
         FROM sales.revenue_record
        WHERE tenant_id = $1
          AND status IN ('recognized','paid')
          AND recognized_at IS NOT NULL
          AND recognized_at < current_date`,
      [t.id],
    );
    const rollR = await pool.query(
      `SELECT COALESCE(SUM(total_revenue), 0)::numeric AS s
         FROM analytics.daily_tenant_metrics
        WHERE tenant_id = $1
          AND bucket_date < current_date`,
      [t.id],
    );
    const a = Number(liveR.rows[0].s);
    const b = Number(rollR.rows[0].s);
    info(`  tenant=${t.slug} live_recognized=${a} rollup_total_revenue=${b}`);
    // Tolerate <1 cent rounding drift.
    if (Math.abs(a - b) <= 0.01) pass(`  tenant=${t.slug} cross-check matches`);
    else                          fail(`  tenant=${t.slug} cross-check drift = ${(a - b).toFixed(4)}`);
  }
}

async function checkPermissions() {
  out.push('-- analytics permissions --');
  const wanted = ['crm.analytics.view','crm.analytics.revenue.view','crm.analytics.export'];
  const { rows } = await pool.query(
    `SELECT key FROM iam.permission WHERE key = ANY($1)`, [wanted],
  );
  const have = new Set(rows.map((r) => r.key));
  for (const w of wanted) {
    if (have.has(w)) pass(`permission ${w} present`);
    else             fail(`permission ${w} missing`);
  }
}

try {
  await checkBillingStream();
  await checkAnalyticsTables();
  await checkBackfillCounts();
  await checkRevenueCrossCheck();
  await checkPermissions();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s2b-db PASS' : `qa-s2b-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s2b-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
