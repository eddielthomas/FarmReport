// =============================================================================
// qa-s3b-prefs.mjs — Sprint 3B (EPIC-006 P-006) HTTP integration test.
// -----------------------------------------------------------------------------
// Verifies the user>tenant>default email preference precedence end-to-end:
//
//   1. dev-login admin@demoville-a.local
//   2. POST /sales/leads          -> outbox has 1 row kind=lead_created
//   3. PATCH /iam/tenants/:id/email-prefs { lead_created: false }
//   4. POST /sales/leads          -> outbox has NO new lead_created row
//   5. PATCH tenant pref back on; PATCH /iam/users/:id/email-prefs { lead_created:false }
//   6. POST /sales/leads          -> still NO new lead_created row (user wins)
//   7. Invoke drainOnce() via scripts/email-drain-once.mjs; outbox transitions
//      to 'sent' (mock transport since EMAIL_RESEND_DISABLED=1).
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const PORT = Number(process.env.QA_PORT ?? 5181);
const BASE = `http://127.0.0.1:${PORT}`;
const TENANT_SLUG = 'demoville-a';

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);

let serverProc = null;

async function startServer() {
  out.push(`-- starting server on :${PORT} --`);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    ALLOW_DEV_LOGIN: '1',
    JWT_SECRET: 'test-key',
    PORT: String(PORT),
    PGPORT: String(cfg.port),
    PGHOST: cfg.host,
    PGUSER: cfg.user,
    PGPASSWORD: cfg.password,
    PGDATABASE: cfg.database,
    EMAIL_DRAIN_DISABLED: '1',   // test owns when drain runs
    EMAIL_RESEND_DISABLED: '1',  // mock transport
  };
  serverProc = spawn(process.execPath, ['api/server.mjs'], {
    cwd: 'D:/Projects/RWR/mvp', env,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  serverProc.stdout.on('data', (c) => { if (process.env.QA_VERBOSE) process.stdout.write(`[srv] ${c}`); });
  serverProc.stderr.on('data', (c) => { if (process.env.QA_VERBOSE) process.stderr.write(`[srv-err] ${c}`); });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) { info(`server healthy after ${i * 250}ms`); return; }
    } catch (_e) { /* retry */ }
    await delay(250);
  }
  throw new Error('server failed to start within 15s');
}

function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
}

async function login(email) {
  const r = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: TENANT_SLUG, email }),
  });
  const body = await r.json();
  if (!r.ok || !body?.data?.token) {
    throw new Error(`dev-login failed for ${email}: ${JSON.stringify(body)}`);
  }
  return { token: body.data.token, user: body.data.user };
}

