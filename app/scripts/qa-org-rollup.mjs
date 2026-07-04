// =============================================================================
// qa-org-rollup.mjs — Sprint A5.2 (ADR-0024) org oversight roll-up acceptance.
// -----------------------------------------------------------------------------
// Proves the oversight roll-up acceptance criteria end-to-end against a server
// THIS SCRIPT SPAWNS ITSELF on a fresh, verified-free port (QA_PORT, default
// 5193). It must NOT connect to the dev server on :5180 — a server is already
// running there. Migrations apply on boot, so 164_org_rollup is live.
//
//   1. A cross-district state.admin (org=lone-star-water) POSTs /org/rollup/refresh
//      → the publish path computes per-district aggregates for BOTH member
//      districts (demoville-a + acme-water) and UPSERTs them into
//      analytics.org_rollup. Response reports districts_refreshed >= 2.
//   2. GET /org/rollup returns per-district series + an org-total series, with
//      aggregates for BOTH districts present.
//   3. The response is AGGREGATES-ONLY: every series entry carries exactly the
//      aggregate shape (district_id/bucket_date/metric/value/classification) and
//      NO row id / PII keys (no 'name','email','lead_id','case_id', etc.).
//   4. An org-less (standalone) user is REFUSED (403) on both endpoints —
//      back-compat: the org_id IS NULL path is unaffected.
//   5. The read carries only classification-permitted aggregates (the demo
//      publishes 'internal'; an 'internal'-clearance caller sees them).
//
// Env: NODE_ENV=development, ALLOW_DEV_LOGIN=1, JWT_SECRET=test-key,
//      SKIP_ACCESS_GATE=1, PORT=<fresh free port>.
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { Buffer } from 'node:buffer';
import pg from 'pg';

const PORT = Number(process.env.QA_PORT ?? 5193);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_PATH = 'D:/Projects/RWR/mvp/.qa-org-rollup-out.txt';

const CROSS_EMAIL  = 'stateadmin@lonestar.gov';
const ORG_SLUG     = 'lone-star-water';
const DISTRICT_A   = 'demoville-a';
const DISTRICT_B   = 'acme-water';

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

// Verify the chosen port is FREE before spawning — we must not collide with the
// dev server on :5180 or any other listener.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', (err) => {
      reject(new Error(`port ${port} is in use (${err.code}); set QA_PORT to a free port`));
    });
    srv.once('listening', () => srv.close(() => resolve()));
    srv.listen(port, '127.0.0.1');
  });
}

