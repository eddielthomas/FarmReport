// =============================================================================
// qa-s10b-gate.mjs — Sprint 10B access-code gate E2E.
// -----------------------------------------------------------------------------
// 1.  GET /sales.html without cookie → 302 → /access.html?next=/sales.html
// 2.  POST /api/v1/access/verify { code: 'WRONG' } → 401 + structured failure
//     logged (stderr) — we assert the response shape, not the stderr line.
// 3.  POST /api/v1/access/verify { code: 'RWR-DEMO-2026' } → 200 + cookie
//     + pass_token in body
// 4.  GET /sales.html with cookie → 200
// 5.  GET /index.html without cookie → 200 (marketing bypass)
// 6.  GET /access.html without cookie → 200 (self bypass)
// 7.  GET /healthz without cookie → 200
// 8.  GET /api/v1/healthz without cookie → 200
// 9.  POST /api/v1/auth/dev-login without cookie → 200 (auth bypass)
// 10. With SKIP_ACCESS_GATE=1 NODE_ENV=development, GET /sales.html → 200
//
// Audit verification: confirms a row in iam.audit_event with action
// 'access.verify.success' was written for tenant-scoped success cases.
// (The platform-global code we seed has tenant_id IS NULL so the success
// path journals to stderr instead — see access.mjs.)
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import pg from 'pg';

const PRIMARY_PORT  = Number(process.env.QA_PORT ?? 5193);
const FALLBACK_PORT = 5194;
const TENANT_SLUG   = 'demoville-a';

const PLATFORM_CODE  = 'RWR-DEMO-2026';
const TENANT_CODE    = 'RWR-DEMOVILLE-2026';

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

async function startServer(extraEnv = {}) {
  PORT = await pickPort();
  BASE = `http://127.0.0.1:${PORT}`;
  out.push(`-- starting server on :${PORT} env=${JSON.stringify(extraEnv)} --`);
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
    ...extraEnv,
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
  serverProc = null;
}

