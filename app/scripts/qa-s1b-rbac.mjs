// =============================================================================
// qa-s1b-rbac.mjs — Sprint 1B (EPIC-002) HTTP integration test.
// -----------------------------------------------------------------------------
// Spins up the API server on an ephemeral port (default 5180), then:
//
//   1) dev-login as sales-manager (admin@acme-water.local already has roles[]
//      including platform:admin via the dev seed; we'll grant a 'sales.manager'
//      system role to a fresh user and validate global visibility).
//   2) GET /sales/leads as the sales.manager — expect all tenant rows.
//   3) dev-login as a sales.agent with no assignments — expect empty.
//   4) POST /sales/assignments → assign one lead to the agent → expect 1 row.
//   5) GET /sales/leads as vendor.viewer carrying a single assignment → row
//      visible but email/phone masked and total_revenue absent.
//
// Side effects are confined to the demoville-a tenant.
//
// Env (set automatically inside this script for the spawned server):
//   NODE_ENV=development
//   ALLOW_DEV_LOGIN=1
//   JWT_SECRET=test-key
//   PORT=5180 (override via QA_PORT)
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const PORT = Number(process.env.QA_PORT ?? 5180);
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
  };
  serverProc = spawn(process.execPath, ['api/server.mjs'], {
    cwd: 'D:/Projects/RWR/mvp',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (c) => {
    const s = c.toString();
    if (process.env.QA_VERBOSE) process.stdout.write(`[srv] ${s}`);
  });
  serverProc.stderr.on('data', (c) => {
    const s = c.toString();
    if (process.env.QA_VERBOSE) process.stderr.write(`[srv-err] ${s}`);
  });
  // Wait for /healthz to respond.
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
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
  }
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

async function authedGet(token, path) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id':  TENANT_SLUG,
    },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function authedPost(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id':  TENANT_SLUG,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function setupTestUsers(tenantId) {
  // Three users in demoville-a:
  //   qa-agent@demoville-a.local      — sales.agent (no global)
  //   qa-vendor@demoville-a.local     — vendor.viewer
  // Both start with no canonical roles attached.
  // admin@demoville-a.local already exists with platform:admin (legacy shim
  // grants every permission).
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
     VALUES ($1, 'qa-agent@demoville-a.local',  'QA Agent',
             ARRAY[]::TEXT[], 'active')
     ON CONFLICT (tenant_id, email) DO UPDATE
        SET status = 'active',
            roles  = ARRAY[]::TEXT[]`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
     VALUES ($1, 'qa-vendor@demoville-a.local', 'QA Vendor',
             ARRAY[]::TEXT[], 'active')
     ON CONFLICT (tenant_id, email) DO UPDATE
        SET status = 'active',
            roles  = ARRAY[]::TEXT[]`,
    [tenantId],
  );
  // Wipe any prior assignments for these users so the test is deterministic.
  await pool.query(
    `DELETE FROM sales.assignment a
       USING iam.user_profile up
      WHERE a.user_id = up.id
        AND up.email IN ('qa-agent@demoville-a.local',
                         'qa-vendor@demoville-a.local')`,
  );

  // Backfill iam.identity + iam.tenant_membership so qa-s1a-db invariants
  // (membership >= user_profile, identity >= distinct emails) stay green.
  await pool.query(`
    INSERT INTO iam.identity (email, display_name, status, subject_provider)
      SELECT DISTINCT ON (email) email, display_name,
             CASE status WHEN 'active' THEN 'active' ELSE 'disabled' END,
             'dev-hs256'
        FROM iam.user_profile
       WHERE email IN ('qa-agent@demoville-a.local','qa-vendor@demoville-a.local')
    ON CONFLICT (email) DO NOTHING
  `);
  await pool.query(`
    INSERT INTO iam.tenant_membership (identity_id, tenant_id, user_id, roles, status, joined_at)
      SELECT i.id, up.tenant_id, up.id,
             COALESCE(up.roles, ARRAY[]::TEXT[]),
             'active', up.created_at
        FROM iam.user_profile up
        JOIN iam.identity i ON i.email = up.email
       WHERE up.email IN ('qa-agent@demoville-a.local','qa-vendor@demoville-a.local')
    ON CONFLICT (identity_id, tenant_id) DO NOTHING
  `);

  // Grant the canonical system roles.
  await pool.query(`
    INSERT INTO iam.user_role (user_id, role_id)
      SELECT up.id, r.id
        FROM iam.user_profile up, iam.role r
       WHERE up.email = 'qa-agent@demoville-a.local' AND up.tenant_id = $1
         AND r.key = 'sales.agent' AND r.tenant_id IS NULL
    ON CONFLICT DO NOTHING
  `, [tenantId]);
  await pool.query(`
    INSERT INTO iam.user_role (user_id, role_id)
      SELECT up.id, r.id
        FROM iam.user_profile up, iam.role r
       WHERE up.email = 'qa-vendor@demoville-a.local' AND up.tenant_id = $1
         AND r.key = 'vendor.viewer' AND r.tenant_id IS NULL
    ON CONFLICT DO NOTHING
  `, [tenantId]);
}

