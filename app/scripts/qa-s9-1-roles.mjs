// =============================================================================
// qa-s9-1-roles.mjs — Sprint 9.1 role hierarchy E2E.
// -----------------------------------------------------------------------------
// 1) dev-login admin@demoville-a.local (platform.admin)
// 2) GET /api/v1/field/jobs → 200 (regression — was 403 before migration 145)
// 3) Create an ops.field_specialist user via /iam/users + grant role via SQL
// 4) dev-login the specialist → primarySurfaceForRoles routes to field.html
// 5) GET /api/v1/field/jobs as the specialist → 200 (has field.job.read)
// 6) POST /api/v1/field/jobs as the specialist → 403 (lacks field.job.write)
// 7) Create an ops.coordinator user + grant role
// 8) dev-login as coordinator; POST /api/v1/field/jobs → 200
// 9) coordinator cannot POST /field/location → 403 (dispatchers don't post GPS)
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import pg from 'pg';

// Mirror of src/crm/lib/auth-store.ts `primarySurfaceForRoles`. Kept in sync
// by hand — the QA script can't import .ts files without a loader, so any
// change to the TS function must be mirrored here. The qa-s9-1-signout.mjs
// script greps the built bundle for the same behaviour as a back-stop.
function primarySurfaceForRoles(roles) {
  if (roles.includes('platform:admin'))      return 'tenants.html';
  if (roles.some((r) => String(r).startsWith('vendor:'))) return 'vendor.html';
  if (roles.includes('ops.field_specialist') ||
      roles.includes('field.technician') ||
      roles.includes('field:technician')) return 'field.html';
  if (roles.includes('ops.coordinator'))     return 'operations.html';
  if (roles.includes('ops:manage'))          return 'operations.html';
  if (roles.includes('sales:manage'))        return 'sales.html';
  if (roles.includes('analytics:view'))      return 'analytics.html';
  if (roles.includes('customer:view'))       return 'customer.html';
  if (roles.includes('dashboard:view'))      return 'dashboard.html';
  return 'login.html';
}

const PRIMARY_PORT  = Number(process.env.QA_PORT ?? 5191);
const FALLBACK_PORT = 5192;
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
  info(`port ${PRIMARY_PORT} busy, trying ${FALLBACK_PORT}`);
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
    // S10B — bypass the pilot access-code gate so the role regression can
    // exercise /api/v1/* directly without first POSTing /access/verify.
    SKIP_ACCESS_GATE: '1',
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
    } catch (_e) {}
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

async function bustCache(token) {
  await fetch(`${BASE}/api/v1/iam/admin/bust-policy-cache`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': 'application/json' }),
  });
}