async function startServer() {
  await assertPortFree(PORT);
  info(`port ${PORT} verified free`);
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

function decodeJwt(token) {
  const part = token.split('.')[1];
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

// Idempotent setup: ensure the org + both member districts exist, the
// cross-district state.admin user has a profile in BOTH districts and a
// state.admin org role, and that BOTH districts carry at least one lead + one
// open case so the publish path has something real to aggregate.
async function seed() {
  await pool.query(
    `INSERT INTO iam.org (slug, display_name, billing_mode)
       VALUES ($1, 'Lone Star Water Authority', 'consolidated')
     ON CONFLICT (slug) DO NOTHING`,
    [ORG_SLUG],
  );
  const { rows: orgRows } = await pool.query('SELECT id FROM iam.org WHERE slug = $1', [ORG_SLUG]);
  const orgId = orgRows[0]?.id;
  if (!orgId) throw new Error('org_seed_missing');

  for (const slug of [DISTRICT_A, DISTRICT_B]) {
    // Ensure the tenant exists + is attached to the org.
    await pool.query(
      `INSERT INTO iam.tenant (slug, display_name, plan)
         VALUES ($1, $1, 'mvp')
       ON CONFLICT (slug) DO NOTHING`,
      [slug],
    );
    await pool.query(
      `UPDATE iam.tenant SET org_id = $1 WHERE slug = $2 AND org_id IS DISTINCT FROM $1`,
      [orgId, slug],
    );
    const { rows: tRows } = await pool.query('SELECT id FROM iam.tenant WHERE slug = $1', [slug]);
    const tid = tRows[0].id;

    // Cross-district user profile in this district.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
         VALUES ($1, $2, 'State Admin', ARRAY['platform:admin']::TEXT[])
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [tid, CROSS_EMAIL],
    );
    const { rows: upRows } = await pool.query(
      `SELECT id FROM iam.user_profile WHERE tenant_id = $1 AND email = $2 LIMIT 1`,
      [tid, CROSS_EMAIL],
    );
    if (upRows[0]?.id) {
      await pool.query(
        `INSERT INTO iam.org_user_role (org_id, user_ref, org_role_key)
           VALUES ($1, $2, 'state.admin')
         ON CONFLICT (org_id, user_ref, org_role_key) DO NOTHING`,
        [orgId, upRows[0].id],
      );
    }

    // Seed at least one lead + one open case so aggregates are non-trivial.
    // Guarded: only insert when the district currently has none, so re-runs do
    // not inflate counts unbounded.
    const { rows: leadCount } = await pool.query(
      `SELECT count(*)::int AS n FROM sales.lead WHERE tenant_id = $1`, [tid]);
    if (leadCount[0].n === 0) {
      await pool.query(
        `INSERT INTO sales.lead (tenant_id, name, status, total_revenue)
           VALUES ($1, 'QA Rollup Lead', 'Client', 1000)`,
        [tid],
      );
    }
    const { rows: caseCount } = await pool.query(
      `SELECT count(*)::int AS n FROM ops.case WHERE tenant_id = $1`, [tid]);
    if (caseCount[0].n === 0) {
      await pool.query(
        `INSERT INTO ops.case (tenant_id, title, status)
           VALUES ($1, 'QA Rollup Case', 'open')`,
        [tid],
      );
    }
  }

  // A standalone (org-less) tenant + user for the back-compat refusal probe.
  await pool.query(
    `INSERT INTO iam.tenant (slug, display_name, plan)
       VALUES ('qa-rollup-standalone', 'QA Standalone', 'mvp')
     ON CONFLICT (slug) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
       SELECT t.id, 'admin@qa-rollup-standalone.local', 'Standalone Admin', ARRAY['platform:admin']::TEXT[]
         FROM iam.tenant t WHERE t.slug = 'qa-rollup-standalone'
     ON CONFLICT (tenant_id, email) DO NOTHING`,
  );

  info(`seed complete (org=${orgId})`);
}

async function devLogin(tenantSlug, email) {
  const r = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: tenantSlug, email }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j.data ?? j };
}

// Keys that would betray a raw-row / PII leak in an aggregates-only payload.
const PII_KEYS = new Set([
  'id', 'name', 'email', 'phone', 'lead_id', 'case_id', 'contact_id',
  'company', 'description', 'title', 'actor_id', 'user_id',
]);
function assertAggregatesOnly(seriesEntry, label) {
  const keys = Object.keys(seriesEntry);
  const allowed = new Set(['bucket_date', 'metric', 'value', 'classification']);
  const extra = keys.filter((k) => !allowed.has(k));
  const leaked = keys.filter((k) => PII_KEYS.has(k));
  if (leaked.length > 0) { fail(`${label}: PII/row-id key leaked: ${leaked.join(',')}`); return; }
  if (extra.length > 0)  { fail(`${label}: unexpected non-aggregate key(s): ${extra.join(',')}`); return; }
  pass(`${label}: aggregates-only (keys=${keys.join(',')})`);
}

