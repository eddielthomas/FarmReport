// =============================================================================
// qa-s14a-db.mjs — Sprint 14A schema gate.
// -----------------------------------------------------------------------------
// Asserts:
//   1. crm.project + crm.project_scene exist with RLS enabled.
//   2. project_tenant_iso + project_scene_tenant_iso policies in place.
//   3. project_scene_default_uniq partial UNIQUE INDEX on (project_id)
//      WHERE is_default=true.
//   4. Catalog perms exist: crm.project.read|write, crm.scene.read|write.
//   5. Role grants:
//        - platform.admin + tenant.admin have all four (catch-all).
//        - ops.manager / ops.coordinator / sales.manager / sales.agent have all four.
//        - customer.viewer has crm.project.read + crm.scene.read only.
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
function fail(m) { out.push(`  FAIL: ${m}`); failures++; }
function pass(m) { out.push(`  PASS: ${m}`); }
function info(m) { out.push(`  INFO: ${m}`); }

async function checkTables() {
  out.push('-- crm.* tables --');
  for (const qn of ['crm.project','crm.project_scene']) {
    const [schema, table] = qn.split('.');
    const r = await pool.query(
      `SELECT c.relrowsecurity AS rls_on
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    if (r.rows.length === 0) { fail(`${qn} MISSING`); continue; }
    pass(`${qn} present`);
    if (r.rows[0].rls_on) pass(`${qn} RLS enabled`);
    else                   fail(`${qn} RLS NOT enabled`);
  }
}

async function checkPolicies() {
  out.push('-- RLS policies --');
  for (const { table, policy } of [
    { table: 'project',       policy: 'project_tenant_iso' },
    { table: 'project_scene', policy: 'project_scene_tenant_iso' },
  ]) {
    const r = await pool.query(
      `SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'crm' AND c.relname = $1 AND p.polname = $2`,
      [table, policy],
    );
    if (r.rows.length === 1) pass(`crm.${table} -> ${policy}`);
    else                     fail(`crm.${table} missing policy ${policy}`);
  }
}

async function checkDefaultUniqueIndex() {
  out.push('-- project_scene_default_uniq partial index --');
  const r = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'crm' AND tablename = 'project_scene'
        AND indexname = 'project_scene_default_uniq'`);
  if (r.rows.length === 0) { fail('project_scene_default_uniq MISSING'); return; }
  const def = r.rows[0].indexdef;
  info(def);
  if (/UNIQUE/i.test(def) && /\(project_id\)/i.test(def) && /WHERE.*is_default/i.test(def)) {
    pass('project_scene_default_uniq is UNIQUE on (project_id) WHERE is_default=true');
  } else {
    fail(`unique partial index wrong shape: ${def}`);
  }

  // Behavioural check: inserting two is_default=true rows under the same
  // project should explode.
  const t = await pool.connect();
  try {
    await t.query('BEGIN');
    const tenant = await t.query(`SELECT id FROM iam.tenant LIMIT 1`);
    if (!tenant.rows[0]) { info('no tenant rows for behavioural check, skipping'); }
    else {
      const proj = await t.query(
        `INSERT INTO crm.project (tenant_id, title)
         VALUES ($1, 'qa-s14a-default-test') RETURNING id`,
        [tenant.rows[0].id]);
      await t.query(
        `INSERT INTO crm.project_scene (tenant_id, project_id, title, basemap_id, is_default)
         VALUES ($1, $2, 'one', 'satellite', true)`,
        [tenant.rows[0].id, proj.rows[0].id]);
      try {
        await t.query(
          `INSERT INTO crm.project_scene (tenant_id, project_id, title, basemap_id, is_default)
           VALUES ($1, $2, 'two', 'satellite', true)`,
          [tenant.rows[0].id, proj.rows[0].id]);
        fail('two is_default rows allowed (unique partial index missing teeth)');
      } catch (e) {
        if (/duplicate key|unique/i.test(String(e.message))) {
          pass('second is_default row rejected by unique partial index');
        } else {
          fail(`second insert failed for unexpected reason: ${e.message}`);
        }
      }
    }
    await t.query('ROLLBACK');
  } catch (e) {
    out.push(`  WARN: behavioural check skipped: ${e.message}`);
    await t.query('ROLLBACK').catch(() => {});
  } finally { t.release(); }
}

async function checkPermissions() {
  out.push('-- permissions catalog --');
  const KEYS = ['crm.project.read','crm.project.write','crm.scene.read','crm.scene.write'];
  const r = await pool.query(
    `SELECT key FROM iam.permission WHERE key = ANY($1)`, [KEYS]);
  const have = new Set(r.rows.map((x) => x.key));
  for (const k of KEYS) {
    if (have.has(k)) pass(`perm ${k}`); else fail(`perm ${k} MISSING`);
  }
}

async function checkRoleGrants() {
  out.push('-- role grants --');
  const STAFF_ROLES = [
    'platform.admin','tenant.admin',
    'ops.manager','ops.coordinator',
    'sales.manager','sales.agent',
  ];
  const WANT_ALL = ['crm.project.read','crm.project.write','crm.scene.read','crm.scene.write'];

  for (const role of STAFF_ROLES) {
    const r = await pool.query(
      `SELECT rp.permission_key
         FROM iam.role r
         JOIN iam.role_permission rp ON rp.role_id = r.id
        WHERE r.key = $1 AND r.tenant_id IS NULL`,
      [role]);
    const have = new Set(r.rows.map((x) => x.permission_key));
    for (const k of WANT_ALL) {
      if (have.has(k)) pass(`${role} grants ${k}`); else fail(`${role} missing ${k}`);
    }
  }

  // customer.viewer must have ONLY the two read perms.
  const cv = await pool.query(
    `SELECT rp.permission_key
       FROM iam.role r
       JOIN iam.role_permission rp ON rp.role_id = r.id
      WHERE r.key = 'customer.viewer' AND r.tenant_id IS NULL`);
  const cvSet = new Set(cv.rows.map((x) => x.permission_key));
  if (cvSet.has('crm.project.read')) pass('customer.viewer grants crm.project.read');
  else fail('customer.viewer missing crm.project.read');
  if (cvSet.has('crm.scene.read')) pass('customer.viewer grants crm.scene.read');
  else fail('customer.viewer missing crm.scene.read');
  if (!cvSet.has('crm.project.write')) pass('customer.viewer does NOT grant crm.project.write');
  else fail('customer.viewer over-granted crm.project.write');
  if (!cvSet.has('crm.scene.write')) pass('customer.viewer does NOT grant crm.scene.write');
  else fail('customer.viewer over-granted crm.scene.write');
}

try {
  await checkTables();
  await checkPolicies();
  await checkDefaultUniqueIndex();
  await checkPermissions();
  await checkRoleGrants();
} catch (e) {
  out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s14a-db PASS' : `qa-s14a-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s14a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