async function ensureUserWithRole(tenantId, email, roleKey, legacyRoles) {
  // upsert user_profile (idempotent — same shape dev-login uses)
  const ur = await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (tenant_id, email)
       DO UPDATE SET roles = EXCLUDED.roles, status = 'active'
     RETURNING id`,
    [tenantId, email, email.split('@')[0], legacyRoles]
  );
  const userId = ur.rows[0].id;
  // Grant the canonical role via iam.user_role.
  await pool.query(
    `INSERT INTO iam.user_role (user_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = $2 AND r.tenant_id IS NULL
     ON CONFLICT DO NOTHING`,
    [userId, roleKey]
  );
  return userId;
}

async function run() {
  await startServer();

  // Tenant lookup
  const t = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
  if (!t.rows.length) { fail('tenant slug missing'); return; }
  const tenantId = t.rows[0].id;
  info(`tenant=${tenantId}`);

  // -- Step 1: admin login --
  out.push('-- step 1: admin login (platform.admin) --');
  const admin = await login('admin@demoville-a.local');
  pass(`admin token len=${admin.token.length}`);

  // Bust cache so any stale pre-145 perm set is gone.
  await bustCache(admin.token);
  pass('policy cache busted via /iam/admin/bust-policy-cache');

  // -- Step 2: GET /field/jobs as admin --
  out.push('-- step 2: GET /field/jobs as platform.admin --');
  const adminJobs = await authedGet(admin.token, '/field/jobs');
  if (adminJobs.status === 200) {
    pass(`platform.admin can GET /field/jobs (status 200, ${(adminJobs.body?.data?.length ?? 0)} jobs)`);
  } else {
    fail(`platform.admin GET /field/jobs expected 200; got ${adminJobs.status} ${adminJobs.raw.slice(0, 200)}`);
  }

  // -- Step 3: provision ops.field_specialist user --
  out.push('-- step 3: provision ops.field_specialist user --');
  const fsEmail = 'qa-s9-1-fs@demoville-a.local';
  const fsId = await ensureUserWithRole(
    tenantId, fsEmail, 'ops.field_specialist', ['dashboard:view']
  );
  pass(`ops.field_specialist user id=${fsId}`);

  // -- Step 4: dev-login specialist; check primary surface routing --
  out.push('-- step 4: specialist dev-login + primary-surface check --');
  const fs = await login(fsEmail);
  // Bust cache so the new role assignment is honored on first hit.
  await bustCache(admin.token);
  // For non-admin emails, dev-login overrides roles[] to DEFAULT_ROLES
  // (['dashboard:view']). We instead simulate the post-IdP shape by reading
  // user_profile.roles back from the DB and resolving the surface.
  const profRoles = (await pool.query(
    `SELECT roles FROM iam.user_profile WHERE id = $1`, [fsId]
  )).rows[0].roles ?? [];
  // Include the canonical role-key so routing reflects production where
  // role-keys come back via /auth/whoami.
  const rolesForSurface = [...profRoles, 'ops.field_specialist'];
  const surface = primarySurfaceForRoles(rolesForSurface);
  if (surface === 'field.html') {
    pass(`primarySurfaceForRoles(${JSON.stringify(rolesForSurface)}) → field.html`);
  } else {
    fail(`primarySurfaceForRoles routed to ${surface}; expected field.html`);
  }

  // -- Step 5: specialist GET /field/jobs --
  out.push('-- step 5: specialist GET /field/jobs --');
  const fsJobs = await authedGet(fs.token, '/field/jobs');
  if (fsJobs.status === 200) {
    pass(`specialist can GET /field/jobs (has field.job.read)`);
  } else {
    fail(`specialist GET /field/jobs expected 200; got ${fsJobs.status} ${fsJobs.raw.slice(0, 200)}`);
  }

  // -- Step 6: specialist POST /field/jobs → 403 --
  out.push('-- step 6: specialist POST /field/jobs (expect 403) --');
  const fsCreate = await authedJson(fs.token, '/field/jobs', 'POST', {
    title: 'should-be-rejected', lat: 40.7128, lon: -74.0060,
  });
  if (fsCreate.status === 403) {
    pass(`specialist POST /field/jobs rejected with 403 (lacks field.job.write)`);
  } else {
    fail(`specialist POST /field/jobs expected 403; got ${fsCreate.status} ${fsCreate.raw.slice(0, 200)}`);
  }

  // -- Step 7: provision ops.coordinator user --
  out.push('-- step 7: provision ops.coordinator user --');
  const coordEmail = 'qa-s9-1-coord@demoville-a.local';
  const coordId = await ensureUserWithRole(
    tenantId, coordEmail, 'ops.coordinator', ['dashboard:view']
  );
  pass(`ops.coordinator user id=${coordId}`);

  // -- Step 8: coordinator POST /field/jobs → 200/201 --
  out.push('-- step 8: coordinator POST /field/jobs (expect 201) --');
  const coord = await login(coordEmail);
  await bustCache(admin.token);
  const coordCreate = await authedJson(coord.token, '/field/jobs', 'POST', {
    title: 'qa-s9-1 coord job', lat: 40.7128, lon: -74.0060, geofence_radius_m: 80,
  });
  if (coordCreate.status === 201) {
    pass(`coordinator POST /field/jobs OK (id=${coordCreate.body?.data?.id ?? coordCreate.body?.id})`);
  } else {
    fail(`coordinator POST /field/jobs expected 201; got ${coordCreate.status} ${coordCreate.raw.slice(0, 300)}`);
  }

  // -- Step 9: coordinator POST /field/location → 403 --
  out.push('-- step 9: coordinator POST /field/location (expect 403) --');
  const coordLoc = await authedJson(coord.token, '/field/location', 'POST', {
    lat: 40.7128, lon: -74.0060, accuracy_m: 5,
  });
  if (coordLoc.status === 403) {
    pass(`coordinator POST /field/location rejected with 403 (lacks field.location.write)`);
  } else {
    fail(`coordinator POST /field/location expected 403; got ${coordLoc.status} ${coordLoc.raw.slice(0, 200)}`);
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
out.push(failures === 0 ? 'qa-s9-1-roles PASS' : `qa-s9-1-roles FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s9-1-roles-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