// Plain fetch wrappers — we deliberately keep cookies manually so each step
// is explicit about what auth context it carries.
async function rawGet(path, { cookie, redirect = 'manual' } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${path}`, { method: 'GET', headers, redirect });
  return r;
}

async function rawPost(path, body, { cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    redirect: 'manual',
  });
  return r;
}

function extractAccessPassCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // node fetch returns set-cookie as a single concatenated string OR uses
  // getSetCookie() in newer versions. We split on the first attribute boundary.
  const parts = setCookieHeader.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
  for (const part of parts) {
    const m = part.match(/(^|;\s*)(rwr\.access_pass)=([^;]+)/);
    if (m) return `${m[2]}=${m[3]}`;
  }
  return null;
}

function extractCookiePair(r) {
  // Prefer the standard headers.getSetCookie() if available (Node 19.7+).
  if (typeof r.headers.getSetCookie === 'function') {
    const arr = r.headers.getSetCookie();
    for (const c of arr) {
      const m = c.match(/^(rwr\.access_pass)=([^;]+)/);
      if (m) return `${m[1]}=${m[2]}`;
    }
    return null;
  }
  return extractAccessPassCookie(r.headers.get('set-cookie'));
}

async function run() {
  // ---------------------------------------------------------------------
  // Phase A — normal (no escape hatch)
  // ---------------------------------------------------------------------
  await startServer();

  // Step 1 — gated HTML without cookie → 302
  out.push('-- step 1: GET /sales.html without cookie expect 302 → /access.html --');
  {
    const r = await rawGet('/sales.html');
    if (r.status === 302) {
      const loc = r.headers.get('location') || '';
      if (loc.startsWith('/access.html?next=')) {
        pass(`302 → ${loc}`);
      } else {
        fail(`302 but wrong Location: ${loc}`);
      }
    } else {
      fail(`expected 302 got ${r.status}`);
    }
  }

  // Step 2 — bad code
  out.push('-- step 2: POST /api/v1/access/verify { code: WRONG } expect 401 --');
  {
    const r = await rawPost('/api/v1/access/verify', { code: 'WRONG' });
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body?.error === 'invalid_code') {
        pass(`401 invalid_code (${JSON.stringify(body)})`);
      } else {
        fail(`401 but unexpected body: ${JSON.stringify(body)}`);
      }
    } else {
      fail(`expected 401 got ${r.status}`);
    }
  }

  // Step 3 — good code (platform-global)
  out.push('-- step 3: POST /api/v1/access/verify { code: RWR-DEMO-2026 } expect 200 + cookie --');
  let passCookie = null;
  {
    const r = await rawPost('/api/v1/access/verify', { code: PLATFORM_CODE });
    if (r.status !== 200) {
      const body = await r.text();
      fail(`expected 200 got ${r.status} body=${body.slice(0, 200)}`);
    } else {
      const body = await r.json();
      const tok = body?.data?.pass_token;
      passCookie = extractCookiePair(r);
      if (!tok)        fail('no pass_token in body');
      else if (!passCookie) fail('no rwr.access_pass cookie in Set-Cookie');
      else pass(`pass_token len=${tok.length} cookie=${passCookie.slice(0,40)}…`);
    }
  }

  // Step 4 — gated HTML with cookie → 200
  out.push('-- step 4: GET /sales.html WITH cookie expect 200 --');
  if (passCookie) {
    const r = await rawGet('/sales.html', { cookie: passCookie });
    if (r.status === 200) {
      const ct = r.headers.get('content-type') || '';
      if (ct.startsWith('text/html')) pass(`200 text/html (${ct})`);
      else fail(`200 but wrong content-type: ${ct}`);
    } else {
      fail(`expected 200 got ${r.status}`);
    }
  } else {
    fail('skipped (no cookie from step 3)');
  }

  // Step 5 — marketing bypass
  out.push('-- step 5: GET /index.html WITHOUT cookie expect 200 (marketing bypass) --');
  {
    const r = await rawGet('/index.html');
    if (r.status === 200) pass('200 (marketing bypass works)');
    else fail(`expected 200 got ${r.status}`);
  }

  // Step 6 — access.html self bypass
  out.push('-- step 6: GET /access.html WITHOUT cookie expect 200 (self bypass) --');
  {
    const r = await rawGet('/access.html');
    if (r.status === 200) pass('200 (access.html self bypass works)');
    else fail(`expected 200 got ${r.status}`);
  }

  // Step 7 — /healthz bypass
  out.push('-- step 7: GET /healthz WITHOUT cookie expect 200 --');
  {
    const r = await rawGet('/healthz');
    if (r.status === 200) pass('200 /healthz');
    else fail(`expected 200 got ${r.status}`);
  }

  // Step 8 — /api/v1/healthz bypass
  out.push('-- step 8: GET /api/v1/healthz WITHOUT cookie expect 200 --');
  {
    const r = await rawGet('/api/v1/healthz');
    if (r.status === 200) pass('200 /api/v1/healthz');
    else fail(`expected 200 got ${r.status}`);
  }

  // Step 9 — /auth/dev-login bypass
  out.push('-- step 9: POST /api/v1/auth/dev-login WITHOUT cookie expect 200 --');
  {
    const r = await rawPost('/api/v1/auth/dev-login', {
      tenant_slug: TENANT_SLUG,
      email: 'admin@demoville-a.local',
    });
    if (r.status === 200) {
      const body = await r.json();
      const tok = body?.data?.token ?? body?.token;
      if (tok) pass(`dev-login returned token len=${tok.length}`);
      else fail(`dev-login 200 but no token in body: ${JSON.stringify(body).slice(0,200)}`);
    } else {
      fail(`expected 200 got ${r.status}`);
    }
  }

  // Audit verification — tenant-scoped code success row exists.
  out.push('-- audit check: tenant-scoped verify.success rows present --');
  {
    // Verify with the tenant-scoped code so we generate a row for the
    // demoville-a tenant.
    const r = await rawPost('/api/v1/access/verify', { code: TENANT_CODE });
    if (r.status !== 200) {
      fail(`tenant-scoped verify expected 200 got ${r.status}`);
    } else {
      // Give the (synchronous-but-await) insert a moment.
      await delay(150);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM iam.audit_event ae
           JOIN iam.tenant t ON t.id = ae.tenant_id
          WHERE ae.action = 'access.verify.success'
            AND t.slug = $1`,
        [TENANT_SLUG],
      );
      if ((rows[0]?.n ?? 0) >= 1) pass(`audit row(s) recorded n=${rows[0].n}`);
      else fail('no audit_event row for access.verify.success');
    }
  }

  stopServer();
  await delay(500);

  // ---------------------------------------------------------------------
  // Phase B — escape hatch
  // ---------------------------------------------------------------------
  out.push('-- phase B: escape hatch (SKIP_ACCESS_GATE=1) --');
  await startServer({ SKIP_ACCESS_GATE: '1' });

  // Step 10 — with escape hatch, gated HTML returns 200 without cookie
  out.push('-- step 10: GET /sales.html with SKIP_ACCESS_GATE=1 expect 200 --');
  {
    const r = await rawGet('/sales.html');
    if (r.status === 200) {
      const ct = r.headers.get('content-type') || '';
      if (ct.startsWith('text/html')) pass(`200 text/html via escape hatch`);
      else fail(`200 but wrong content-type: ${ct}`);
    } else {
      fail(`expected 200 got ${r.status}`);
    }
  }

  stopServer();
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
out.push(failures === 0 ? 'qa-s10b-gate PASS' : `qa-s10b-gate FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s10b-gate-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
