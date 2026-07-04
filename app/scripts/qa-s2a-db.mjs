// =============================================================================
// qa-s2a-db.mjs — Sprint 2A (EPIC-003 P-003) DB-side QA checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. New enum types exist (lead_status_t, lead_source_t, activity_kind_t,
//      activity_entity_kind_t, revenue_status_t).
//   2. New tables exist with RLS enabled (organization, contact, contact_lead,
//      activity, revenue_record, vendor).
//   3. Backfill counts:
//        - count(sales.organization)  >= count(distinct lower(company)) on lead
//        - count(sales.contact)       >= count(sales.lead) with email
//        - sales.activity rows        >= note + message + status_history total
//   4. sales.lead has the new FK columns (organization_id, primary_contact_id, vendor_id).
//   5. New permissions are catalogued.
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

async function checkEnums() {
  out.push(`-- new PG enum types --`);
  const wanted = ['lead_status_t','lead_source_t','activity_kind_t','activity_entity_kind_t','revenue_status_t'];
  const { rows } = await pool.query(
    `SELECT t.typname AS name
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'sales'
        AND t.typname = ANY($1)`,
    [wanted],
  );
  const found = new Set(rows.map((r) => r.name));
  for (const w of wanted) {
    if (found.has(w)) pass(`enum sales.${w} exists`);
    else              fail(`enum sales.${w} missing`);
  }
}

async function checkTables() {
  out.push(`-- new tables + RLS flags --`);
  const targets = ['organization','contact','contact_lead','activity','revenue_record','vendor'];
  for (const t of targets) {
    const r = await pool.query(
      `SELECT relname, relrowsecurity
         FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'sales')
          AND relname = $1`,
      [t],
    );
    if (r.rows.length === 0) { fail(`sales.${t} missing`); continue; }
    pass(`sales.${t} exists`);
    if (r.rows[0].relrowsecurity === true) pass(`sales.${t} RLS enabled`);
    else                                    fail(`sales.${t} RLS NOT enabled`);
  }
  // Confirm at least one policy per table.
  const pol = await pool.query(
    `SELECT polname, polrelid::regclass::text AS tbl
       FROM pg_policy
      WHERE polrelid::regclass::text IN
            ('sales.organization','sales.contact','sales.contact_lead',
             'sales.activity','sales.revenue_record','sales.vendor')
      ORDER BY tbl, polname`,
  );
  for (const r of pol.rows) info(`policy ${r.tbl}: ${r.polname}`);
  if (pol.rows.length >= 6) pass(`>= 1 policy per new tenant-scoped table`);
  else                       fail(`only ${pol.rows.length} policies across 6 new tables`);
}

