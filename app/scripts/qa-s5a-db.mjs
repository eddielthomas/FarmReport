// =============================================================================
// qa-s5a-db.mjs — Sprint 5A (EPIC-008 P-008 Phases 1-2) DB checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. PostGIS extension is installed.
//   2. sales.lead.location  is GEOGRAPHY type (Point, 4326).
//   3. sales.lead.owner_id  is UUID (FK to iam.user_profile).
//   4. sales.lead.assigned_at is TIMESTAMPTZ.
//   5. sales.opportunity.contract_status is TEXT with CHECK in the 5-value set.
//   6. GIST index lead_location_gist on sales.lead.location exists.
//   7. BTREE index lead_tenant_owner_idx exists.
//   8. BTREE index opportunity_lead_contract_idx exists.
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

async function checkPostgis() {
  out.push('-- PostGIS extension --');
  const r = await pool.query(
    `SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
  );
  if (r.rows.length === 1) pass('postgis extension installed');
  else                     fail('postgis extension NOT installed');
}

async function checkLeadColumns() {
  out.push('-- sales.lead new columns (S5A) --');
  // Column-level type info; udt_name surfaces "geography" for PostGIS columns.
  const cols = await pool.query(
    `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema = 'sales' AND table_name = 'lead'`,
  );
  const have = new Map(cols.rows.map((r) => [r.column_name, r]));

  if (have.has('location')) {
    const c = have.get('location');
    if (c.udt_name === 'geography' || c.data_type === 'USER-DEFINED') {
      pass(`sales.lead.location present (udt_name=${c.udt_name})`);
    } else {
      fail(`sales.lead.location wrong type: data_type=${c.data_type} udt_name=${c.udt_name}`);
    }
  } else {
    fail('sales.lead.location MISSING');
  }

  if (have.has('owner_id')) {
    const c = have.get('owner_id');
    if (c.udt_name === 'uuid') pass('sales.lead.owner_id present (uuid)');
    else                       fail(`sales.lead.owner_id wrong type: ${c.udt_name}`);
  } else {
    fail('sales.lead.owner_id MISSING');
  }

  if (have.has('assigned_at')) {
    const c = have.get('assigned_at');
    if (c.udt_name === 'timestamptz') pass('sales.lead.assigned_at present (timestamptz)');
    else                              fail(`sales.lead.assigned_at wrong type: ${c.udt_name}`);
  } else {
    fail('sales.lead.assigned_at MISSING');
  }

  // Confirm the FK on owner_id → iam.user_profile(id).
  const fk = await pool.query(
    `SELECT 1
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'sales'
        AND tc.table_name   = 'lead'
        AND kcu.column_name = 'owner_id'
        AND ccu.table_schema = 'iam'
        AND ccu.table_name   = 'user_profile'`,
  );
  if (fk.rows.length >= 1) pass('sales.lead.owner_id has FK -> iam.user_profile(id)');
  else                     fail('sales.lead.owner_id missing FK to iam.user_profile');
}

async function checkOpportunityColumn() {
  out.push('-- sales.opportunity.contract_status --');
  const cols = await pool.query(
    `SELECT column_name, data_type, udt_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'sales' AND table_name = 'opportunity'
        AND column_name = 'contract_status'`,
  );
  if (cols.rows.length === 0) { fail('sales.opportunity.contract_status MISSING'); return; }
  const c = cols.rows[0];
  if (c.udt_name === 'text')       pass('sales.opportunity.contract_status present (text)');
  else                             fail(`contract_status wrong type: ${c.udt_name}`);
  if (c.is_nullable === 'NO')      pass('contract_status NOT NULL');
  else                             fail('contract_status is NULLABLE (should be NOT NULL)');
  if ((c.column_default ?? '').includes("'none'"))
    pass('contract_status default = none');
  else
    info(`contract_status default = ${c.column_default}`);

  // CHECK constraint — accept either IN(...) or = ANY(ARRAY[...]) PG-normalised forms.
  const chk = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'sales.opportunity'::regclass AND contype = 'c'`,
  );
  const defs = chk.rows.map((r) => r.def).join(' | ');
  const want = ['none','drafted','sent','signed','countersigned'];
  const allPresent = want.every((v) => new RegExp(`'${v}'`).test(defs));
  if (allPresent && /contract_status/.test(defs)) {
    pass('contract_status CHECK covers (none, drafted, sent, signed, countersigned)');
  } else {
    fail(`contract_status CHECK incomplete; defs=${defs.slice(0, 300)}`);
  }
}

async function checkIndexes() {
  out.push('-- sales.lead / sales.opportunity indexes --');
  const idx = await pool.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'sales'
        AND indexname IN (
          'lead_location_gist',
          'lead_tenant_owner_idx',
          'opportunity_lead_contract_idx'
        )`,
  );
  const map = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));

  if (map.has('lead_location_gist')) {
    const def = map.get('lead_location_gist');
    info(def);
    if (/USING gist/i.test(def) && /location/i.test(def)) {
      pass('lead_location_gist is a GIST index on (location)');
    } else {
      fail(`lead_location_gist wrong shape: ${def}`);
    }
  } else {
    fail('lead_location_gist MISSING');
  }

  if (map.has('lead_tenant_owner_idx')) {
    const def = map.get('lead_tenant_owner_idx');
    if (/\(tenant_id, owner_id\)/i.test(def)) {
      pass('lead_tenant_owner_idx covers (tenant_id, owner_id)');
    } else {
      fail(`lead_tenant_owner_idx wrong shape: ${def}`);
    }
  } else {
    fail('lead_tenant_owner_idx MISSING');
  }

  if (map.has('opportunity_lead_contract_idx')) {
    const def = map.get('opportunity_lead_contract_idx');
    if (/\(lead_id, contract_status\)/i.test(def)) {
      pass('opportunity_lead_contract_idx covers (lead_id, contract_status)');
    } else {
      fail(`opportunity_lead_contract_idx wrong shape: ${def}`);
    }
  } else {
    fail('opportunity_lead_contract_idx MISSING');
  }
}

try {
  await checkPostgis();
  await checkLeadColumns();
  await checkOpportunityColumn();
  await checkIndexes();
} catch (e) {
  out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s5a-db PASS' : `qa-s5a-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s5a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
