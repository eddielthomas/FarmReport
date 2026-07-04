// =============================================================================
// qa-org.mjs — Sprint A5.1 (ADR-0024) org RBAC matrix smoke.
// -----------------------------------------------------------------------------
// Proves the org-hierarchy acceptance criteria end-to-end against a live server
// (spawned on :5180; migrations apply on boot):
//
//   1. A cross-district state.admin can SEE their org + member districts via
//      GET /iam/my-orgs (org = lone-star-water; districts include the ones the
//      user is a member of under that org).
//   2. The minted login token carries the additive `org` claim block.
//   3. switch-tenant to a district the caller BELONGS to re-mints the JWT with
//      that district's tenant_id (the "re-mints correct tenant_id on switch"
//      acceptance criterion).
//   4. switch-tenant to a district the caller does NOT belong to → 403.
//   5. Back-compat: a standalone (org-less) login carries NO org claim and
//      /iam/my-orgs returns zero orgs — the org_id IS NULL path is unchanged.
//
// Setup (idempotent, via SQL): a cross-district user `stateadmin@lonestar.gov`
// is given a user_profile in BOTH demoville-a and acme-water (the two districts
// seeded under lone-star-water by migration 163) and a state.admin org_user_role
// on the org. This models a State investigator operating across districts.
//
// Env: NODE_ENV=development, ALLOW_DEV_LOGIN=1, JWT_SECRET=test-key, PORT=5180.
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import pg from 'pg';

const PORT = Number(process.env.QA_PORT ?? 5180);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_PATH = 'D:/Projects/RWR/mvp/.qa-org-out.txt';

const CROSS_EMAIL   = 'stateadmin@lonestar.gov';
const ORG_SLUG      = 'lone-star-water';
const DISTRICT_A    = 'demoville-a';   // member
const DISTRICT_B    = 'acme-water';    // member
const STANDALONE    = 'demoville-a';   // used only for the back-compat probe email

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
    // Dev escape hatch for the Sprint 10B pilot access-code gate — these org
    // endpoints are bearer-protected but sit behind the access gate; the QA
    // harness is the "human on the other side". requireAuth still owns AuthN/Z.
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

// Decode a JWT payload (no verification — we only inspect claims).
function decodeJwt(token) {
  const part = token.split('.')[1];
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

// Idempotent setup: create the cross-district user in both districts + grant
// the org role. Mirrors how migration 163 seeds the demo admin, but for a
// purpose-built cross-district email so the switch path has a real membership.
async function seedCrossDistrictUser() {
  // Ensure the org exists + districts attached (163 normally does this; we
  // re-assert so the test is robust even if seeds were skipped).
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
    await pool.query(
      `UPDATE iam.tenant SET org_id = $1 WHERE slug = $2 AND org_id IS DISTINCT FROM $1`,
      [orgId, slug],
    );
    // user_profile in this district for the cross-district user.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
         SELECT t.id, $2, 'State Admin', ARRAY['platform:admin']::TEXT[]
           FROM iam.tenant t WHERE t.slug = $1
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [slug, CROSS_EMAIL],
    );
  }

  // Grant the state.admin org role to the user's profile in district A (the
  // org claim resolves from whichever district the login lands on).
  const { rows: upRows } = await pool.query(
    `SELECT up.id FROM iam.user_profile up
       JOIN iam.tenant t ON t.id = up.tenant_id
      WHERE t.slug = $1 AND up.email = $2 LIMIT 1`,
    [DISTRICT_A, CROSS_EMAIL],
  );
  const userId = upRows[0]?.id;
  if (!userId) throw new Error('cross_user_profile_missing');
  await pool.query(
    `INSERT INTO iam.org_user_role (org_id, user_ref, org_role_key)
       VALUES ($1, $2, 'state.admin')
     ON CONFLICT (org_id, user_ref, org_role_key) DO NOTHING`,
    [orgId, userId],
  );

  // Also grant the org role to the cross-user's profile in district B so a
  // login that lands on B still resolves the org claim.
  const { rows: upRowsB } = await pool.query(
    `SELECT up.id FROM iam.user_profile up
       JOIN iam.tenant t ON t.id = up.tenant_id
      WHERE t.slug = $1 AND up.email = $2 LIMIT 1`,
    [DISTRICT_B, CROSS_EMAIL],
  );
  if (upRowsB[0]?.id) {
    await pool.query(
      `INSERT INTO iam.org_user_role (org_id, user_ref, org_role_key)
         VALUES ($1, $2, 'state.admin')
       ON CONFLICT (org_id, user_ref, org_role_key) DO NOTHING`,
      [orgId, upRowsB[0].id],
    );
  }
  info(`seeded cross-district user ${CROSS_EMAIL} (org=${orgId})`);
}

