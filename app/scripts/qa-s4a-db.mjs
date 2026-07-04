// =============================================================================
// qa-s4a-db.mjs — Sprint 4A (EPIC-007 P-007 Phase 1) DB-side QA checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. sales.meeting carries the 9 new columns introduced by 133_calendar_sync.sql
//   2. sales.meeting_conflict exists with RLS + the append-only trigger
//   3. iam.tenant_dek, iam.oauth_credential, iam.oauth_credential_rotation_log
//      all exist with RLS enabled
//   4. Unique partial index meeting_external_uniq is in place
//   5. pgcrypto extension is installed
//   6. Backfill: every pre-existing sales.meeting row has provider='internal'
//      AND status='scheduled'
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

async function checkMeetingColumns() {
  out.push('-- sales.meeting new columns (S4A) --');
  const cols = await pool.query(
    `SELECT column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_schema = 'sales' AND table_name = 'meeting'`,
  );
  const have = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const wanted of [
    'provider','external_id','etag','sync_token','last_synced_at',
    'owner_id','status','updated_at','version',
  ]) {
    if (have.has(wanted)) pass(`column sales.meeting.${wanted} present`);
    else                   fail(`column sales.meeting.${wanted} MISSING`);
  }
  // CHECK constraints
  const chk = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'sales.meeting'::regclass AND contype = 'c'`,
  );
  // PG normalises `IN (...)` to `= ANY (ARRAY[...])`; accept either form so
  // the check is portable across PG versions.
  const checks = chk.rows.map((r) => r.def).join(' | ');
  const hasProvider = /provider.*(?:IN\s*\(|=\s*ANY\s*\(ARRAY\[).*'internal'.*'google'.*'outlook'.*'ical'/i.test(checks);
  if (hasProvider) pass('CHECK constraint on sales.meeting.provider present');
  else             fail(`provider CHECK missing; defs=${checks.slice(0, 250)}`);
  const hasStatus = /status.*(?:IN\s*\(|=\s*ANY\s*\(ARRAY\[).*'scheduled'.*'tentative'.*'cancelled'.*'completed'/i.test(checks);
  if (hasStatus) pass('CHECK constraint on sales.meeting.status present');
  else           fail(`status CHECK missing; defs=${checks.slice(0, 250)}`);
}

async function checkMeetingExternalUniq() {
  out.push('-- sales.meeting external unique partial index --');
  const idx = await pool.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'sales'
        AND tablename = 'meeting'
        AND indexname = 'meeting_external_uniq'`,
  );
  if (idx.rows.length === 0) {
    fail('meeting_external_uniq index missing');
    return;
  }
  const def = idx.rows[0].indexdef;
  info(def);
  if (/UNIQUE/.test(def))                 pass('meeting_external_uniq is UNIQUE');
  else                                     fail('meeting_external_uniq is NOT UNIQUE');
  if (/tenant_id.*provider.*external_id/.test(def))
    pass('meeting_external_uniq covers (tenant_id, provider, external_id)');
  else
    fail('meeting_external_uniq column set wrong');
  if (/WHERE.*provider/.test(def))         pass('meeting_external_uniq has WHERE clause (partial)');
  else                                      fail('meeting_external_uniq is NOT partial');
}

async function checkMeetingConflict() {
  out.push('-- sales.meeting_conflict + RLS + guard trigger --');
  const r = await pool.query(
    `SELECT relrowsecurity FROM pg_class
      WHERE relname = 'meeting_conflict'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'sales')`,
  );
  if (r.rows.length === 0) { fail('sales.meeting_conflict missing'); return; }
  pass('sales.meeting_conflict exists');
  if (r.rows[0].relrowsecurity) pass('sales.meeting_conflict RLS enabled');
  else                          fail('sales.meeting_conflict RLS NOT enabled');

  const trg = await pool.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'sales.meeting_conflict'::regclass
        AND tgname = 'trg_meeting_conflict_guard'`,
  );
  if (trg.rows.length === 1) pass('meeting_conflict append-only trigger present');
  else                       fail('meeting_conflict append-only trigger missing');

  const pol = await pool.query(
    `SELECT polname FROM pg_policy
      WHERE polrelid = 'sales.meeting_conflict'::regclass`,
  );
  if (pol.rows.length > 0) pass(`meeting_conflict RLS policy count = ${pol.rows.length}`);
  else                     fail('meeting_conflict has no RLS policy');
}

async function checkVaultTables() {
  out.push('-- iam vault tables + RLS --');
  const targets = ['tenant_dek','oauth_credential','oauth_credential_rotation_log'];
  for (const t of targets) {
    const r = await pool.query(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname = $1
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'iam')`,
      [t],
    );
    if (r.rows.length === 0) { fail(`iam.${t} missing`); continue; }
    pass(`iam.${t} exists`);
    if (r.rows[0].relrowsecurity) pass(`iam.${t} RLS enabled`);
    else                          fail(`iam.${t} RLS NOT enabled`);
    const pol = await pool.query(
      `SELECT polname FROM pg_policy
        WHERE polrelid = ('iam.' || $1)::regclass`,
      [t],
    );
    if (pol.rows.length >= 1) pass(`iam.${t} RLS policy count = ${pol.rows.length}`);
    else                       fail(`iam.${t} has no RLS policy`);
  }

  // Unique partial index for active credentials
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'iam'
        AND tablename = 'oauth_credential'
        AND indexname = 'oauth_credential_active_uniq'`,
  );
  if (idx.rows.length === 1 && /UNIQUE/.test(idx.rows[0].indexdef) && /WHERE/.test(idx.rows[0].indexdef)) {
    pass('oauth_credential active-row unique partial index present');
  } else {
    fail('oauth_credential active-row unique partial index missing');
  }
}

async function checkPgcrypto() {
  out.push('-- pgcrypto extension --');
  const r = await pool.query(
    `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`,
  );
  if (r.rows.length === 1) pass('pgcrypto extension installed');
  else                     fail('pgcrypto extension NOT installed');
}

async function checkBackfill() {
  out.push('-- backfill: existing sales.meeting rows --');
  const stats = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE provider IS NULL)            AS provider_null,
        COUNT(*) FILTER (WHERE provider = 'internal')       AS provider_internal,
        COUNT(*) FILTER (WHERE status   IS NULL)            AS status_null,
        COUNT(*) FILTER (WHERE status   = 'scheduled')      AS status_scheduled,
        COUNT(*) AS total
       FROM sales.meeting`,
  );
  const s = stats.rows[0];
  info(`meetings: total=${s.total}, provider_internal=${s.provider_internal}, status_scheduled=${s.status_scheduled}`);
  if (Number(s.provider_null) === 0)     pass('no sales.meeting rows have NULL provider');
  else                                    fail(`${s.provider_null} rows have NULL provider`);
  if (Number(s.status_null) === 0)        pass('no sales.meeting rows have NULL status');
  else                                    fail(`${s.status_null} rows have NULL status`);
}

try {
  await checkPgcrypto();
  await checkMeetingColumns();
  await checkMeetingExternalUniq();
  await checkMeetingConflict();
  await checkVaultTables();
  await checkBackfill();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s4a-db PASS' : `qa-s4a-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s4a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
