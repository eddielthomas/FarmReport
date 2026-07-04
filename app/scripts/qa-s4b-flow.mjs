// =============================================================================
// qa-s4b-flow.mjs — Sprint 4B EPIC-009 P-009 integration test.
// -----------------------------------------------------------------------------
// Verifies the end-to-end vendor lifecycle:
//   1. dev-login admin@demoville-a.local
//   2. Create a vendor user via /iam/users with vendor:view role
//      (mfa_validated:true so the defensive MFA gate passes)
//      Assert iam.vendor_profile row was created.
//   3. POST /vendor-pool/contracts — expect 200
//   4. POST /vendor-pool/contracts/:id/activate — expect 200; assert
//      status='active' AND contract_event(kind='activated')
//   5. POST /iam/vendors/:vendor_user_id/apply-template — expect 200;
//      assert iam.user_role + vendor_pool.scope rows inserted
//   6. dev-login as the vendor; GET /sales/leads → 200 in dry-run mode
//   7. POST /vendor-pool/contracts/:id/revoke — assert status='revoked'
//      AND contract_event(kind='revoked')
//
// Env: NODE_ENV=development, ALLOW_DEV_LOGIN=1, JWT_SECRET=test-key, PORT=5180.
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
    EMAIL_DRAIN_DISABLED: '1',
  };
  serverProc = spawn(process.execPath, ['api/server.mjs'], {
    cwd: 'D:/Projects/RWR/mvp',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (c) => {
    if (process.env.QA_VERBOSE) process.stdout.write(`[srv] ${c}`);
  });
  serverProc.stderr.on('data', (c) => {
    if (process.env.QA_VERBOSE) process.stderr.write(`[srv-err] ${c}`);
  });
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
    // PID-specific kill — per global rule never kill node.exe generically.
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

function authedHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_SLUG,
    'content-type': 'application/json',
  };
}

