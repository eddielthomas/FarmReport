// =============================================================================
// qa-org-drilldown.mjs — Sprint A5.3 (ADR-0024) entitled drill-down acceptance.
// -----------------------------------------------------------------------------
// Proves the drill-down acceptance criteria against a server THIS SCRIPT SPAWNS
// on a fresh, verified-free port (QA_PORT, default 5194) — never the dev :5180.
//
//   1. A cross-district state.admin is granted drill-down into ONLY demoville-a
//      (NOT acme-water). GET /org/drilldown?district=demoville-a returns that
//      district's RAW rows (id/name present — this is the trees, not the forest).
//   2. GET /org/drilldown?district=acme-water → 403 tenant_not_entitled (the
//      un-granted district is refused).
//   3. GET /org/drilldown (no district) returns ONLY the entitled district set.
//   4. Every cross-district read emits an iam.audit_event (action
//      'org.drilldown.read', target tenant = demoville-a, actor = the caller).
//   5. POST /org/scope-grants (state.admin) grants acme-water; a subsequent
//      drill into acme-water now succeeds → grant management works + is audited.
//   6. An org-less user is REFUSED (403) — back-compat.
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

const PORT = Number(process.env.QA_PORT ?? 5194);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_PATH = 'D:/Projects/RWR/mvp/.qa-org-drilldown-out.txt';

const CROSS_EMAIL = 'driller@lonestar.gov';
const ORG_SLUG    = 'lone-star-water';
const DISTRICT_A  = 'demoville-a';   // GRANTED
const DISTRICT_B  = 'acme-water';    // NOT granted (until test 5)

const out = [];
let failures = 0;
const fail = (m) => { out.push(`  FAIL: ${m}`); failures++; };
const pass = (m) => out.push(`  PASS: ${m}`);
const info = (m) => out.push(`  INFO: ${m}`);