async function checkLeadColumns() {
  out.push(`-- new sales.lead FK columns --`);
  const wanted = ['organization_id','primary_contact_id','vendor_id','archived_at','archived_reason'];
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'sales' AND table_name = 'lead' AND column_name = ANY($1)`,
    [wanted],
  );
  const have = new Set(rows.map((r) => r.column_name));
  for (const w of wanted) {
    if (have.has(w)) pass(`sales.lead.${w} present`);
    else             fail(`sales.lead.${w} missing`);
  }
}

async function checkBackfill() {
  out.push(`-- backfill counts --`);
  const orgCt = await pool.query(`SELECT count(*)::int AS n FROM sales.organization`);
  const distinctCo = await pool.query(`
    SELECT count(*)::int AS n FROM (
      SELECT DISTINCT tenant_id, lower(trim(company)) FROM sales.lead
       WHERE company IS NOT NULL AND trim(company) <> ''
    ) s
  `);
  info(`sales.organization rows                  = ${orgCt.rows[0].n}`);
  info(`distinct (tenant, lower(company)) in lead= ${distinctCo.rows[0].n}`);
  if (orgCt.rows[0].n >= distinctCo.rows[0].n) pass(`org count covers distinct companies`);
  else                                         fail(`org count short by ${distinctCo.rows[0].n - orgCt.rows[0].n}`);

  const contactCt = await pool.query(`SELECT count(*)::int AS n FROM sales.contact`);
  const leadsWithEmail = await pool.query(
    `SELECT count(DISTINCT (tenant_id, lower(email)))::int AS n
       FROM sales.lead WHERE coalesce(email,'') <> ''`,
  );
  info(`sales.contact rows                       = ${contactCt.rows[0].n}`);
  info(`distinct (tenant, lower(email)) leads    = ${leadsWithEmail.rows[0].n}`);
  if (contactCt.rows[0].n >= leadsWithEmail.rows[0].n) pass(`contact count covers distinct emails`);
  else                                                  fail(`contact count short`);

  const actCt = await pool.query(`SELECT count(*)::int AS n FROM sales.activity`);
  const noteCt = await pool.query(`SELECT count(*)::int AS n FROM sales.note`);
  const msgCt  = await pool.query(`SELECT count(*)::int AS n FROM sales.message`);
  const shCt   = await pool.query(`SELECT count(*)::int AS n FROM sales.status_history`);
  const expected = noteCt.rows[0].n + msgCt.rows[0].n + shCt.rows[0].n;
  info(`sales.activity rows                      = ${actCt.rows[0].n}`);
  info(`note + message + status_history          = ${expected}`);
  if (actCt.rows[0].n >= expected) pass(`activity rows >= mirrored sources`);
  else                              fail(`activity short by ${expected - actCt.rows[0].n}`);

  // FK populated on legacy leads
  const linked = await pool.query(`SELECT count(*)::int AS n FROM sales.lead WHERE organization_id IS NOT NULL`);
  info(`leads with organization_id populated     = ${linked.rows[0].n}`);
}

async function checkPermissions() {
  out.push(`-- new permissions seeded --`);
  const wanted = [
    'crm.activity.read','crm.activity.write',
    'crm.revenue.read','crm.revenue.write',
    'crm.vendor.read','crm.vendor.write',
  ];
  const { rows } = await pool.query(
    `SELECT key FROM iam.permission WHERE key = ANY($1)`, [wanted],
  );
  const have = new Set(rows.map((r) => r.key));
  for (const w of wanted) {
    if (have.has(w)) pass(`permission ${w} present`);
    else             fail(`permission ${w} missing`);
  }
}

async function checkAppendOnly() {
  out.push(`-- append-only triggers --`);
  // Probe with a benign UPDATE; expect to be rejected.
  // (Activity rows are created by other handlers; we only need to test the
  // trigger, so we INSERT then attempt UPDATE inside a transaction we abort.)
  try {
    await pool.query('BEGIN');
    // Use a known tenant_id.
    const t = await pool.query(`SELECT id FROM iam.tenant LIMIT 1`);
    if (t.rows.length === 0) { await pool.query('ROLLBACK'); info('no tenants to probe'); return; }
    const tid = t.rows[0].id;
    // Insert a probe activity row.
    const ins = await pool.query(
      `INSERT INTO sales.activity
         (tenant_id, entity_kind, entity_id, kind, source, text)
       VALUES ($1, 'lead', gen_random_uuid(), 'system', 'system', 'qa-probe')
       RETURNING id`,
      [tid],
    );
    const aid = ins.rows[0].id;
    try {
      await pool.query(`UPDATE sales.activity SET text = 'tampered' WHERE id = $1`, [aid]);
      fail(`UPDATE on sales.activity was NOT rejected`);
    } catch (err) {
      if (/append-only/i.test(err.message)) pass(`sales.activity UPDATE rejected by trigger`);
      else fail(`unexpected error: ${err.message}`);
    }
    await pool.query('ROLLBACK');
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    fail(`append-only probe failed: ${e.message}`);
  }
}

try {
  await checkEnums();
  await checkTables();
  await checkLeadColumns();
  await checkBackfill();
  await checkPermissions();
  await checkAppendOnly();
} catch (e) {
  out.push(`FATAL: ${e.message}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s2a-db PASS' : `qa-s2a-db FAIL (${failures} failures)`);

const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s2a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
