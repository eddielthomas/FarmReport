// =============================================================================
// qa-s3a-db.mjs — Sprint 3A (EPIC-005 P-004 Phase 1) DB-side QA checks.
// -----------------------------------------------------------------------------
// Asserts:
//   1. chat.* tables exist with RLS enabled (conversation, conversation_member,
//      message, message_read, attachment).
//   2. Append-only trigger on chat.message blocks UPDATE and DELETE
//      (raises chat_message_immutable).
//   3. Backfill counts: count(chat.message) >= count(sales.message) AND
//      count(chat.conversation) >= count(distinct lead_id from sales.message).
//   4. Permissions crm.chat.read / crm.chat.write / crm.chat.admin catalogued.
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

async function checkTables() {
  out.push(`-- chat.* tables + RLS --`);
  const targets = ['conversation','conversation_member','message','message_read','attachment'];
  for (const t of targets) {
    const r = await pool.query(
      `SELECT relname, relrowsecurity
         FROM pg_class
        WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'chat')
          AND relname = $1`,
      [t],
    );
    if (r.rows.length === 0) { fail(`chat.${t} missing`); continue; }
    pass(`chat.${t} exists`);
    if (r.rows[0].relrowsecurity === true) pass(`chat.${t} RLS enabled`);
    else                                    fail(`chat.${t} RLS NOT enabled`);
  }

  const pol = await pool.query(
    `SELECT polname, polrelid::regclass::text AS tbl
       FROM pg_policy
      WHERE polrelid::regclass::text LIKE 'chat.%'
      ORDER BY tbl, polname`,
  );
  for (const r of pol.rows) info(`policy ${r.tbl}: ${r.polname}`);
  if (pol.rows.length >= 5) pass(`>= 1 policy per chat.* table`);
  else                       fail(`only ${pol.rows.length} policies across chat.* tables`);
}

async function checkAppendOnly() {
  out.push(`-- chat.message append-only trigger --`);
  // Try UPDATE — should raise. We need a row to UPDATE first; if none exists
  // we cannot meaningfully test (still treat trigger presence as PASS).
  const trig = await pool.query(
    `SELECT tgname, tgenabled
       FROM pg_trigger
      WHERE tgrelid = 'chat.message'::regclass
        AND NOT tgisinternal`,
  );
  const names = trig.rows.map((r) => r.tgname);
  if (names.includes('trg_chat_message_immutable')) {
    pass(`trigger trg_chat_message_immutable installed`);
  } else {
    fail(`trigger trg_chat_message_immutable missing (got: ${names.join(',')})`);
    return;
  }

  // Pick one row to use as a probe. If no rows exist we synthesize one and
  // roll back to keep the test repeatable.
  const probe = await pool.query(
    `SELECT id, tenant_id, conversation_id FROM chat.message
      ORDER BY created_at DESC LIMIT 1`,
  );
  let probeMsgId = probe.rows[0]?.id ?? null;
  let probeTenantId = probe.rows[0]?.tenant_id ?? null;
  let cleanupConv = null;

  const client = await pool.connect();
  try {
    if (!probeMsgId) {
      // Synthesize a (tenant, conversation, message) chain so we have something
      // to attempt UPDATE against.
      info('chat.message empty — synthesizing transient probe row');
      const t = await client.query(`SELECT id FROM iam.tenant ORDER BY created_at ASC LIMIT 1`);
      if (t.rows.length === 0) { fail('no tenant available for probe'); return; }
      probeTenantId = t.rows[0].id;
      const c = await client.query(
        `INSERT INTO chat.conversation
           (tenant_id, scope_kind, scope_id, subject, status, channel, created_by)
         VALUES ($1,'lead', gen_random_uuid(), 'probe', 'open', 'in_app',
                 '00000000-0000-0000-0000-000000000000'::uuid)
         RETURNING id`,
        [probeTenantId],
      );
      cleanupConv = c.rows[0].id;
      const ins = await client.query(
        `INSERT INTO chat.message (tenant_id, conversation_id, sender_kind, body)
         VALUES ($1, $2, 'system', 'probe') RETURNING id`,
        [probeTenantId, cleanupConv],
      );
      probeMsgId = ins.rows[0].id;
    }

    // UPDATE probe.
    let updRaised = false;
    try {
      await client.query(
        `UPDATE chat.message SET body = body || ' !' WHERE id = $1`,
        [probeMsgId],
      );
    } catch (err) {
      updRaised = true;
      if (/chat_message_immutable/.test(err.message)) pass(`UPDATE chat.message raises chat_message_immutable`);
      else                                            fail(`UPDATE raised but unexpected: ${err.message}`);
    }
    if (!updRaised) fail(`UPDATE chat.message did NOT raise`);

    // DELETE probe.
    let delRaised = false;
    try {
      await client.query(`DELETE FROM chat.message WHERE id = $1`, [probeMsgId]);
    } catch (err) {
      delRaised = true;
      if (/chat_message_immutable/.test(err.message)) pass(`DELETE chat.message raises chat_message_immutable`);
      else                                            fail(`DELETE raised but unexpected: ${err.message}`);
    }
    if (!delRaised) fail(`DELETE chat.message did NOT raise`);
  } finally {
    if (cleanupConv) {
      // Drop the synthesized conversation cascade (message dies with it).
      // We bypass the append-only trigger because ON DELETE CASCADE from the
      // parent is silently allowed by the trigger statement form (it fires
      // BEFORE per-row but parent CASCADE handles the row deletion via FK).
      // If the trigger blocks the cascade we leave the row in place; the row
      // is harmless for re-runs.
      await client.query(`DELETE FROM chat.conversation WHERE id = $1`, [cleanupConv]).catch(() => {});
    }
    client.release();
  }
}

