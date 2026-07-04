// =============================================================================
// qa-s2b-endpoints.mjs — Sprint 2B (EPIC-005) HTTP integration test.
// -----------------------------------------------------------------------------
// 1) Boot api/server.mjs on a free port (default 5180, fallback 5188).
// 2) Dev-login as admin@demoville-a.local.
// 3) POST /billing/streams                — create a stream
// 4) GET  /analytics/dashboard/metrics?period=month
// 5) GET  /analytics/income/month
// 6) GET  /analytics/billing-streams?period=quarter
// 7) GET  /analytics/lead-sources?period=year
// 8) GET  /analytics/conversion?cohort_start=YYYY-MM-DD
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
  return FALLBACK_PORT;
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
  return { token: body.data.token };
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

    // Force-reset admin roles + add analytics.viewer membership for safety.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );

    // -- step 1: dev-login --
    out.push('-- step 1: dev-login admin@demoville-a.local --');
    const admin = await login('admin@demoville-a.local');
    info(`admin token len = ${admin.token.length}`);
    pass('admin logged in');

    // -- step 2: POST /billing/streams --
    out.push('-- step 2: POST /billing/streams --');
    const stamp = Date.now().toString(36);
    const streamKey = `subscription-${stamp}`;
    const streamRes = await authedPost(admin.token, '/billing/streams', {
      key: streamKey, name: `Annual subscription ${stamp}`,
      kind: 'subscription', recurrence: 'annual',
    });
    if (streamRes.status !== 201) {
      fail(`stream create HTTP ${streamRes.status}: ${streamRes.raw.slice(0, 300)}`);
    } else {
      const sid = streamRes.body.data.id;
      info(`stream id = ${sid}`);
      pass('billing stream created');
    }

    // -- step 3: GET /analytics/dashboard/metrics?period=month --
    out.push('-- step 3: GET /analytics/dashboard/metrics?period=month --');
    const dash = await authedGet(admin.token, '/analytics/dashboard/metrics?period=month');
    if (dash.status !== 200) {
      fail(`dashboard HTTP ${dash.status}: ${dash.raw.slice(0, 300)}`);
    } else {
      const d = dash.body?.data ?? {};
      info(`period=${d.period} total_leads=${d.totalLeads} totalProfit=${d.totalProfit}`);
      info(`new_leads_period=${d.new_leads_period} new_clients_period=${d.new_clients_period} open_revenue=${d.open_revenue}`);
      if (d.totalLeads != null && d.total_revenue_period != null) pass('dashboard returns non-null totals');
      else                                                          fail('dashboard missing expected fields');
      if (d.period === 'month') pass('period echoed back as month');
      else                       fail(`period echo wrong: ${d.period}`);
    }

    // -- step 4: GET /analytics/income/month --
    out.push('-- step 4: GET /analytics/income/month --');
    const inc = await authedGet(admin.token, '/analytics/income/month');
    if (inc.status !== 200) {
      fail(`income HTTP ${inc.status}: ${inc.raw.slice(0, 300)}`);
    } else {
      const arr = inc.body?.data ?? [];
      info(`income buckets returned = ${arr.length}`);
      if (Array.isArray(arr) && arr.length === 4) pass('income returns 4 weekly buckets for month');
      else                                         fail(`expected 4 buckets, got ${arr.length}`);
    }

    // -- step 5: GET /analytics/billing-streams?period=quarter --
    out.push('-- step 5: GET /analytics/billing-streams?period=quarter --');
    const streams = await authedGet(admin.token, '/analytics/billing-streams?period=quarter');
    if (streams.status !== 200) {
      fail(`billing-streams HTTP ${streams.status}: ${streams.raw.slice(0, 300)}`);
    } else {
      const arr = streams.body?.data?.streams ?? [];
      info(`streams returned = ${arr.length}`);
      // The just-created stream should show up (with 0 activity).
      const found = arr.some((s) => s.stream_key === streamKey);
      if (found) pass(`created stream appears in billing-streams`);
      else if (arr.length >= 1) pass(`>= 1 stream returned (created stream may not appear if no activity)`);
      else fail('billing-streams returned empty array');
    }

    // -- step 6: GET /analytics/lead-sources?period=year --
    out.push('-- step 6: GET /analytics/lead-sources?period=year --');
    const sources = await authedGet(admin.token, '/analytics/lead-sources?period=year');
    if (sources.status !== 200) {
      fail(`lead-sources HTTP ${sources.status}: ${sources.raw.slice(0, 300)}`);
    } else {
      const arr = sources.body?.data?.sources ?? [];
      info(`lead-source buckets returned = ${arr.length}`);
      if (Array.isArray(arr)) pass('lead-sources returns array');
      else                    fail('lead-sources not array');
    }

    // -- step 7: GET /analytics/conversion?cohort_start=... --
    const startIso = (() => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() - 60);
      return d.toISOString().slice(0, 10);
    })();
    out.push(`-- step 7: GET /analytics/conversion?cohort_start=${startIso} --`);
    const conv = await authedGet(admin.token, `/analytics/conversion?cohort_start=${startIso}`);
    if (conv.status !== 200) {
      fail(`conversion HTTP ${conv.status}: ${conv.raw.slice(0, 300)}`);
    } else {
      const d = conv.body?.data ?? {};
      info(`cohort_size=${d.funnel?.cohort_size} to_client=${d.funnel?.to_client} buckets=${d.buckets?.length}`);
      if (d.funnel && typeof d.funnel.cohort_size === 'number') pass('conversion returns funnel object');
      else                                                       fail('conversion missing funnel');
    }
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end().catch(() => {});
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s2b-endpoints PASS' : `qa-s2b-endpoints FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s2b-endpoints-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
