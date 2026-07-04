// =============================================================================
// qa-s14a-flow.mjs — Sprint 14A end-to-end flow.
// -----------------------------------------------------------------------------
// 1) dev-login admin@demoville-a.local
// 2) POST /crm/projects {title:'NW Quadrant Leak Survey 2026'} -> 201 + id
// 3) POST /crm/projects/:id/scenes {Overview hydrovision is_default:true} -> 201
// 4) POST /crm/projects/:id/scenes {Thermal thermsight is_default:false} -> 201
// 5) POST /crm/projects/:id/scenes/:second/set-default -> 200; first is_default flips to false
// 6) GET  /crm/projects/:id/scenes -> 2 scenes, exactly one is_default=true (the second)
// 7) dev-login a customer.viewer user -> GET /crm/projects returns only their own (likely [])
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import pg from 'pg';

const PRIMARY_PORT  = Number(process.env.QA_PORT ?? 5180);
const FALLBACK_PORT = 5191;
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
    SKIP_ACCESS_GATE: '1',
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
  if (!r.ok || !token) throw new Error(`dev-login failed for ${email}: ${JSON.stringify(body)}`);
  return { token, user: body?.data?.user ?? body?.user ?? {} };
}

function authHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_SLUG,
    ...extra,
  };
}

async function authedGet(token, path) {
  const r = await fetch(`${BASE}/api/v1${path}`, { headers: authHeaders(token) });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: parsed, raw: text };
}

async function authedJson(token, path, method, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: authHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: parsed, raw: text };
}