(async () => {
  await startServer();
  try {
    const t = await pool.query(
      `SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG],
    );
    if (t.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = t.rows[0].id;
    info(`tenant_id = ${tenantId}`);

    await setupTestUsers(tenantId);
    info(`test users prepared`);

    // -- 1) sales-manager (admin user is platform:admin → data.read.global) --
    out.push(`-- step 1: sales-manager-like login (admin@) --`);
    const adminLogin = await login(`admin@${TENANT_SLUG}.demo`);
    info(`admin token len = ${adminLogin.token.length}`);
    const adminLeads = await authedGet(adminLogin.token, '/sales/leads');
    if (adminLeads.status !== 200) {
      fail(`admin /sales/leads HTTP ${adminLeads.status}: ${adminLeads.raw.slice(0, 200)}`);
    } else if (!Array.isArray(adminLeads.body?.data)) {
      fail(`admin /sales/leads body shape wrong: ${JSON.stringify(adminLeads.body).slice(0, 200)}`);
    } else {
      info(`admin sees ${adminLeads.body.data.length} leads`);
      if (adminLeads.body.data.length > 0) pass(`admin sees all tenant leads`);
      else fail(`admin saw 0 leads (expected > 0)`);
    }

    // -- 2) sales.agent with no assignments --
    out.push(`-- step 2: sales.agent with NO assignments --`);
    const agentLogin = await login('qa-agent@demoville-a.local');
    info(`agent token len = ${agentLogin.token.length}`);
    const agentLeads = await authedGet(agentLogin.token, '/sales/leads');
    if (agentLeads.status !== 200) {
      fail(`agent /sales/leads HTTP ${agentLeads.status}: ${agentLeads.raw.slice(0, 200)}`);
    } else {
      info(`agent sees ${agentLeads.body.data.length} leads`);
      if (agentLeads.body.data.length === 0) pass(`agent assignment-bounded to 0 leads`);
      else fail(`agent saw ${agentLeads.body.data.length} leads (expected 0)`);
    }

    // -- 3) assign one lead to the agent --
    out.push(`-- step 3: POST /sales/assignments (admin grants agent one lead) --`);
    const aLead = adminLeads.body?.data?.[0];
    if (!aLead?.id) {
      fail(`could not pick a lead to assign (admin saw none)`);
      throw new Error('no lead available');
    }
    info(`granting lead ${aLead.id} to qa-agent`);
    const agentUserId = (await pool.query(
      `SELECT id FROM iam.user_profile WHERE email = 'qa-agent@demoville-a.local' AND tenant_id = $1`,
      [tenantId],
    )).rows[0].id;
    const asgRes = await authedPost(adminLogin.token, '/sales/assignments', {
      entity_kind: 'lead',
      entity_id: aLead.id,
      user_id: agentUserId,
      role: 'owner',
    });
    if (asgRes.status !== 201) {
      fail(`assignment HTTP ${asgRes.status}: ${asgRes.raw.slice(0, 200)}`);
    } else {
      pass(`assignment created id=${asgRes.body.data?.id}`);
    }

    // Re-query as the agent — but the 60s policy cache means we need a fresh
    // token. dev-login mints a new token + cache key (sub|tenant) is the
    // same; however the assignment EXISTS check is at query-time so the
    // existing token already sees the change. We do not cache assignments.
    // -- 4) agent sees the assigned lead --
    out.push(`-- step 4: agent re-reads /sales/leads --`);
    const agentLeads2 = await authedGet(agentLogin.token, '/sales/leads');
    info(`agent now sees ${agentLeads2.body.data.length} leads`);
    if (agentLeads2.body.data.length === 1 && agentLeads2.body.data[0].id === aLead.id) {
      pass(`agent sees exactly the assigned lead`);
    } else {
      fail(`agent expected 1 lead (${aLead.id}); got ${JSON.stringify(agentLeads2.body.data.map((r) => r.id))}`);
    }

    // -- 5) vendor.viewer assigned the same lead → masked PII --
    out.push(`-- step 5: vendor.viewer field mask --`);
    const vendorLogin = await login('qa-vendor@demoville-a.local');
    const vendorUserId = (await pool.query(
      `SELECT id FROM iam.user_profile WHERE email = 'qa-vendor@demoville-a.local' AND tenant_id = $1`,
      [tenantId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO sales.assignment (tenant_id, entity_kind, entity_id, user_id, role)
       VALUES ($1, 'lead', $2, $3, 'collaborator')
       ON CONFLICT DO NOTHING`,
      [tenantId, aLead.id, vendorUserId],
    );
    const vendorLeads = await authedGet(vendorLogin.token, '/sales/leads');
    if (vendorLeads.status !== 200) {
      fail(`vendor /sales/leads HTTP ${vendorLeads.status}: ${vendorLeads.raw.slice(0, 200)}`);
    } else if (vendorLeads.body.data.length === 0) {
      fail(`vendor saw 0 leads after assignment`);
    } else {
      const row = vendorLeads.body.data[0];
      info(`vendor sample row keys = ${Object.keys(row).join(',')}`);
      info(`vendor email value = ${JSON.stringify(row.email)}`);
      info(`vendor phone value = ${JSON.stringify(row.phone)}`);
      // email mask check: present (or null/empty when origin had no email) but,
      // if original had '@', expect masked form. We accept any of the policy
      // outcomes (null on non-string, masked on string).
      const emailMasked = row.email == null
        || (typeof row.email === 'string' && /\*\*\*/.test(row.email));
      if (emailMasked) pass(`vendor email obeys mask policy`);
      else             fail(`vendor email NOT masked: ${row.email}`);
      // total_revenue should be DENIED (property removed).
      if (!Object.prototype.hasOwnProperty.call(row, 'total_revenue')) {
        pass(`vendor row.total_revenue is denied (property removed)`);
      } else {
        fail(`vendor row.total_revenue still present: ${row.total_revenue}`);
      }
    }
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s1b-rbac PASS' : `qa-s1b-rbac FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s1b-rbac-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
