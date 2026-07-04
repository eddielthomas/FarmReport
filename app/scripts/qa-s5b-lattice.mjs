// =============================================================================
// qa-s5b-lattice.mjs — Sprint 5B (EPIC-010 P-010 Phase 3) integration test.
// -----------------------------------------------------------------------------
// 1) Boots api/server.mjs on :5180 (fallback :5188).
// 2) Dev-logs in as admin@demoville-a.local (platform admin).
// 3) Creates / picks a confidential lead in tenant-A via direct SQL.
// 4) Dev-logs in as a second user (sales agent) and confirms they CANNOT see
//    the confidential lead under the default 'internal' clearance.
// 5) Direct SQL elevates the second user to clearance='confidential'.
// 6) Re-fetches /sales/leads as the second user — confidential lead now
//    visible.
// 7) Inspects iam.audit_event payload to confirm `subject_clearance` is
//    persisted on at least one recent mutation.
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import pg from 'pg';

const PRIMARY_PORT  = Number(process.env.QA_PORT ?? 5180);
const FALLBACK_PORT = 5188;
const TENANT_SLUG   = 'demoville-a';

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
let PORT = PRIMARY_PORT;
let BASE = `http://127.0.0.1:${PORT}`;

function probePortFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(p, '127.0.0.1');
  });
}

async function pickPort() {
  if (await probePortFree(PRIMARY_PORT)) return PRIMARY_PORT;
  info(`port ${PRIMARY_PORT} busy, falling back to ${FALLBACK_PORT}`);
  if (await probePortFree(FALLBACK_PORT)) return FALLBACK_PORT;
  throw new Error('both ports busy');
}

async function startServer() {
  PORT = await pickPort();
  BASE = `http://127.0.0.1:${PORT}`;
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
    EMAIL_DRAIN_DISABLED: '1',
  };
  serverProc = spawn(process.execPath, ['api/server.mjs'], {
    cwd: 'D:/Projects/RWR/mvp',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (c) => { if (process.env.QA_VERBOSE) process.stdout.write(`[srv] ${c}`); });
  serverProc.stderr.on('data', (c) => { if (process.env.QA_VERBOSE) process.stderr.write(`[srv-err] ${c}`); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) { info(`server healthy after ${i * 250}ms`); return; }
    } catch (_e) { /* retry */ }
    await delay(250);
  }
  throw new Error('server failed to start within 20s');
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGTERM'); } catch (_e) {}
  }
}

async function login(email) {
  const r = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: TENANT_SLUG, email }),
  });
  const body = await r.json();
  const token = body?.data?.token ?? body?.token;
  if (!r.ok || !token) {
    throw new Error(`dev-login failed for ${email}: ${JSON.stringify(body)}`);
  }
  // body.data.user may carry id; fallback to looking it up.
  const user = body?.data?.user ?? body?.user ?? {};
  return { token, user };
}

async function authedGet(token, path) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_SLUG },
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: parsed, raw: text };
}

async function authedPost(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_SLUG, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: parsed, raw: text };
}

