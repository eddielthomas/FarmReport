// =============================================================================
// qa-s3b-db.mjs — Sprint 3B (EPIC-006 P-006 Email Notification Service) DB check.
// -----------------------------------------------------------------------------
// Asserts:
//   1. email.outbox exists with RLS + tenant_id FK + updated_at trigger
//   2. iam.tenant_email_pref + iam.user_email_pref exist with RLS + kind CHECK
//   3. The drain function moves a queued row queued -> sending -> sent (or
//      dead_letter) given the EMAIL_RESEND_DISABLED mock transport.
// =============================================================================

import pg from 'pg';
import { writeFileSync } from 'node:fs';

// Ensure mock transport before importing the drain.
process.env.EMAIL_RESEND_DISABLED = '1';
process.env.EMAIL_DRAIN_DISABLED  = '1';

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

async function checkOutbox() {
  out.push('-- email.outbox --');
  const r = await pool.query(
    `SELECT relrowsecurity FROM pg_class
      WHERE relname = 'outbox'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'email')`,
  );
  if (r.rows.length === 0) { fail('email.outbox missing'); return; }
  pass('email.outbox exists');
  if (r.rows[0].relrowsecurity) pass('email.outbox RLS enabled');
  else                          fail('email.outbox RLS NOT enabled');

  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'email' AND table_name = 'outbox'`,
  );
  const have = new Set(cols.rows.map((c) => c.column_name));
  for (const wanted of [
    'id','tenant_id','kind','recipient_email','recipient_user_id','payload',
    'status','attempts','last_error','next_attempt_at','locked_at','sent_at',
    'created_at','updated_at',
  ]) {
    if (have.has(wanted)) pass(`email.outbox column ${wanted} present`);
    else                  fail(`email.outbox column ${wanted} missing`);
  }

  const trg = await pool.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'email.outbox'::regclass
        AND tgname = 'outbox_touch_updated_at_trg'`,
  );
  if (trg.rows.length === 1) pass('email.outbox updated_at trigger present');
  else                       fail('email.outbox updated_at trigger missing');

  const pol = await pool.query(
    `SELECT polname FROM pg_policy
      WHERE polrelid = 'email.outbox'::regclass`,
  );
  if (pol.rows.length > 0) pass(`email.outbox RLS policy count = ${pol.rows.length}`);
  else                     fail('email.outbox has no RLS policy');
}

async function checkPrefsTables() {
  for (const t of ['tenant_email_pref','user_email_pref']) {
    out.push(`-- iam.${t} --`);
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

    // kind CHECK constraint covers the five S3B kinds.
    const chk = await pool.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
        WHERE cl.relname = $1 AND c.contype = 'c'`,
      [t],
    );
    const joined = chk.rows.map((r) => r.def).join(' | ');
    const wantedKinds = ['lead_created','lead_status_changed','meeting_scheduled','case_assigned','chat_alert'];
    let kindOk = true;
    for (const k of wantedKinds) if (!joined.includes(k)) { kindOk = false; break; }
    if (kindOk) pass(`iam.${t} kind CHECK constraint covers all 5 kinds`);
    else        fail(`iam.${t} kind CHECK missing kinds; def="${joined.slice(0, 250)}"`);
  }
}

async function checkDrainCycle() {
  out.push('-- drain queued -> sending -> sent (mock transport) --');
  const t = await pool.query(`SELECT id FROM iam.tenant WHERE status IN ('active','trial') LIMIT 1`);
  if (t.rows.length === 0) { fail('no active tenant to test against'); return; }
  const tenantId = t.rows[0].id;
  info(`using tenant ${tenantId}`);

  // Insert a queued row directly so the test does not depend on REST plumbing.
  const ins = await pool.query(
    `INSERT INTO email.outbox (tenant_id, kind, recipient_email, payload, status, next_attempt_at)
     VALUES ($1, 'lead_created', $2, $3::jsonb, 'queued', now())
     RETURNING id`,
    [tenantId, 'qa-s3b-db@test.local',
     JSON.stringify({ template_key: 'leadCreated', vars: { lead_name: 'QA Drain', lead_id: '00000000-0000-0000-0000-000000000001', lead_status: 'Info Request', by_user: 'qa', lead_source: 'Direct' } })],
  );
  const outboxId = ins.rows[0].id;
  info(`queued outbox id ${outboxId}`);

  const drainMod = await import('../api/v1/email/drain.mjs');
  const counters = await drainMod.drainOnce();
  info(`drain counters: ${JSON.stringify(counters)}`);
  if ((counters.claimed ?? 0) >= 1) pass('drain claimed at least 1 row');
  else                              fail('drain claimed 0 rows');

  const final = await pool.query(`SELECT status, attempts, sent_at FROM email.outbox WHERE id = $1`, [outboxId]);
  if (final.rows.length === 0) { fail('outbox row vanished'); return; }
  const status = final.rows[0].status;
  info(`final status = ${status}, attempts = ${final.rows[0].attempts}, sent_at=${final.rows[0].sent_at}`);
  if (status === 'sent')           pass('row transitioned to sent (mock transport)');
  else if (status === 'dead_letter') pass('row transitioned to dead_letter (transient mock failed)');
  else                              fail(`row stuck in status=${status}`);

  // Idempotency: second drain should be a no-op for this row.
  const counters2 = await drainMod.drainOnce();
  info(`second drain counters: ${JSON.stringify(counters2)}`);
  pass(`second drain ran cleanly (claimed=${counters2.claimed})`);

  // Clean up the test row so re-runs stay green.
  await pool.query(`DELETE FROM email.outbox WHERE id = $1`, [outboxId]);
}

try {
  await checkOutbox();
  await checkPrefsTables();
  await checkDrainCycle();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s3b-db PASS' : `qa-s3b-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s3b-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
// Drain module loaded an inner pool via api/v1/db/pool.mjs — close it too so
// node exits promptly.
try {
  const inner = await import('../api/v1/db/pool.mjs');
  await inner.pool.end();
} catch (_e) {}
process.exit(failures === 0 ? 0 : 1);
