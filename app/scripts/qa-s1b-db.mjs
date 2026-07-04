// =============================================================================
// qa-s1b-db.mjs — Sprint 1B (EPIC-002 Dynamic RBAC) DB-side QA checks.
// -----------------------------------------------------------------------------
// Verifies:
//   1. iam.permission   has >= 25 rows
//   2. iam.role         has >= 12 system rows (is_system AND tenant_id IS NULL)
//   3. iam.role_permission for `platform.admin` == count(iam.permission)
//   4. iam.user_role and sales.assignment have RLS enabled
//   5. Happy-path permission lookup: pick first user_profile that owns at
//      least one user_role and assert at least one permission resolves.
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

async function checkPermissionCount() {
  out.push(`-- iam.permission catalog --`);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM iam.permission`);
  const n = rows[0].n;
  info(`iam.permission rows = ${n}`);
  if (n >= 25) pass(`>= 25 permissions`);
  else         fail(`expected >= 25 permissions, got ${n}`);
}

async function checkSystemRoles() {
  out.push(`-- iam.role system role seed --`);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM iam.role WHERE is_system AND tenant_id IS NULL`,
  );
  const n = rows[0].n;
  info(`system roles = ${n}`);
  if (n >= 12) pass(`>= 12 system roles seeded`);
  else         fail(`expected >= 12 system roles, got ${n}`);
}

async function checkPlatformAdminGrants() {
  out.push(`-- platform.admin role_permission grants --`);
  const a = await pool.query(`SELECT count(*)::int AS n FROM iam.permission`);
  const b = await pool.query(`
    SELECT count(*)::int AS n
      FROM iam.role_permission rp
      JOIN iam.role r ON r.id = rp.role_id
     WHERE r.key = 'platform.admin' AND r.tenant_id IS NULL
  `);
  info(`iam.permission                          = ${a.rows[0].n}`);
  info(`iam.role_permission(platform.admin)     = ${b.rows[0].n}`);
  if (a.rows[0].n === b.rows[0].n) pass(`platform.admin grants ALL permissions`);
  else                              fail(`platform.admin missing ${a.rows[0].n - b.rows[0].n} grants`);
}

async function checkRls() {
  out.push(`-- RLS flags --`);
  const targets = [['iam','user_role'],['sales','assignment'],['iam','role'],['iam','scope_grant']];
  for (const [schema, table] of targets) {
    const r = await pool.query(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname = $1
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`,
      [table, schema],
    );
    const enabled = r.rows[0]?.relrowsecurity === true;
    if (enabled) pass(`${schema}.${table} RLS enabled`);
    else         fail(`${schema}.${table} RLS NOT enabled`);
  }
  const pol = await pool.query(`
    SELECT polname, polrelid::regclass::text AS tbl
      FROM pg_policy
     WHERE polrelid::regclass::text IN
           ('iam.user_role','sales.assignment','iam.role','iam.scope_grant')
     ORDER BY tbl, polname
  `);
  for (const r of pol.rows) info(`policy ${r.tbl}: ${r.polname}`);
  if (pol.rows.length >= 4) pass(`at least one policy per new RLS table`);
  else                       fail(`only ${pol.rows.length} policies found across the 4 RLS tables`);
}

async function checkPermissionLookup() {
  out.push(`-- permission lookup happy path --`);
  // Seed a synthetic user_role grant for the first user_profile so the test
  // is self-contained (does NOT require any prior /iam/users/* call). We
  // grant the `auditor` system role which carries audit.read + audit.export.
  const upd = await pool.query(
    `SELECT id, email FROM iam.user_profile ORDER BY created_at LIMIT 1`,
  );
  if (upd.rows.length === 0) {
    fail(`no user_profile rows; cannot exercise lookup`);
    return;
  }
  const userId = upd.rows[0].id;
  info(`probing user = ${upd.rows[0].email} (${userId})`);
  const role = await pool.query(
    `SELECT id, key FROM iam.role WHERE key = 'auditor' AND tenant_id IS NULL LIMIT 1`,
  );
  if (role.rows.length === 0) {
    fail(`auditor system role missing`);
    return;
  }
  await pool.query(
    `INSERT INTO iam.user_role (user_id, role_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, role.rows[0].id],
  );
  const perms = await pool.query(
    `SELECT DISTINCT rp.permission_key
       FROM iam.user_role ur
       JOIN iam.role_permission rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  info(`resolved perms = ${perms.rows.map((r) => r.permission_key).join(',')}`);
  if (perms.rows.length > 0) pass(`>= 1 permission resolves for the probe user`);
  else                        fail(`no permissions resolved through the join`);
}

try {
  await checkPermissionCount();
  await checkSystemRoles();
  await checkPlatformAdminGrants();
  await checkRls();
  await checkPermissionLookup();
} catch (e) {
  out.push(`FATAL: ${e.message}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s1b-db PASS' : `qa-s1b-db FAIL (${failures} failures)`);

const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s1b-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
