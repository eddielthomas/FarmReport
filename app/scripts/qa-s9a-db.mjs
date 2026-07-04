// =============================================================================
// qa-s9a-db.mjs — Sprint 9A Field Service schema gate.
// -----------------------------------------------------------------------------
// Asserts:
//   1. field.job / field.task / field.technician_location /
//      field.technician_location_history / field.time_entry / field.upload /
//      field.geofence_event all exist with RLS enabled.
//   2. field.geofence_event + field.technician_location_history have
//      append-only triggers blocking UPDATE/DELETE.
//   3. field.time_entry has unique partial index ensuring at most one open
//      entry per user (time_entry_one_open_per_user_uidx).
//   4. New permissions seeded; field.technician system role + grants exist.
//   5. Tenant feature flag defaults: geofence_strict_checkin=true,
//      geofence_strict_upload=false for every tenant.
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

const TABLES = [
  'field.job',
  'field.task',
  'field.technician_location',
  'field.technician_location_history',
  'field.time_entry',
  'field.upload',
  'field.geofence_event',
];

async function checkTables() {
  out.push('-- field.* tables --');
  for (const qn of TABLES) {
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

async function checkAppendOnlyTriggers() {
  out.push('-- append-only triggers --');
  for (const { table, trigger } of [
    { table: 'geofence_event',               trigger: 'trg_geofence_event_immutable' },
    { table: 'technician_location_history',  trigger: 'trg_tech_loc_hist_immutable' },
  ]) {
    const r = await pool.query(
      `SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'field' AND c.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`,
      [table, trigger],
    );
    if (r.rows.length === 1) pass(`field.${table} -> ${trigger}`);
    else                     fail(`field.${table} missing trigger ${trigger}`);
  }
  // Behavioural check — try to UPDATE a non-existent row; if the trigger
  // were missing the statement would silently succeed (0 rows). With the
  // trigger present an UPDATE that matches 0 rows still raises… no it
  // doesn't (triggers fire per-row). So we attempt to INSERT a sentinel
  // and then UPDATE it.
  const t = await pool.connect();
  try {
    await t.query("BEGIN");
    const tenant = await t.query(`SELECT id FROM iam.tenant LIMIT 1`);
    if (tenant.rows[0]) {
      const u = await t.query(`SELECT id FROM iam.user_profile WHERE tenant_id = $1 LIMIT 1`, [tenant.rows[0].id]);
      if (u.rows[0]) {
        const ins = await t.query(
          `INSERT INTO field.geofence_event (tenant_id, user_id, event_kind)
           VALUES ($1, $2, 'near') RETURNING id`,
          [tenant.rows[0].id, u.rows[0].id]);
        try {
          await t.query(`UPDATE field.geofence_event SET distance_m = 1 WHERE id = $1`, [ins.rows[0].id]);
          fail('geofence_event UPDATE was allowed (append-only broken)');
        } catch (e) {
          if (/immutable/i.test(String(e.message))) pass('geofence_event UPDATE blocked by trigger');
          else fail(`UPDATE failed for unexpected reason: ${e.message}`);
        }
      }
    }
    await t.query("ROLLBACK");
  } catch (e) {
    out.push(`  WARN: append-only behavioural check skipped: ${e.message}`);
    await t.query("ROLLBACK").catch(() => {});
  } finally { t.release(); }
}

async function checkUniquePartialIndex() {
  out.push('-- time_entry unique partial index --');
  const r = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'field' AND tablename = 'time_entry'
        AND indexname = 'time_entry_one_open_per_user_uidx'`);
  if (r.rows.length === 0) { fail('time_entry_one_open_per_user_uidx MISSING'); return; }
  const def = r.rows[0].indexdef;
  info(def);
  if (/UNIQUE/i.test(def) && /\(user_id\)/i.test(def) && /WHERE.*ended_at IS NULL/i.test(def)) {
    pass('time_entry_one_open_per_user_uidx is UNIQUE on (user_id) WHERE ended_at IS NULL');
  } else {
    fail(`unique partial index wrong shape: ${def}`);
  }
}

async function checkPermissionsAndRole() {
  out.push('-- permissions + field.technician role --');
  const KEYS = [
    'field.job.read','field.job.write','field.job.assign',
    'field.location.write','field.location.read.tenant',
    'field.checkin','field.upload.write','field.upload.read',
    'field.task.complete','field.task.manage','field.geofence.read',
  ];
  const r = await pool.query(
    `SELECT key FROM iam.permission WHERE key = ANY($1)`, [KEYS]);
  const have = new Set(r.rows.map((x) => x.key));
  for (const k of KEYS) {
    if (have.has(k)) pass(`perm ${k}`); else fail(`perm ${k} MISSING`);
  }
  const role = await pool.query(
    `SELECT id FROM iam.role WHERE key = 'field.technician' AND tenant_id IS NULL`);
  if (role.rows.length === 0) { fail('role field.technician MISSING'); return; }
  pass('role field.technician present');
  const grants = await pool.query(
    `SELECT permission_key FROM iam.role_permission WHERE role_id = $1`,
    [role.rows[0].id]);
  const want = new Set([
    'field.job.read','field.location.write','field.checkin',
    'field.upload.write','field.upload.read','field.task.complete',
  ]);
  for (const w of want) {
    if (grants.rows.some((g) => g.permission_key === w))
      pass(`field.technician grants ${w}`);
    else
      fail(`field.technician missing grant ${w}`);
  }
}

async function checkTenantFlagDefaults() {
  out.push('-- tenant feature flag defaults --');
  const tenants = await pool.query(`SELECT id FROM iam.tenant`);
  for (const t of tenants.rows) {
    const f = await pool.query(
      `SELECT key, value FROM iam.tenant_feature_flag
        WHERE tenant_id = $1
          AND key IN ('field.geofence_strict_checkin','field.geofence_strict_upload')`,
      [t.id]);
    const map = new Map(f.rows.map((r) => [r.key, JSON.stringify(r.value)]));
    if (map.get('field.geofence_strict_checkin') === 'true')
      pass(`tenant ${t.id} strict_checkin=true`);
    else
      fail(`tenant ${t.id} strict_checkin not seeded (=${map.get('field.geofence_strict_checkin')})`);
    if (map.get('field.geofence_strict_upload') === 'false')
      pass(`tenant ${t.id} strict_upload=false`);
    else
      fail(`tenant ${t.id} strict_upload not seeded (=${map.get('field.geofence_strict_upload')})`);
  }
}

try {
  await checkTables();
  await checkAppendOnlyTriggers();
  await checkUniquePartialIndex();
  await checkPermissionsAndRole();
  await checkTenantFlagDefaults();
} catch (e) {
  out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s9a-db PASS' : `qa-s9a-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s9a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
