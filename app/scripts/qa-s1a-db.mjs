// =============================================================================
// qa-s1a-db.mjs — Sprint 1A (CRM EPIC-001 Phase F-2) DB-side QA checks.
// -----------------------------------------------------------------------------
// Verifies:
//   1. iam.tenant has the new registry columns (classification, isolation_mode,
//      region, data_residency, feature_flags, parent_tenant_id, dedicated_dsn,
//      schema_name, contract_starts_at, contract_ends_at, deleted_at).
//   2. iam.tenant_feature_flag / iam.tenant_alias / iam.identity /
//      iam.tenant_membership / iam.token_revocation / iam.tenant_suspension
//      tables exist.
//   3. iam.tenant_membership has RLS enabled with a tenant-isolation policy.
//   4. Backfill:
//        count(iam.identity)            >= count(distinct email from iam.user_profile)
//        count(iam.tenant_membership)   >= count(iam.user_profile)
//
// Mirrors the qa-s0-db.mjs pattern: writes to .qa-s1a-db-out.txt and echoes.
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

const REQUIRED_TENANT_COLS = [
  'classification',
  'isolation_mode',
  'region',
  'data_residency',
  'feature_flags',
  'parent_tenant_id',
  'dedicated_dsn',
  'schema_name',
  'contract_starts_at',
  'contract_ends_at',
  'deleted_at',
];

const REQUIRED_TABLES = [
  ['iam', 'tenant_feature_flag'],
  ['iam', 'tenant_alias'],
  ['iam', 'identity'],
  ['iam', 'tenant_membership'],
  ['iam', 'token_revocation'],
  ['iam', 'tenant_suspension'],
];

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }

async function checkTenantColumns() {
  out.push(`-- iam.tenant new columns --`);
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'iam' AND table_name = 'tenant'
  `);
  const present = new Set(rows.map((r) => r.column_name));
  for (const col of REQUIRED_TENANT_COLS) {
    if (present.has(col)) pass(`iam.tenant.${col}`);
    else fail(`missing iam.tenant.${col}`);
  }
}

async function checkTables() {
  out.push(`-- required tables --`);
  for (const [schema, table] of REQUIRED_TABLES) {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2`,
      [schema, table],
    );
    if (rows.length > 0) pass(`${schema}.${table}`);
    else fail(`missing table ${schema}.${table}`);
  }
}

async function checkRls() {
  out.push(`-- iam.tenant_membership RLS --`);
  const r = await pool.query(`
    SELECT relrowsecurity FROM pg_class
     WHERE relname = 'tenant_membership'
       AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'iam')
  `);
  const enabled = r.rows[0]?.relrowsecurity === true;
  if (enabled) pass(`iam.tenant_membership RLS enabled`);
  else         fail(`iam.tenant_membership RLS NOT enabled`);

  const p = await pool.query(`
    SELECT polname FROM pg_policy
     WHERE polrelid = 'iam.tenant_membership'::regclass
  `);
  const polNames = p.rows.map((row) => row.polname);
  if (polNames.length > 0) pass(`iam.tenant_membership policies: ${polNames.join(', ')}`);
  else                     fail(`iam.tenant_membership has no policies`);
}

async function checkBackfill() {
  out.push(`-- backfill counts --`);
  const id     = await pool.query(`SELECT count(*)::int AS n FROM iam.identity`);
  const upd    = await pool.query(`SELECT count(DISTINCT email)::int AS n FROM iam.user_profile`);
  const mem    = await pool.query(`SELECT count(*)::int AS n FROM iam.tenant_membership`);
  const up     = await pool.query(`SELECT count(*)::int AS n FROM iam.user_profile`);
  out.push(`  iam.identity              = ${id.rows[0].n}`);
  out.push(`  distinct emails in up     = ${upd.rows[0].n}`);
  out.push(`  iam.tenant_membership     = ${mem.rows[0].n}`);
  out.push(`  iam.user_profile          = ${up.rows[0].n}`);
  if (id.rows[0].n >= upd.rows[0].n) pass(`identity >= distinct emails`);
  else                               fail(`identity (${id.rows[0].n}) < distinct emails (${upd.rows[0].n})`);
  if (mem.rows[0].n >= up.rows[0].n) pass(`tenant_membership >= user_profile`);
  else                               fail(`tenant_membership (${mem.rows[0].n}) < user_profile (${up.rows[0].n})`);
}

async function checkConstraints() {
  out.push(`-- iam.tenant check constraints --`);
  const { rows } = await pool.query(`
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'iam.tenant'::regclass AND contype = 'c'
  `);
  const names = new Set(rows.map((r) => r.conname));
  for (const c of ['tenant_classification_chk','tenant_isolation_mode_chk','tenant_status_chk']) {
    if (names.has(c)) pass(c);
    else fail(`missing constraint ${c}`);
  }
}

try {
  await checkTenantColumns();
  await checkConstraints();
  await checkTables();
  await checkRls();
  await checkBackfill();
} catch (e) {
  out.push(`FATAL: ${e.message}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s1a-db PASS' : `qa-s1a-db FAIL (${failures} failures)`);

const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s1a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