async function devLogin(tenantSlug, email) {
  const r = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: tenantSlug, email }),
  });
  const j = await r.json().catch(() => ({}));
  // Responses are wrapped in the standard { success, data } envelope.
  return { status: r.status, body: j.data ?? j };
}

async function run() {
  await startServer();
  await seedCrossDistrictUser();

  // --- 1+2. Login as the cross-district state.admin; assert org claim --------
  const login = await devLogin(DISTRICT_A, CROSS_EMAIL);
  if (login.status !== 200 || !login.body?.token) {
    fail(`dev-login ${CROSS_EMAIL}@${DISTRICT_A} → ${login.status}`);
    return;
  }
  pass(`dev-login ${CROSS_EMAIL}@${DISTRICT_A} → 200`);
  const token = login.body.token;
  const claims = decodeJwt(token);

  if (claims.org && claims.org.org_slug === ORG_SLUG) {
    pass(`login token carries org claim (org_slug=${claims.org.org_slug})`);
  } else {
    fail(`login token missing/incorrect org claim: ${JSON.stringify(claims.org)}`);
  }
  if (Array.isArray(claims.org?.org_roles) && claims.org.org_roles.includes('state.admin')) {
    pass('org claim carries state.admin org role');
  } else {
    fail(`org claim missing state.admin: ${JSON.stringify(claims.org?.org_roles)}`);
  }
  // The active tenant_id in the token must be district A.
  const { rows: dvRows } = await pool.query('SELECT id FROM iam.tenant WHERE slug=$1', [DISTRICT_A]);
  const districtAId = dvRows[0].id;
  if (claims.tenant_id === districtAId) pass(`login token tenant_id == ${DISTRICT_A}`);
  else fail(`login token tenant_id ${claims.tenant_id} != ${DISTRICT_A} (${districtAId})`);

  // --- 1. GET /iam/my-orgs → org + member districts --------------------------
  const myOrgsRes = await fetch(`${BASE}/api/v1/iam/my-orgs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const myOrgs = await myOrgsRes.json().catch(() => ({}));
  if (myOrgsRes.status !== 200) { fail(`/iam/my-orgs → ${myOrgsRes.status}`); }
  else {
    const org = (myOrgs.data?.orgs ?? []).find((o) => o.org_slug === ORG_SLUG);
    if (org) {
      pass(`/iam/my-orgs lists org ${ORG_SLUG}`);
      const slugs = (org.districts ?? []).map((d) => d.tenant_slug).sort();
      if (slugs.includes(DISTRICT_A) && slugs.includes(DISTRICT_B)) {
        pass(`my-orgs districts include both member districts: ${slugs.join(', ')}`);
      } else {
        fail(`my-orgs districts missing a member: ${slugs.join(', ')}`);
      }
      if ((org.org_roles ?? []).includes('state.admin')) pass('my-orgs org_roles include state.admin');
      else fail(`my-orgs org_roles missing state.admin: ${JSON.stringify(org.org_roles)}`);
    } else {
      fail(`/iam/my-orgs did not list ${ORG_SLUG}: ${JSON.stringify(myOrgs.data)}`);
    }
  }

  // --- 3. switch-tenant to a district the caller BELONGS to (B) → re-mint ----
  const switchOk = await fetch(`${BASE}/api/v1/auth/switch-tenant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenant_slug: DISTRICT_B }),
  });
  const switchEnv = await switchOk.json().catch(() => ({}));
  const switchBody = switchEnv.data ?? switchEnv;
  const { rows: acmeRows } = await pool.query('SELECT id FROM iam.tenant WHERE slug=$1', [DISTRICT_B]);
  const districtBId = acmeRows[0].id;
  if (switchOk.status === 200 && switchBody?.token) {
    const newClaims = decodeJwt(switchBody.token);
    if (newClaims.tenant_id === districtBId) {
      pass(`switch-tenant → ${DISTRICT_B} re-mints token with tenant_id == ${DISTRICT_B}`);
    } else {
      fail(`switch-tenant token tenant_id ${newClaims.tenant_id} != ${DISTRICT_B} (${districtBId})`);
    }
    if (newClaims.org?.org_slug === ORG_SLUG) pass('switched token retains org claim');
    else fail(`switched token missing org claim: ${JSON.stringify(newClaims.org)}`);
  } else {
    fail(`switch-tenant → ${DISTRICT_B} expected 200, got ${switchOk.status} ${JSON.stringify(switchBody)}`);
  }

  // --- 4. switch-tenant to a district the caller does NOT belong to → 403 ----
  // Create a fresh standalone tenant the cross-user is NOT a member of.
  await pool.query(
    `INSERT INTO iam.tenant (slug, display_name, plan)
       VALUES ('qa-org-foreign', 'QA Foreign District', 'mvp')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const denyRes = await fetch(`${BASE}/api/v1/auth/switch-tenant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenant_slug: 'qa-org-foreign' }),
  });
  const denyBody = await denyRes.json().catch(() => ({}));
  if (denyRes.status === 403) {
    pass('switch-tenant to a non-member district → 403 (membership enforced)');
  } else {
    fail(`switch-tenant to non-member expected 403, got ${denyRes.status} ${JSON.stringify(denyBody)}`);
  }

  // --- 5. Back-compat: org-less login carries NO org claim -------------------
  // The seeded admin@<standalone>.local in qa-org-foreign has no org → no claim.
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles)
       SELECT t.id, 'admin@qa-org-foreign.local', 'Foreign Admin', ARRAY['platform:admin']::TEXT[]
         FROM iam.tenant t WHERE t.slug = 'qa-org-foreign'
     ON CONFLICT (tenant_id, email) DO NOTHING`,
  );
  const soLogin = await devLogin('qa-org-foreign', 'admin@qa-org-foreign.local');
  if (soLogin.status === 200) {
    const soClaims = decodeJwt(soLogin.body.token);
    if (!soClaims.org) pass('standalone (org-less) login carries NO org claim (back-compat)');
    else fail(`standalone login unexpectedly carries org claim: ${JSON.stringify(soClaims.org)}`);
    const soMyRes = await fetch(`${BASE}/api/v1/iam/my-orgs`, {
      headers: { authorization: `Bearer ${soLogin.body.token}` },
    });
    const soMy = await soMyRes.json().catch(() => ({}));
    if (soMyRes.status !== 200) {
      fail(`standalone /iam/my-orgs → ${soMyRes.status} ${JSON.stringify(soMy)}`);
    } else if ((soMy.data?.orgs ?? []).length === 0) {
      pass('standalone /iam/my-orgs returns zero orgs');
    } else {
      fail(`standalone /iam/my-orgs returned orgs: ${JSON.stringify(soMy.data?.orgs)}`);
    }
  } else {
    fail(`standalone dev-login → ${soLogin.status}`);
  }
}

(async () => {
  try {
    await run();
  } catch (err) {
    fail(`unhandled: ${err?.message ?? err}`);
  } finally {
    await pool.end().catch(() => {});
    stopServer();
    await delay(200); // let the child's handles close before exit (Windows libuv)
  }

  const header = failures === 0
    ? `qa-org: PASS (0 failures)`
    : `qa-org: FAIL (${failures} failures)`;
  const report = [header, '', ...out].join('\n');
  console.log(report);
  try { writeFileSync(OUT_PATH, report + '\n'); } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1);
})();
