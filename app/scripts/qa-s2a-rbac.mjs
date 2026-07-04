// =============================================================================
// qa-s2a-rbac.mjs — Sprint 2A (EPIC-003 P-003) HTTP integration test.
// -----------------------------------------------------------------------------
// Starts the API server on an ephemeral port, dev-logs in as
// admin@demoville-a.local (carries platform:admin via the dev seed), then:
//
//   1) POST  /crm/organizations
//   2) POST  /crm/contacts          referencing the org
//   3) POST  /sales/leads           company = org name -> server lookup
//   4) GET   /crm/activities?entity_kind=lead&entity_id=<lead.id>
//          → expect >= 1 activity (lead-created)
//   5) POST  /crm/revenue-records   for the same lead
//   6) GET   /sales/leads/:id
//          → expect organization_id + primary_contact_id populated
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
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT_SLUG },
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
      'x-tenant-id': TENANT_SLUG,
      'content-type': 'application/json',
    },
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

    // Ensure admin@demoville-a.local has the full admin role bundle. The
    // dev-login UPSERT does not overwrite roles on conflict, so a pre-existing
    // row (seeded with a narrower role set by other tests) could 403 the
    // mutations below. We force-reset to the admin bundle here.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );

    // Use a unique org name per run so retries don't collide on the unique index.
    const stamp = Date.now().toString(36);
    const orgName = `QA Org ${stamp}`;
    const contactEmail = `qa-${stamp}@test.local`;

    // -- 1) login as admin --
    out.push(`-- step 1: dev-login admin@demoville-a.local --`);
    const adminLogin = await login('admin@demoville-a.local');
    info(`admin token len = ${adminLogin.token.length}`);

    // -- 2) POST /crm/organizations --
    out.push(`-- step 2: POST /crm/organizations --`);
    const orgRes = await authedPost(adminLogin.token, '/crm/organizations', {
      name: orgName, domain: `qa-${stamp}.test.local`,
    });
    if (orgRes.status !== 201) {
      fail(`org create HTTP ${orgRes.status}: ${orgRes.raw.slice(0, 250)}`);
      throw new Error('org create failed');
    }
    const orgId = orgRes.body.data.id;
    info(`organization id = ${orgId}`);
    pass(`organization created`);

    // -- 3) POST /crm/contacts --
    out.push(`-- step 3: POST /crm/contacts --`);
    const contactRes = await authedPost(adminLogin.token, '/crm/contacts', {
      email: contactEmail, first_name: 'QA', last_name: 'User',
      organization_id: orgId,
    });
    if (contactRes.status !== 201) {
      fail(`contact create HTTP ${contactRes.status}: ${contactRes.raw.slice(0, 250)}`);
      throw new Error('contact create failed');
    }
    const contactId = contactRes.body.data.id;
    info(`contact id = ${contactId}`);
    pass(`contact created`);

    // -- 4) POST /sales/leads ----
    // company string matches the org name so the leads handler resolves
    // organization_id via lookup-or-create; email matches the contact so
    // primary_contact_id is populated.
    out.push(`-- step 4: POST /sales/leads --`);
    const leadRes = await authedPost(adminLogin.token, '/sales/leads', {
      name: 'QA Lead', email: contactEmail, company: orgName,
      status: 'Info Request', source: 'Direct',
    });
    if (leadRes.status !== 201) {
      fail(`lead create HTTP ${leadRes.status}: ${leadRes.raw.slice(0, 250)}`);
      throw new Error('lead create failed');
    }
    const leadId = leadRes.body.data.id;
    info(`lead id = ${leadId}`);
    pass(`lead created`);

    // -- 5) GET /crm/activities for the new lead --
    out.push(`-- step 5: GET /crm/activities?entity_kind=lead&entity_id=... --`);
    const actRes = await authedGet(adminLogin.token,
      `/crm/activities?entity_kind=lead&entity_id=${leadId}`);
    if (actRes.status !== 200) {
      fail(`activities HTTP ${actRes.status}: ${actRes.raw.slice(0, 250)}`);
    } else {
      const rows = actRes.body?.data ?? [];
      info(`activities count = ${rows.length}`);
      if (rows.length >= 1) pass(`>= 1 activity row for the new lead`);
      else                  fail(`expected >= 1 activity row, got ${rows.length}`);
    }

    // -- 6) POST /crm/revenue-records --
    out.push(`-- step 6: POST /crm/revenue-records --`);
    const revRes = await authedPost(adminLogin.token, '/crm/revenue-records', {
      client_id: leadId, amount: 1500.00, status: 'booked',
    });
    if (revRes.status !== 201) {
      fail(`revenue create HTTP ${revRes.status}: ${revRes.raw.slice(0, 250)}`);
    } else {
      pass(`revenue record created id=${revRes.body.data.id}`);
    }

    // -- 7) GET /sales/leads/:id ----
    out.push(`-- step 7: GET /sales/leads/:id --`);
    const leadGet = await authedGet(adminLogin.token, `/sales/leads/${leadId}`);
    if (leadGet.status !== 200) {
      fail(`lead get HTTP ${leadGet.status}: ${leadGet.raw.slice(0, 250)}`);
    } else {
      const row = leadGet.body?.data ?? {};
      info(`lead organization_id    = ${row.organization_id}`);
      info(`lead primary_contact_id = ${row.primary_contact_id}`);
      if (row.organization_id === orgId) pass(`lead.organization_id resolved to created org`);
      else fail(`lead.organization_id expected ${orgId}, got ${row.organization_id}`);
      if (row.primary_contact_id === contactId) pass(`lead.primary_contact_id resolved to created contact`);
      else fail(`lead.primary_contact_id expected ${contactId}, got ${row.primary_contact_id}`);
    }
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s2a-rbac PASS' : `qa-s2a-rbac FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s2a-rbac-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