const cfg = {
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     Number(process.env.PGPORT ?? 5434),
  user:     process.env.PGUSER     ?? 'rwr',
  password: process.env.PGPASSWORD ?? 'rwr',
  database: process.env.PGDATABASE ?? 'rwr',
};
const pool = new pg.Pool(cfg);
let serverProc = null;

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', (err) => reject(new Error(`port ${port} in use (${err.code}); set QA_PORT`)));
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
    NODE_ENV: 'development', ALLOW_DEV_LOGIN: '1', JWT_SECRET: 'test-key',
    PORT: String(PORT), PGPORT: String(cfg.port), PGHOST: cfg.host,
    PGUSER: cfg.user, PGPASSWORD: cfg.password, PGDATABASE: cfg.database,
    EMAIL_DRAIN_DISABLED: '1', SKIP_ACCESS_GATE: '1',
  };
  serverProc = spawn(process.execPath, ['api/server.mjs'], {
    cwd: 'D:/Projects/RWR/mvp', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  serverProc.stdout.on('data', (c) => { if (process.env.QA_VERBOSE) process.stdout.write(`[srv] ${c}`); });
  serverProc.stderr.on('data', (c) => { if (process.env.QA_VERBOSE) process.stderr.write(`[srv-err] ${c}`); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) { info(`server healthy after ${i * 250}ms`); return; } }
    catch (_e) { /* retry */ }
    await delay(250);
  }
  throw new Error('server failed to start within 15s');
}
function stopServer() { if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM'); }

function decodeJwt(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const profileId = {}; // slug -> the cross user's user_profile.id in that district
let orgId, dvId, acmeId;

async function seed() {
  await pool.query(
    `INSERT INTO iam.org (slug, display_name, billing_mode)
       VALUES ($1, 'Lone Star Water Authority', 'consolidated')
     ON CONFLICT (slug) DO NOTHING`, [ORG_SLUG]);
  ({ rows: [{ id: orgId }] } = await pool.query('SELECT id FROM iam.org WHERE slug=$1', [ORG_SLUG]));

  for (const slug of [DISTRICT_A, DISTRICT_B]) {
    await pool.query(
      `INSERT INTO iam.tenant (slug, display_name, plan) VALUES ($1,$1,'mvp')
       ON CONFLICT (slug) DO NOTHING`, [slug]);
    await pool.query(
      `UPDATE iam.tenant SET org_id=$1 WHERE slug=$2 AND org_id IS DISTINCT FROM $1`, [orgId, slug]);
    const { rows: [{ id: tid }] } = await pool.query('SELECT id FROM iam.tenant WHERE slug=$1', [slug]);
    if (slug === DISTRICT_A) dvId = tid; else acmeId = tid;

    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
         VALUES ($1, $2, 'Driller', ARRAY['platform:admin']::TEXT[])
       ON CONFLICT (tenant_id, email) DO NOTHING`, [tid, CROSS_EMAIL]);
    const { rows: [{ id: upid }] } = await pool.query(
      `SELECT id FROM iam.user_profile WHERE tenant_id=$1 AND email=$2 LIMIT 1`, [tid, CROSS_EMAIL]);
    profileId[slug] = upid;
    await pool.query(
      `INSERT INTO iam.org_user_role (org_id, user_ref, org_role_key)
         VALUES ($1,$2,'state.admin') ON CONFLICT (org_id,user_ref,org_role_key) DO NOTHING`,
      [orgId, upid]);

    // Ensure each district has >=1 lead so the raw drill-down returns rows.
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int n FROM sales.lead WHERE tenant_id=$1`, [tid]);
    if (n === 0) {
      await pool.query(
        `INSERT INTO sales.lead (tenant_id, name, status, total_revenue)
           VALUES ($1, 'QA Drill Lead', 'Lead', 500)`, [tid]);
    }
  }

  // GRANT drill-down into demoville-a ONLY (acme-water stays un-granted).
  await pool.query(
    `INSERT INTO iam.org_scope_grant (org_id, user_ref, tenant_id, classification_ceiling)
       SELECT $1,$2,$3,'internal'
        WHERE NOT EXISTS (SELECT 1 FROM iam.org_scope_grant
                           WHERE org_id=$1 AND user_ref=$2 AND tenant_id=$3)`,
    [orgId, profileId[DISTRICT_A], dvId]);

  // Org-less standalone user for the back-compat refusal probe.
  await pool.query(
    `INSERT INTO iam.tenant (slug, display_name, plan) VALUES ('qa-drill-standalone','QA Standalone','mvp')
     ON CONFLICT (slug) DO NOTHING`);
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
       SELECT t.id,'admin@qa-drill-standalone.local','Standalone',ARRAY['platform:admin']::TEXT[]
         FROM iam.tenant t WHERE t.slug='qa-drill-standalone'
     ON CONFLICT (tenant_id, email) DO NOTHING`);
  info(`seed complete (org=${orgId}, demoville=${dvId}, acme=${acmeId})`);
}

async function devLogin(tenantSlug, email) {
  const r = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: tenantSlug, email }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j.data ?? j };
}

const H = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function run() {
  await startServer();
  await seed();

  const login = await devLogin(DISTRICT_A, CROSS_EMAIL);
  if (login.status !== 200 || !login.body?.token) { fail(`dev-login → ${login.status}`); return; }
  const token = login.body.token;
  const claims = decodeJwt(token);
  if ((claims.org?.org_roles ?? []).includes('state.admin')) pass('login carries state.admin org claim');
  else { fail(`login missing org claim: ${JSON.stringify(claims.org)}`); return; }

  // --- 1. entitled drill into demoville-a → raw rows -------------------------
  const r1 = await fetch(`${BASE}/api/v1/org/drilldown?resource=leads&district=${DISTRICT_A}`, { headers: H(token) });
  const b1 = (await r1.json().catch(() => ({}))).data ?? {};
  const d1 = (b1.districts ?? [])[0];
  if (r1.status === 200 && d1 && d1.row_count > 0 && d1.rows?.[0]?.id && 'name' in d1.rows[0]) {
    pass(`entitled drill demoville-a → 200, ${d1.row_count} RAW rows (id+name present)`);
  } else {
    fail(`entitled drill demoville-a expected raw rows, got ${r1.status} ${JSON.stringify(b1).slice(0,160)}`);
  }

  // --- 2. un-granted district → 403 -----------------------------------------
  const r2 = await fetch(`${BASE}/api/v1/org/drilldown?resource=leads&district=${DISTRICT_B}`, { headers: H(token) });
  const b2 = await r2.json().catch(() => ({}));
  if (r2.status === 403 && (b2.error || '').includes('not_entitled')) pass('un-granted acme-water → 403 tenant_not_entitled');
  else fail(`un-granted acme-water expected 403 tenant_not_entitled, got ${r2.status} ${JSON.stringify(b2)}`);

  // --- 3. no district → only the entitled set --------------------------------
  const r3 = await fetch(`${BASE}/api/v1/org/drilldown?resource=leads`, { headers: H(token) });
  const b3 = (await r3.json().catch(() => ({}))).data ?? {};
  const slugs3 = (b3.districts ?? []).map((d) => d.tenant_slug);
  if (r3.status === 200 && slugs3.length === 1 && slugs3[0] === DISTRICT_A) {
    pass('no-district drill returns ONLY entitled set (demoville-a)');
  } else {
    fail(`no-district drill expected only demoville-a, got ${JSON.stringify(slugs3)}`);
  }

  // --- 4. audit emitted for the cross-district read --------------------------
  await delay(600); // recordAudit is fire-and-forget
  const auditN = await auditCount('org.drilldown.read', dvId);
  if (auditN > 0) pass(`cross-district read audited → ${auditN} iam.audit_event row(s) for demoville-a`);
  else fail('no iam.audit_event row for org.drilldown.read on demoville-a');

  // --- 5. grant acme-water via API, then drill it succeeds -------------------
  const gr = await fetch(`${BASE}/api/v1/org/scope-grants`, {
    method: 'POST', headers: H(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ email: CROSS_EMAIL, tenant_slug: DISTRICT_B }),
  });
  if (gr.status === 201) pass('state.admin POST /org/scope-grants (acme-water) → 201');
  else fail(`grant acme-water expected 201, got ${gr.status} ${await gr.text().catch(()=> '')}`);
  const r5 = await fetch(`${BASE}/api/v1/org/drilldown?resource=leads&district=${DISTRICT_B}`, { headers: H(token) });
  if (r5.status === 200) pass('after grant, drill acme-water → 200 (entitlement now honoured)');
  else fail(`after grant, drill acme-water expected 200, got ${r5.status}`);

  // --- 6. org-less user refused ---------------------------------------------
  const so = await devLogin('qa-drill-standalone', 'admin@qa-drill-standalone.local');
  if (so.status === 200 && so.body?.token) {
    const sr = await fetch(`${BASE}/api/v1/org/drilldown?resource=leads`, { headers: H(so.body.token) });
    if (sr.status === 403) pass('org-less GET /org/drilldown → 403 (refused)');
    else fail(`org-less drill expected 403, got ${sr.status}`);
  } else fail(`standalone dev-login → ${so.status}`);
}

// Count audit rows under the target district's tenant GUC (so RLS, if it bites,
// still lets us see them).
async function auditCount(action, tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id',$1,true), set_config('rwr.tenant_id',$1,true)`, [tenantId]);
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM iam.audit_event WHERE action=$1 AND tenant_id=$2`, [action, tenantId]);
    await client.query('COMMIT');
    return rows[0].n;
  } catch (_e) { return 0; }
  finally { client.release(); }
}

(async () => {
  try { await run(); }
  catch (err) { fail(`unhandled: ${err?.message ?? err}`); }
  finally { await pool.end().catch(() => {}); stopServer(); await delay(200); }
  const header = failures === 0 ? 'qa-org-drilldown: PASS (0 failures)' : `qa-org-drilldown: FAIL (${failures} failures)`;
  const report = [header, '', ...out].join('\n');
  console.log(report);
  try { writeFileSync(OUT_PATH, report + '\n'); } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1);
})();