async function checkBackfill() {
  out.push(`-- backfill counts --`);
  const sMsgs = await pool.query(`SELECT COUNT(*)::int AS n FROM sales.message`);
  const sLeads = await pool.query(
    `SELECT COUNT(DISTINCT (tenant_id, lead_id))::int AS n FROM sales.message`,
  );
  const cMsgs = await pool.query(`SELECT COUNT(*)::int AS n FROM chat.message`);
  const cConvs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM chat.conversation WHERE scope_kind = 'lead'`,
  );
  info(`sales.message rows = ${sMsgs.rows[0].n}`);
  info(`sales.message distinct (tenant,lead) = ${sLeads.rows[0].n}`);
  info(`chat.message rows = ${cMsgs.rows[0].n}`);
  info(`chat.conversation (scope_kind=lead) rows = ${cConvs.rows[0].n}`);
  if (cMsgs.rows[0].n >= sMsgs.rows[0].n) pass(`chat.message >= sales.message`);
  else                                     fail(`chat.message ${cMsgs.rows[0].n} < sales.message ${sMsgs.rows[0].n}`);
  if (cConvs.rows[0].n >= sLeads.rows[0].n) pass(`chat.conversation(lead) >= distinct sales.message leads`);
  else                                      fail(`chat.conversation(lead) ${cConvs.rows[0].n} < distinct lead count ${sLeads.rows[0].n}`);
}

async function checkPermissions() {
  out.push(`-- chat permissions --`);
  const wanted = ['crm.chat.read','crm.chat.write','crm.chat.admin'];
  const { rows } = await pool.query(
    `SELECT key FROM iam.permission WHERE key = ANY($1)`, [wanted],
  );
  const have = new Set(rows.map((r) => r.key));
  for (const w of wanted) {
    if (have.has(w)) pass(`permission ${w} present`);
    else             fail(`permission ${w} missing`);
  }

  // Spot-check grants on tenant.admin (must include write).
  const granted = await pool.query(
    `SELECT rp.permission_key
       FROM iam.role r
       JOIN iam.role_permission rp ON rp.role_id = r.id
      WHERE r.key = 'tenant.admin' AND r.tenant_id IS NULL
        AND rp.permission_key = ANY($1)`,
    [wanted],
  );
  const grantedKeys = new Set(granted.rows.map((r) => r.permission_key));
  for (const w of wanted) {
    if (grantedKeys.has(w)) pass(`tenant.admin granted ${w}`);
    else                    fail(`tenant.admin missing grant for ${w}`);
  }
}

try {
  await checkTables();
  await checkAppendOnly();
  await checkBackfill();
  await checkPermissions();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
}

out.push('');
out.push(failures === 0 ? 'qa-s3a-db PASS' : `qa-s3a-db FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s3a-db-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