async function authedPost(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function authedPatch(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function countOutbox(tenantId, leadId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM email.outbox
      WHERE tenant_id = $1 AND kind = 'lead_created'
        AND payload->'vars'->>'lead_id' = $2`,
    [tenantId, leadId],
  );
  return r.rows[0].n;
}

(async () => {
  await startServer();
  try {
    const t = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
    if (t.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = t.rows[0].id;
    info(`tenant_id = ${tenantId}`);

    // Force-reset admin role bundle as in qa-s2a-rbac.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );

    // Step 1 — login
    const adminLogin = await login('admin@demoville-a.local');
    const adminUserId = adminLogin.user.id;
    info(`admin user_id = ${adminUserId}`);

    // Clean pre-existing tenant/user prefs so the precedence assertions are crisp.
    await pool.query(`DELETE FROM iam.tenant_email_pref WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM iam.user_email_pref WHERE tenant_id = $1`, [tenantId]);

    // Step 2 — POST /sales/leads (default-on → should enqueue)
    out.push(`-- step 2: POST /sales/leads (default-on) --`);
    const stamp = Date.now().toString(36);
    const lead1 = await authedPost(adminLogin.token, '/sales/leads', {
      name: 'QA Lead 1', email: `qa-${stamp}-1@test.local`, company: `QA-${stamp}`,
      status: 'Info Request', source: 'Direct',
    });
    if (lead1.status !== 201) { fail(`lead1 HTTP ${lead1.status}: ${lead1.raw.slice(0, 200)}`); throw new Error('lead1 failed'); }
    const lead1Id = lead1.body.data.id;
    // Give the fire-and-forget notify() a moment to insert.
    await delay(500);
    const n1 = await countOutbox(tenantId, lead1Id);
    info(`outbox rows for lead1 = ${n1}`);
    if (n1 >= 1) pass('lead1 enqueued at least one lead_created outbox row');
    else         fail('lead1 expected >=1 outbox row, got 0');

    // Step 3 — disable tenant pref
    out.push(`-- step 3: PATCH /iam/tenants/:id/email-prefs lead_created=false --`);
    const patchT = await authedPatch(adminLogin.token, `/iam/tenants/${tenantId}/email-prefs`,
      { lead_created: false });
    if (patchT.status !== 200) { fail(`tenant pref PATCH HTTP ${patchT.status}: ${patchT.raw.slice(0, 200)}`); }
    else                       { pass('tenant pref PATCH ok'); }

    // Step 4 — POST another lead -> no new lead_created row
    out.push(`-- step 4: POST /sales/leads (tenant disabled) --`);
    const lead2 = await authedPost(adminLogin.token, '/sales/leads', {
      name: 'QA Lead 2', email: `qa-${stamp}-2@test.local`, company: `QA-${stamp}`,
      status: 'Info Request', source: 'Direct',
    });
    if (lead2.status !== 201) { fail(`lead2 HTTP ${lead2.status}`); throw new Error('lead2 failed'); }
    const lead2Id = lead2.body.data.id;
    await delay(500);
    const n2 = await countOutbox(tenantId, lead2Id);
    info(`outbox rows for lead2 = ${n2}`);
    if (n2 === 0) pass('tenant disable suppressed enqueue');
    else          fail(`expected 0 outbox rows for lead2, got ${n2}`);

    // Step 5 — tenant on, user off
    out.push(`-- step 5: tenant on, user off --`);
    const patchOn = await authedPatch(adminLogin.token, `/iam/tenants/${tenantId}/email-prefs`,
      { lead_created: true });
    if (patchOn.status !== 200) fail(`tenant re-enable HTTP ${patchOn.status}`);
    const patchU = await authedPatch(adminLogin.token, `/iam/users/${adminUserId}/email-prefs`,
      { lead_created: false });
    if (patchU.status !== 200) fail(`user disable HTTP ${patchU.status}: ${patchU.raw.slice(0, 200)}`);
    else                       pass('user pref PATCH ok');

    // The admin user is the recipient when sales.assignment auto-resolves;
    // when no assignment exists, recipient defaults to EMAIL_INTERNAL_TO with
    // user_id=null which bypasses the user-pref test. Insert a sales.assignment
    // for the next lead so the admin user is the resolved recipient.
    // We do this by inserting the lead first, then injecting an assignment.

    out.push(`-- step 6: POST /sales/leads with user-level opt-out --`);
    const lead3 = await authedPost(adminLogin.token, '/sales/leads', {
      name: 'QA Lead 3', email: `qa-${stamp}-3@test.local`, company: `QA-${stamp}`,
      status: 'Info Request', source: 'Direct',
    });
    if (lead3.status !== 201) { fail(`lead3 HTTP ${lead3.status}`); throw new Error('lead3 failed'); }
    const lead3Id = lead3.body.data.id;

    // Without a sales.assignment, recipient resolution falls back to
    // EMAIL_INTERNAL_TO (user_id=null), so user-pref-disabled has nothing to
    // apply against. We assert via a direct enqueue test instead: clear the
    // outbox for lead3 (cascade from above), inject an assignment, and
    // re-invoke notifyLeadCreated.
    await pool.query(`DELETE FROM email.outbox WHERE tenant_id = $1 AND payload->'vars'->>'lead_id' = $2`,
      [tenantId, lead3Id]);
    await pool.query(
      `INSERT INTO sales.assignment (tenant_id, entity_kind, entity_id, user_id, role, assigned_by)
       VALUES ($1, 'lead', $2, $3, 'owner', $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, lead3Id, adminUserId],
    );

    // Re-trigger notify directly to test the user-pref filter path.
    process.env.EMAIL_DRAIN_DISABLED = '1';
    process.env.EMAIL_RESEND_DISABLED = '1';
    const notifyMod = await import('../api/v1/email/notify.mjs');
    const fakeReq = {
      tenant: { id: tenantId },
      user:   { sub: adminUserId, email: 'admin@demoville-a.local' },
      headers: {},
    };
    await notifyMod.notifyLeadCreated(fakeReq, lead3Id);
    await delay(300);
    const n3 = await countOutbox(tenantId, lead3Id);
    info(`outbox rows for lead3 (with assignment + user opt-out) = ${n3}`);
    if (n3 === 0) pass('user-level disable beats tenant-enabled');
    else          fail(`expected 0 outbox rows for lead3 with user opt-out, got ${n3}`);

    // Step 7 — drain a fresh row via the email-drain-once script.
    out.push(`-- step 7: drain a queued row via email-drain-once --`);
    // Wipe user pref so the next enqueue actually fires.
    await pool.query(`DELETE FROM iam.user_email_pref WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, adminUserId]);
    // Bust the in-process pref cache by issuing a PATCH back to enabled=true.
    await authedPatch(adminLogin.token, `/iam/users/${adminUserId}/email-prefs`,
      { lead_created: true });
    const lead4 = await authedPost(adminLogin.token, '/sales/leads', {
      name: 'QA Lead 4', email: `qa-${stamp}-4@test.local`, company: `QA-${stamp}`,
      status: 'Info Request', source: 'Direct',
    });
    const lead4Id = lead4.body.data.id;
    await delay(500);
    const n4 = await countOutbox(tenantId, lead4Id);
    if (n4 >= 1) pass(`lead4 enqueued ${n4} row(s)`);
    else         fail(`lead4 expected enqueue, got ${n4}`);

    // Run the drain.
    const drainOut = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['scripts/email-drain-once.mjs'], {
        cwd: 'D:/Projects/RWR/mvp',
        env: { ...process.env, EMAIL_RESEND_DISABLED: '1', PGHOST: cfg.host, PGPORT: String(cfg.port),
               PGUSER: cfg.user, PGPASSWORD: cfg.password, PGDATABASE: cfg.database },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let buf = '';
      p.stdout.on('data', (c) => { buf += c.toString(); });
      p.stderr.on('data', (c) => { buf += c.toString(); });
      p.on('exit', (code) => resolve({ code, buf }));
      p.on('error', reject);
    });
    info(`drain script exit=${drainOut.code}`);
    info(drainOut.buf.split('\n').slice(-6).map((l) => `  ${l}`).join('\n'));

    const finalStat = await pool.query(
      `SELECT status, attempts FROM email.outbox
        WHERE tenant_id = $1 AND payload->'vars'->>'lead_id' = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, lead4Id],
    );
    if (finalStat.rows.length === 0) { fail('lead4 outbox row vanished'); }
    else {
      const st = finalStat.rows[0].status;
      info(`lead4 final outbox status = ${st}`);
      if (st === 'sent') pass('lead4 outbox row reached sent via mock transport');
      else               fail(`lead4 outbox status expected sent, got ${st}`);
    }

    // Clean up the per-test prefs so re-runs stay green.
    await pool.query(`DELETE FROM iam.tenant_email_pref WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM iam.user_email_pref WHERE tenant_id = $1`, [tenantId]);
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s3b-prefs PASS' : `qa-s3b-prefs FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s3b-prefs-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
