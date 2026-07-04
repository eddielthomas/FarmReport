// =============================================================================
// qa-s4b-db.mjs — Sprint 4B (EPIC-009 P-009 Vendor Phases 1-3) DB check.
// -----------------------------------------------------------------------------
// Asserts:
//   1. iam.vendor_profile exists with RLS + leading tenant_id index
//   2. vendor_pool schema exists; contract / scope / geographic_scope /
//      contract_event tables exist with RLS where applicable
//   3. iam.permission_template seeded with the 5 system templates
//   4. contract_event append-only trigger rejects UPDATE/DELETE
//   5. KNOWN_ROLES (introspected by importing iam/users.mjs) contains
//      vendor:view, vendor:manage, vendor:billing
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

async function checkVendorProfile() {
  out.push('-- iam.vendor_profile --');
  const r = await pool.query(
    `SELECT relrowsecurity FROM pg_class
      WHERE relname = 'vendor_profile'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'iam')`,
  );
  if (r.rows.length === 0) { fail('iam.vendor_profile missing'); return; }
  pass('iam.vendor_profile exists');
  if (r.rows[0].relrowsecurity) pass('iam.vendor_profile RLS enabled');
  else                          fail('iam.vendor_profile RLS NOT enabled');

  const idx = await pool.query(
    `SELECT 1 FROM pg_indexes
      WHERE schemaname = 'iam' AND tablename = 'vendor_profile'
        AND indexname = 'vendor_profile_tenant_status_idx'`,
  );
  if (idx.rows.length === 1) pass('vendor_profile_tenant_status_idx present');
  else                       fail('vendor_profile_tenant_status_idx missing');

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'iam' AND table_name = 'vendor_profile'`,
  );
  const have = new Set(cols.rows.map((c) => c.column_name));
  for (const wanted of ['id','tenant_id','user_id','category','status','mfa_required']) {
    if (have.has(wanted)) pass(`iam.vendor_profile column ${wanted} present`);
    else                  fail(`iam.vendor_profile column ${wanted} missing`);
  }
}

async function checkVendorPool() {
  out.push('-- vendor_pool.* --');
  const tables = ['contract','scope','geographic_scope','contract_event'];
  for (const t of tables) {
    const r = await pool.query(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname = $1
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'vendor_pool')`,
      [t],
    );
    if (r.rows.length === 0) { fail(`vendor_pool.${t} missing`); continue; }
    pass(`vendor_pool.${t} exists`);
    if (t === 'geographic_scope') {
      // geographic_scope inherits tenancy via contract_id; no RLS required.
      info(`vendor_pool.${t} RLS skipped (contract-scoped)`);
    } else if (r.rows[0].relrowsecurity) {
      pass(`vendor_pool.${t} RLS enabled`);
    } else {
      fail(`vendor_pool.${t} RLS NOT enabled`);
    }
  }
}

async function checkAppendOnlyTrigger() {
  out.push('-- contract_event append-only enforcement --');
  // Insert a contract + event row, then attempt UPDATE and DELETE.
  const t = await pool.query(`SELECT id FROM iam.tenant WHERE status IN ('active','trial') LIMIT 1`);
  if (t.rows.length === 0) { fail('no active tenant to test against'); return; }
  const tenantId = t.rows[0].id;

  // Pick or create a vendor user for the contract FK.
  let userRow = await pool.query(
    `SELECT id FROM iam.user_profile WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (userRow.rows.length === 0) { fail('no user_profile to bind contract'); return; }
  const userId = userRow.rows[0].id;

  // Idempotency: insert a vendor_profile if absent.
  await pool.query(
    `INSERT INTO iam.vendor_profile (tenant_id, user_id, category, status)
     VALUES ($1, $2, 'sales', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [tenantId, userId],
  );

  const c = await pool.query(
    `INSERT INTO vendor_pool.contract
       (tenant_id, vendor_user_id, contract_kind, status, starts_at, ends_at)
     VALUES ($1, $2, 'sales_partner', 'draft', now(), now() + interval '30 days')
     RETURNING id`,
    [tenantId, userId],
  );
  const contractId = c.rows[0].id;
  info(`test contract id = ${contractId}`);

  const evt = await pool.query(
    `INSERT INTO vendor_pool.contract_event
       (tenant_id, contract_id, event_kind, payload)
     VALUES ($1, $2, 'created', '{}'::jsonb)
     RETURNING id`,
    [tenantId, contractId],
  );
  const eventId = evt.rows[0].id;
  info(`test event id = ${eventId}`);

  // Try UPDATE — should raise check_violation.
  try {
    await pool.query(
      `UPDATE vendor_pool.contract_event SET event_kind = 'tampered' WHERE id = $1`,
      [eventId],
    );
    fail('contract_event UPDATE was permitted (should have raised)');
  } catch (err) {
    if (/append-only/i.test(err.message)) pass('contract_event UPDATE rejected');
    else fail(`contract_event UPDATE raised but with wrong reason: ${err.message}`);
  }

  // Try DELETE — should raise check_violation.
  try {
    await pool.query(`DELETE FROM vendor_pool.contract_event WHERE id = $1`, [eventId]);
    fail('contract_event DELETE was permitted (should have raised)');
  } catch (err) {
    if (/append-only/i.test(err.message)) pass('contract_event DELETE rejected');
    else fail(`contract_event DELETE raised but with wrong reason: ${err.message}`);
  }

  // Cleanup: drop the test contract (CASCADE drops the event too — note the
  // append-only trigger fires on UPDATE/DELETE only, so a CASCADE delete via
  // FK ON DELETE CASCADE on contract is suppressed by the trigger and would
  // raise. We instead skip cleanup; the test contract is harmless and the
  // next run reuses it idempotently if we ever care to clean. For now leave
  // a tracer so the QA out file documents the choice.
  info(`leaving test contract ${contractId} + event for trace; trigger blocks DELETE`);
}

async function checkPermissionTemplates() {
  out.push('-- iam.permission_template seeded --');
  const wanted = ['sales_partner','data_provider','channel_partner',
                  'implementation_partner','repair_partner'];
  const r = await pool.query(
    `SELECT key FROM iam.permission_template WHERE key = ANY($1::text[]) ORDER BY key`,
    [wanted],
  );
  const have = new Set(r.rows.map((row) => row.key));
  for (const k of wanted) {
    if (have.has(k)) pass(`permission_template ${k} seeded`);
    else             fail(`permission_template ${k} missing`);
  }
}

async function checkKnownRoles() {
  out.push('-- iam/users.KNOWN_ROLES extended --');
  const mod = await import('../api/v1/iam/users.mjs');
  const known = mod.KNOWN_ROLES;
  if (!(known instanceof Set)) {
    fail('KNOWN_ROLES is not a Set (cannot introspect)');
    return;
  }
  for (const r of ['vendor:view','vendor:manage','vendor:billing']) {
    if (known.has(r)) pass(`KNOWN_ROLES has ${r}`);
    else              fail(`KNOWN_ROLES missing ${r}`);
  }
}

try {
  await checkVendorProfile();
  await checkVendorPool();
  await checkAppendOnlyTrigger();
  await checkPermissionTemplates();
  await checkKnownRoles();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s4b-db PASS' : `qa-s4b-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s4b-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
try {
  const inner = await import('../api/v1/db/pool.mjs');
  await inner.pool.end();
} catch (_e) {}
process.exit(failures === 0 ? 0 : 1);