async function run() {
  await startServer();

  // ---- Step 0: clean any leftover QA artifacts from prior runs ----
  const cleanTenant = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
  if (cleanTenant.rows[0]) {
    const cleanTid = cleanTenant.rows[0].id;
    await pool.query(
      `DELETE FROM crm.project WHERE tenant_id = $1 AND title LIKE 'NW Quadrant Leak Survey 2026%'`,
      [cleanTid]);
    await pool.query(
      `DELETE FROM crm.project WHERE tenant_id = $1 AND title = 'qa-s14a-default-test'`,
      [cleanTid]);
    await pool.query(
      `DELETE FROM sales.contact WHERE tenant_id = $1 AND email = $2`,
      [cleanTid, 'qa-s14a-customer@demoville-a.local']);
  }

  // ---- Step 1: admin login ----
  out.push('-- admin login --');
  const admin = await login('admin@demoville-a.local');
  pass(`admin token len=${admin.token.length}`);
  const tres = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
  if (!tres.rows.length) { fail('tenant slug missing'); return; }
  const tenantId = tres.rows[0].id;
  info(`tenant=${tenantId}`);

  // ---- Step 2: create project ----
  out.push('-- create project --');
  const projRes = await authedJson(admin.token, '/crm/projects', 'POST', {
    title: 'NW Quadrant Leak Survey 2026',
    description: 'QA seeded project for S14A flow.',
  });
  if (projRes.status !== 201) {
    fail(`create project expected 201; got ${projRes.status} ${projRes.raw.slice(0, 300)}`);
    return;
  }
  const project = projRes.body?.data ?? projRes.body;
  pass(`project id=${project.id} title=${project.title}`);

  // ---- Step 3: create first scene (default) ----
  out.push('-- create first scene (hydrovision, default) --');
  const sc1Res = await authedJson(admin.token, `/crm/projects/${project.id}/scenes`, 'POST', {
    title: 'Overview',
    center_lat: 40.7128,
    center_lon: -74.0060,
    zoom: 12,
    basemap_id: 'hydrovision',
    is_default: true,
    active_layers: ['leaks','aoi'],
  });
  if (sc1Res.status !== 201) {
    fail(`create scene 1 expected 201; got ${sc1Res.status} ${sc1Res.raw.slice(0, 300)}`);
    return;
  }
  const scene1 = sc1Res.body?.data ?? sc1Res.body;
  pass(`scene1 id=${scene1.id} is_default=${scene1.is_default} basemap=${scene1.basemap_id}`);

  // ---- Step 4: create second scene (thermsight, non-default) ----
  out.push('-- create second scene (thermsight) --');
  const sc2Res = await authedJson(admin.token, `/crm/projects/${project.id}/scenes`, 'POST', {
    title: 'Thermal close-up',
    center_lat: 40.71,
    center_lon: -74.00,
    zoom: 16,
    basemap_id: 'thermsight',
    is_default: false,
    sar_overlay: true,
    sar_opacity: 75,
  });
  if (sc2Res.status !== 201) {
    fail(`create scene 2 expected 201; got ${sc2Res.status} ${sc2Res.raw.slice(0, 300)}`);
    return;
  }
  const scene2 = sc2Res.body?.data ?? sc2Res.body;
  pass(`scene2 id=${scene2.id} is_default=${scene2.is_default} basemap=${scene2.basemap_id}`);

  // ---- Step 5: set-default on second scene ----
  out.push('-- set-default on second scene --');
  const sdRes = await authedJson(admin.token,
    `/crm/projects/${project.id}/scenes/${scene2.id}/set-default`, 'POST', {});
  if (sdRes.status !== 200) {
    fail(`set-default expected 200; got ${sdRes.status} ${sdRes.raw.slice(0, 300)}`);
    return;
  }
  const promoted = sdRes.body?.data ?? sdRes.body;
  if (promoted.is_default === true && promoted.id === scene2.id) {
    pass(`scene2 promoted: is_default=true`);
  } else {
    fail(`scene2 not promoted: ${JSON.stringify(promoted)}`);
  }

  // ---- Step 6: list scenes; expect exactly one is_default=true (scene2) ----
  out.push('-- list scenes --');
  const listRes = await authedGet(admin.token, `/crm/projects/${project.id}/scenes`);
  if (listRes.status !== 200) {
    fail(`list scenes expected 200; got ${listRes.status} ${listRes.raw.slice(0, 300)}`);
    return;
  }
  const scenes = listRes.body?.data ?? listRes.body;
  info(`scenes returned: ${scenes.length}`);
  if (scenes.length !== 2) fail(`expected 2 scenes; got ${scenes.length}`);
  else                     pass('scene count=2');
  const defaults = scenes.filter((s) => s.is_default === true);
  if (defaults.length !== 1) fail(`expected exactly 1 default; got ${defaults.length}`);
  else if (defaults[0].id !== scene2.id) fail(`wrong scene marked default: ${defaults[0].id}`);
  else pass(`default=${defaults[0].id} (scene2)`);
  // Confirm scene1 is_default flipped to false
  const sc1After = scenes.find((s) => s.id === scene1.id);
  if (sc1After && sc1After.is_default === false) pass('scene1 is_default=false after promotion');
  else fail(`scene1 not demoted: ${JSON.stringify(sc1After)}`);

  // ---- Step 7: negative test — customer.viewer scope ----
  out.push('-- customer.viewer scope check --');
  const custEmail = 'qa-s14a-customer@demoville-a.local';
  // Login the user so user_profile row exists.
  const cust1 = await login(custEmail);
  const userR = await pool.query(
    `SELECT id FROM iam.user_profile WHERE tenant_id = $1 AND email = $2`,
    [tenantId, custEmail]);
  const custUserId = cust1.user?.id ?? userR.rows[0]?.id;
  if (!custUserId) { fail('cannot resolve customer user id'); return; }
  // Grant customer.viewer role.
  await pool.query(
    `INSERT INTO iam.user_role (user_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = 'customer.viewer' AND r.tenant_id IS NULL
     ON CONFLICT DO NOTHING`,
    [custUserId]);
  // Reset legacy roles so the user is NOT staff-shaped (no 'sales:manage').
  await pool.query(
    `UPDATE iam.user_profile SET roles = ARRAY['customer:view'] WHERE id = $1`, [custUserId]);
  // Bust the policy cache via API
  await fetch(`${BASE}/api/v1/iam/admin/bust-policy-cache`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  // Re-login to pick up legacy roles + freshly-hydrated permissions.
  const cust = await login(custEmail);
  pass(`customer token len=${cust.token.length}`);
  const cListRes = await authedGet(cust.token, '/crm/projects');
  info(`customer list status=${cListRes.status}`);
  if (cListRes.status !== 200) {
    fail(`customer GET /crm/projects expected 200; got ${cListRes.status} ${cListRes.raw.slice(0, 300)}`);
  } else {
    const arr = cListRes.body?.data ?? cListRes.body;
    if (Array.isArray(arr)) {
      // The customer has no sales.contact linkage to the freshly-created project,
      // so scope must return [].
      if (arr.length === 0) pass(`customer.viewer scoped to 0 projects (no linkage)`);
      else                  fail(`customer.viewer over-scoped: returned ${arr.length} projects: ${JSON.stringify(arr).slice(0, 200)}`);
    } else {
      fail(`customer list returned non-array body: ${JSON.stringify(cListRes.body).slice(0, 200)}`);
    }
  }

  // Also confirm /customer/me/projects returns [] for this user.
  const meRes = await authedGet(cust.token, '/customer/me/projects');
  info(`/customer/me/projects status=${meRes.status}`);
  if (meRes.status === 200) {
    const meArr = meRes.body?.data ?? meRes.body;
    if (Array.isArray(meArr) && meArr.length === 0) pass(`/customer/me/projects = [] (correct)`);
    else fail(`/customer/me/projects expected []; got ${JSON.stringify(meArr).slice(0, 200)}`);
  } else {
    fail(`/customer/me/projects expected 200; got ${meRes.status} ${meRes.raw.slice(0, 200)}`);
  }

  // ---- Step 8: link the customer via sales.contact + crm.project.customer_contact_id ----
  out.push('-- link customer to project via customer_contact_id --');
  // Idempotent insert (delete-then-insert is cleanest given the partial unique).
  await pool.query(
    `DELETE FROM sales.contact WHERE tenant_id = $1 AND lower(email) = lower($2)`,
    [tenantId, custEmail]);
  const contactRes = await pool.query(
    `INSERT INTO sales.contact (tenant_id, first_name, last_name, email, status)
     VALUES ($1, 'QA', 'Customer', $2, 'active') RETURNING id`,
    [tenantId, custEmail]);
  const contactId = contactRes.rows[0]?.id;
  info(`contact id=${contactId}`);
  await pool.query(
    `UPDATE crm.project SET customer_contact_id = $1 WHERE id = $2`,
    [contactId, project.id]);

  // Invalidate the in-process customer scope cache by waiting for TTL OR re-logging in.
  // The scope module's in-process cache is on the test server; force a token-refresh login.
  const cust2 = await login(custEmail);
  // Wait briefly so any second-of-resolution diffs settle, then re-query.
  await delay(50);

  // Restart server so the customerScope in-process cache is cleared. Cheaper than implementing a bust endpoint.
  stopServer();
  await delay(300);
  await startServer();

  const cust3 = await login(custEmail);
  const meAfterRes = await authedGet(cust3.token, '/customer/me/projects');
  if (meAfterRes.status === 200) {
    const arr = meAfterRes.body?.data ?? meAfterRes.body;
    if (Array.isArray(arr) && arr.find((p) => p.id === project.id)) {
      pass(`/customer/me/projects now includes our project after linkage`);
    } else {
      fail(`/customer/me/projects missing the linked project: ${JSON.stringify(arr).slice(0, 200)}`);
    }
  } else {
    fail(`/customer/me/projects after linkage expected 200; got ${meAfterRes.status} ${meAfterRes.raw.slice(0, 200)}`);
  }

  // Customer reads scenes for the project — read-only.
  const meScenes = await authedGet(cust3.token, `/customer/me/projects/${project.id}/scenes`);
  if (meScenes.status === 200) {
    const arr = meScenes.body?.data ?? meScenes.body;
    if (Array.isArray(arr) && arr.length === 2) pass(`/customer/me/projects/:id/scenes returned 2 scenes`);
    else fail(`scenes expected 2 got ${arr?.length}`);
  } else {
    fail(`/customer/me/projects/:id/scenes expected 200; got ${meScenes.status}`);
  }

  // Negative: customer cannot POST to /crm/projects/:id/scenes
  out.push('-- customer write attempt should 403 --');
  const denyRes = await authedJson(cust3.token, `/crm/projects/${project.id}/scenes`, 'POST', {
    title: 'sneaky', basemap_id: 'satellite',
  });
  if (denyRes.status === 403) pass('customer.viewer write denied (403)');
  else fail(`customer write expected 403; got ${denyRes.status} ${denyRes.raw.slice(0, 200)}`);

  // Negative: invalid basemap_id rejected with 400 validation_failed
  out.push('-- validator: bad basemap_id --');
  const badRes = await authedJson(admin.token, `/crm/projects/${project.id}/scenes`, 'POST', {
    title: 'Bad', basemap_id: 'not_a_basemap',
  });
  if (badRes.status === 400 && /validation_failed/.test(JSON.stringify(badRes.body))) {
    pass('invalid basemap_id rejected with validation_failed');
  } else {
    fail(`expected 400 validation_failed; got ${badRes.status} ${badRes.raw.slice(0, 200)}`);
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
out.push(failures === 0 ? 'qa-s14a-flow PASS' : `qa-s14a-flow FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s14a-flow-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