async function authedGet(token, path) {
  const r = await fetch(`${BASE}/api/v1${path}`, { headers: authedHeaders(token) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function authedPost(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: authedHeaders(token),
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

(async () => {
  await startServer();
  try {
    const t = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
    if (t.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = t.rows[0].id;
    info(`tenant_id = ${tenantId}`);

    // Force-reset admin role bundle (same pattern as qa-s2a-rbac).
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );

    // -- step 1: dev-login admin --
    out.push(`-- step 1: dev-login admin@demoville-a.local --`);
    const adminLogin = await login('admin@demoville-a.local');
    info(`admin id = ${adminLogin.user.id}, token len = ${adminLogin.token.length}`);

    const stamp = Date.now().toString(36);
    const vendorEmail = `qa-vendor-${stamp}@test.local`;

    // -- step 2: create vendor user via /iam/users --
    out.push(`-- step 2: POST /iam/users vendor:view --`);
    const userRes = await authedPost(adminLogin.token, '/iam/users', {
      email: vendorEmail,
      display_name: `QA Vendor ${stamp}`,
      roles: ['vendor:view'],
      mfa_validated: true,    // defensive MFA gate passes
    });
    if (userRes.status !== 201) {
      fail(`vendor user create HTTP ${userRes.status}: ${userRes.raw.slice(0, 250)}`);
      throw new Error('vendor user create failed');
    }
    const vendorUserId = userRes.body.data.id;
    info(`vendor user id = ${vendorUserId}`);
    pass(`vendor user created`);

    // Assert iam.vendor_profile row exists.
    const vp = await pool.query(
      `SELECT id, status FROM iam.vendor_profile WHERE user_id = $1`,
      [vendorUserId],
    );
    if (vp.rows.length === 1) pass(`vendor_profile row auto-created (status=${vp.rows[0].status})`);
    else                      fail(`expected 1 vendor_profile row, got ${vp.rows.length}`);

    // -- step 3: POST /vendor-pool/contracts --
    out.push(`-- step 3: POST /vendor-pool/contracts --`);
    const now = new Date();
    const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const contractRes = await authedPost(adminLogin.token, '/vendor-pool/contracts', {
      vendor_user_id: vendorUserId,
      contract_kind: 'sales_partner',
      status: 'draft',
      starts_at: now.toISOString(),
      ends_at:   endsAt.toISOString(),
    });
    if (contractRes.status !== 201) {
      fail(`contract create HTTP ${contractRes.status}: ${contractRes.raw.slice(0, 250)}`);
      throw new Error('contract create failed');
    }
    const contractId = contractRes.body.data.id;
    info(`contract id = ${contractId}`);
    pass(`contract created`);

    // -- step 4: activate --
    out.push(`-- step 4: POST /vendor-pool/contracts/:id/activate --`);
    const actRes = await authedPost(adminLogin.token,
      `/vendor-pool/contracts/${contractId}/activate`, {});
    if (actRes.status !== 200) {
      fail(`activate HTTP ${actRes.status}: ${actRes.raw.slice(0, 250)}`);
    } else {
      const status = actRes.body?.data?.status;
      if (status === 'active') pass(`contract status flipped to active`);
      else                     fail(`expected status=active, got ${status}`);
    }

    const ev1 = await pool.query(
      `SELECT event_kind FROM vendor_pool.contract_event
        WHERE contract_id = $1 AND event_kind = 'activated' LIMIT 1`,
      [contractId],
    );
    if (ev1.rows.length === 1) pass(`contract_event(activated) row written`);
    else                       fail(`expected contract_event(activated), got ${ev1.rows.length}`);

    // -- step 5: apply-template --
    out.push(`-- step 5: POST /iam/vendors/:user_id/apply-template sales_partner --`);
    const tplRes = await authedPost(adminLogin.token,
      `/iam/vendors/${vendorUserId}/apply-template`,
      { template_key: 'sales_partner', contract_id: contractId });
    if (tplRes.status !== 200) {
      fail(`apply-template HTTP ${tplRes.status}: ${tplRes.raw.slice(0, 250)}`);
    } else {
      const grantedRoles = tplRes.body?.data?.granted_roles ?? [];
      const scopeIds = tplRes.body?.data?.scope_ids ?? [];
      info(`granted_roles = ${grantedRoles.length}, scope_ids = ${scopeIds.length}`);
      if (grantedRoles.length >= 1) pass(`>=1 iam.user_role granted (vendor.viewer)`);
      else                          fail(`expected >=1 user_role grant, got 0`);
      if (scopeIds.length >= 1)     pass(`>=1 vendor_pool.scope row inserted`);
      else                          fail(`expected >=1 scope row, got 0`);
    }

    // Assert DB state.
    const scopes = await pool.query(
      `SELECT permission_key, resource_type FROM vendor_pool.scope WHERE contract_id = $1`,
      [contractId],
    );
    info(`scope rows in DB = ${scopes.rows.length}`);
    if (scopes.rows.length >= 1) pass(`scope rows persisted (${scopes.rows.map((r) => r.permission_key).join(',')})`);

    // -- step 6: dev-login as the vendor; GET /sales/leads in dry-run mode --
    out.push(`-- step 6: dev-login vendor + GET /sales/leads (dry-run) --`);
    const vendorLogin = await login(vendorEmail);
    info(`vendor token len = ${vendorLogin.token.length}`);
    const leadsRes = await authedGet(vendorLogin.token, '/sales/leads');
    if (leadsRes.status === 200) pass(`vendor /sales/leads returned 200 in dry-run mode`);
    else                         fail(`vendor /sales/leads HTTP ${leadsRes.status}: ${leadsRes.raw.slice(0,250)}`);

    // -- step 7: revoke --
    out.push(`-- step 7: POST /vendor-pool/contracts/:id/revoke --`);
    const revRes = await authedPost(adminLogin.token,
      `/vendor-pool/contracts/${contractId}/revoke`, {});
    if (revRes.status !== 200) {
      fail(`revoke HTTP ${revRes.status}: ${revRes.raw.slice(0, 250)}`);
    } else {
      const status = revRes.body?.data?.status;
      if (status === 'revoked') pass(`contract status flipped to revoked`);
      else                      fail(`expected status=revoked, got ${status}`);
    }
    const ev2 = await pool.query(
      `SELECT event_kind FROM vendor_pool.contract_event
        WHERE contract_id = $1 AND event_kind = 'revoked' LIMIT 1`,
      [contractId],
    );
    if (ev2.rows.length === 1) pass(`contract_event(revoked) row written`);
    else                       fail(`expected contract_event(revoked), got ${ev2.rows.length}`);
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s4b-flow PASS' : `qa-s4b-flow FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s4b-flow-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