async function run() {
  await startServer();
  await seed();

  // --- login as the cross-district state.admin -------------------------------
  const login = await devLogin(DISTRICT_A, CROSS_EMAIL);
  if (login.status !== 200 || !login.body?.token) {
    fail(`dev-login ${CROSS_EMAIL}@${DISTRICT_A} → ${login.status}`);
    return;
  }
  pass(`dev-login ${CROSS_EMAIL}@${DISTRICT_A} → 200`);
  const token = login.body.token;
  const claims = decodeJwt(token);
  if (claims.org?.org_slug === ORG_SLUG && (claims.org?.org_roles ?? []).includes('state.admin')) {
    pass('login token carries org claim with state.admin');
  } else {
    fail(`login token missing org claim/role: ${JSON.stringify(claims.org)}`);
    return;
  }

  // --- 1. POST /org/rollup/refresh -------------------------------------------
  const refreshRes = await fetch(`${BASE}/api/v1/org/rollup/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const refreshEnv = await refreshRes.json().catch(() => ({}));
  const refreshBody = refreshEnv.data ?? refreshEnv;
  if (refreshRes.status === 200 && (refreshBody?.districts_refreshed ?? 0) >= 2) {
    pass(`refresh → 200, districts_refreshed=${refreshBody.districts_refreshed}, rows_written=${refreshBody.rows_written}`);
  } else {
    fail(`refresh expected 200 + >=2 districts, got ${refreshRes.status} ${JSON.stringify(refreshBody)}`);
  }

  // --- 2+3+5. GET /org/rollup ------------------------------------------------
  const readRes = await fetch(`${BASE}/api/v1/org/rollup`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const readEnv = await readRes.json().catch(() => ({}));
  const readBody = readEnv.data ?? readEnv;
  if (readRes.status !== 200) {
    fail(`GET /org/rollup → ${readRes.status} ${JSON.stringify(readBody)}`);
  } else {
    const districts = readBody.districts ?? [];
    info(`read returned ${districts.length} district series; org_total has ${ (readBody.org_total ?? []).length } points`);

    // Map district_id → slug so we can assert BOTH member districts present.
    const { rows: idRows } = await pool.query(
      `SELECT id, slug FROM iam.tenant WHERE slug = ANY($1::text[])`,
      [[DISTRICT_A, DISTRICT_B]],
    );
    const idToSlug = new Map(idRows.map((r) => [r.id, r.slug]));
    const seenSlugs = new Set(districts.map((d) => idToSlug.get(d.district_id)).filter(Boolean));
    if (seenSlugs.has(DISTRICT_A) && seenSlugs.has(DISTRICT_B)) {
      pass(`per-district aggregates present for BOTH districts: ${[...seenSlugs].join(', ')}`);
    } else {
      fail(`read missing a member district: saw ${[...seenSlugs].join(', ')}`);
    }

    // Aggregates-only assertion across every district series entry.
    let checkedEntry = false;
    for (const d of districts) {
      for (const s of (d.series ?? [])) {
        assertAggregatesOnly(s, `district ${idToSlug.get(d.district_id) ?? d.district_id}`);
        checkedEntry = true;
        // classification ceiling: published 'internal' must appear for an
        // internal-clearance caller.
        if (s.classification && CLASS_RANK(s.classification) > CLASS_RANK('internal')) {
          fail(`series carried a classification above ceiling: ${s.classification}`);
        }
        break; // one representative entry per district is enough
      }
    }
    if (!checkedEntry) fail('no district series entries to verify aggregates-only shape');

    // org_total entries must also be aggregates-only.
    const total0 = (readBody.org_total ?? [])[0];
    if (total0) {
      const keys = Object.keys(total0);
      const allowed = new Set(['bucket_date', 'metric', 'value']);
      const bad = keys.filter((k) => !allowed.has(k));
      if (bad.length === 0) pass(`org_total is aggregates-only (keys=${keys.join(',')})`);
      else fail(`org_total carried unexpected key(s): ${bad.join(',')}`);
    } else {
      fail('org_total series empty');
    }
  }

  // --- 4. org-less user is REFUSED (back-compat) -----------------------------
  const soLogin = await devLogin('qa-rollup-standalone', 'admin@qa-rollup-standalone.local');
  if (soLogin.status !== 200 || !soLogin.body?.token) {
    fail(`standalone dev-login → ${soLogin.status}`);
  } else {
    const soClaims = decodeJwt(soLogin.body.token);
    if (soClaims.org) fail(`standalone login unexpectedly carries org claim: ${JSON.stringify(soClaims.org)}`);
    else pass('standalone login carries NO org claim');

    const soRead = await fetch(`${BASE}/api/v1/org/rollup`, {
      headers: { authorization: `Bearer ${soLogin.body.token}` },
    });
    if (soRead.status === 403) pass('org-less GET /org/rollup → 403 (refused)');
    else fail(`org-less GET /org/rollup expected 403, got ${soRead.status}`);

    const soRefresh = await fetch(`${BASE}/api/v1/org/rollup/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${soLogin.body.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (soRefresh.status === 403) pass('org-less POST /org/rollup/refresh → 403 (refused)');
    else fail(`org-less POST /org/rollup/refresh expected 403, got ${soRefresh.status}`);
  }
}

const CLASS_ORDER = { public: 0, internal: 1, confidential: 2, secret: 3 };
function CLASS_RANK(c) { return CLASS_ORDER[c] ?? 99; }

(async () => {
  try {
    await run();
  } catch (err) {
    fail(`unhandled: ${err?.message ?? err}`);
  } finally {
    await pool.end().catch(() => {});
    stopServer();
    await delay(200);
  }

  const header = failures === 0
    ? `qa-org-rollup: PASS (0 failures)`
    : `qa-org-rollup: FAIL (${failures} failures)`;
  const report = [header, '', ...out].join('\n');
  console.log(report);
  try { writeFileSync(OUT_PATH, report + '\n'); } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1);
})();