async function run() {
  await startServer();

  // ---- Step 1 + 2: dev-login admin@demoville-a.local --------------------------
  out.push('-- dev-login admin --');
  const admin = await login('admin@demoville-a.local');
  pass(`admin logged in (user ${admin.user?.id ?? '?'})`);

  // Look up tenant id from slug for later direct SQL.
  const tres = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1 LIMIT 1`, [TENANT_SLUG]);
  if (!tres.rows.length) { fail('tenant slug missing'); return; }
  const tenantId = tres.rows[0].id;
  info(`tenant=${tenantId}`);

  // ---- Step 3: confirm there is a lead, set its classification to confidential.
  // We deliberately do not create a brand-new lead via POST — the orchestrator's
  // sequencing is "UPDATE one existing lead". If there is no existing row,
  // synthesize one so the test still runs in a freshly-migrated dev DB.
  const existing = await pool.query(
    `SELECT id FROM sales.lead WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
    [tenantId]);
  let leadId;
  if (existing.rows.length === 0) {
    const ins = await pool.query(
      `INSERT INTO sales.lead (tenant_id, name, email, status, classification)
       VALUES ($1, 'QA Confidential Lead', 'qa-conf@example.com', 'Lead', 'confidential')
       RETURNING id`, [tenantId]);
    leadId = ins.rows[0].id;
    info(`synthesized lead id=${leadId}`);
  } else {
    leadId = existing.rows[0].id;
    await pool.query(
      `UPDATE sales.lead SET classification = 'confidential' WHERE id = $1`,
      [leadId]);
    info(`promoted existing lead id=${leadId} to classification=confidential`);
  }
  pass(`confidential lead id=${leadId} in place`);

  // ---- Step 4: dev-login as second user (default clearance='internal').
  // sales.agent@demoville-a.local — non-platform-admin, default DASHBOARD_VIEW
  // bundle. To ensure they can list leads at all we elevate them to data.read.global
  // via the legacy sales:manage role (which the dev-login path automatically
  // grants only for emails starting with "admin@" — so we set the role directly
  // via SQL after the upsert). We then assign the lead to the user so the
  // visibility predicate passes irrespective of any per-row assignment gate.
  out.push('-- dev-login second user --');
  const secondEmail = 'qa-second-user@demoville-a.local';
  const second = await login(secondEmail);
  pass(`second user logged in (user ${second.user?.id ?? '?'})`);
  // Force-grant sales:manage so the listLeads path goes through the global
  // branch (otherwise it gates on sales.assignment and we'd be measuring the
  // wrong predicate).
  const secondUserId = second.user?.id ?? (await pool.query(
    `SELECT id FROM iam.user_profile WHERE tenant_id=$1 AND email=$2 LIMIT 1`,
    [tenantId, secondEmail])).rows[0]?.id;
  if (!secondUserId) { fail('cannot resolve second user id'); return; }
  await pool.query(
    `UPDATE iam.user_profile SET roles = ARRAY['sales:manage','dashboard:view']
      WHERE id = $1`, [secondUserId]);
  await pool.query(
    `UPDATE iam.user_profile SET clearance = 'internal' WHERE id = $1`,
    [secondUserId]);
  // Re-login so the new roles ride on the JWT.
  const second2 = await login(secondEmail);
  // Default clearance is 'internal' — confidential lead must NOT appear.
  const list1 = await authedGet(second2.token, '/sales/leads');
  if (list1.status !== 200) {
    fail(`second-user list pre-elevation: ${list1.status} ${list1.raw.slice(0,200)}`);
  } else {
    const rows = Array.isArray(list1.body) ? list1.body : (list1.body?.data ?? []);
    const hasLead = rows.some((l) => l.id === leadId);
    if (!hasLead) pass(`pre-elevation: confidential lead correctly hidden from internal-clearance user`);
    else          fail(`pre-elevation: confidential lead leaked to internal-clearance user`);
    info(`pre-elevation rows visible=${rows.length}`);
  }

  // ---- Step 5: elevate second user's clearance to confidential via SQL.
  out.push('-- elevate second user --');
  await pool.query(
    `UPDATE iam.user_profile SET clearance = 'confidential' WHERE id = $1`,
    [secondUserId]);
  pass(`set clearance=confidential on second user`);

  // Re-login so the JWT/policy cache picks up the new clearance.
  const second3 = await login(secondEmail);

  // ---- Step 6: confidential lead must now appear.
  const list2 = await authedGet(second3.token, '/sales/leads');
  if (list2.status !== 200) {
    fail(`second-user list post-elevation: ${list2.status} ${list2.raw.slice(0,200)}`);
  } else {
    const rows = Array.isArray(list2.body) ? list2.body : (list2.body?.data ?? []);
    const hasLead = rows.some((l) => l.id === leadId);
    if (hasLead) pass(`post-elevation: confidential lead visible to confidential-clearance user`);
    else         fail(`post-elevation: confidential lead still hidden`);
    info(`post-elevation rows visible=${rows.length}`);
  }

  // ---- Step 7: audit row inspection — confirm subject_clearance is persisted.
  // The admin dev-login a few seconds ago wrote an audit row with
  // action='dev_login'. We accept any recent audit row carrying the field.
  // The mutation does not need to be a lattice mutation for the check.
  out.push('-- audit payload classification fields --');
  // Issue another authenticated mutation so we have a fresh audit row
  // produced under the *new* recordAudit wrapper. Easiest: POST /sales/leads
  // as admin (we know admin can write).
  await authedPost(admin.token, '/sales/leads', {
    name: 'QA Audit Probe', email: 'qa-audit-probe@example.com', status: 'Info Request',
  });

  const auditRows = await pool.query(
    `SELECT payload FROM iam.audit_event
      WHERE tenant_id = $1
        AND payload ? 'subject_clearance'
      ORDER BY created_at DESC
      LIMIT 5`, [tenantId]);
  if (auditRows.rows.length === 0) {
    fail('no recent audit row carries subject_clearance');
  } else {
    const first = auditRows.rows[0].payload;
    pass(`audit row carries subject_clearance=${first.subject_clearance}`);
  }
}

try {
  await run();
} catch (e) {
  out.push(`FATAL: ${e.stack ?? e.message ?? e}`);
  failures++;
} finally {
  stopServer();
}

out.push('');
out.push(failures === 0 ? 'qa-s5b-lattice PASS' : `qa-s5b-lattice FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s5b-lattice-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
