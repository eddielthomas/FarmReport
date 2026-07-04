// =============================================================================
// qa-s5a-pins.mjs — Sprint 5A integration test for /crm/map endpoints.
// -----------------------------------------------------------------------------
// Steps:
//   1) dev-login admin@demoville-a.local
//   2) POST /sales/leads with a basic body (no location yet)
//   3) Direct-SQL update: set location = ST_SetSRID(ST_MakePoint(-73.98, 40.75), 4326)
//      and insert a sales.opportunity row with contract_status='sent'
//   4) GET /crm/map/pins → expect 1 feature with contractStatus='sent' and
//      coordinates close to [-73.98, 40.75]
//   5) GET /crm/map/pins?bbox=-180,-90,180,90 → expect same feature
//   6) GET /crm/map/pins?bbox=0,0,1,1 → expect 0 features
//   7) POST /crm/map/pins/:lead_id/visit → expect 200; assert iam.audit_event
//      has a row with action='crm.map.lead.visited' for that lead.
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
    const tRow = await pool.query(
      `SELECT id FROM iam.tenant WHERE slug = $1`,
      [TENANT_SLUG],
    );
    if (tRow.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = tRow.rows[0].id;
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
    const leadName = `GPS Lead ${stamp}`;

    // -- step 2: POST /sales/leads --
    out.push(`-- step 2: POST /sales/leads --`);
    const leadRes = await authedPost(adminLogin.token, '/sales/leads', {
      name:    leadName,
      email:   `gps-${stamp}@test.local`,
      company: 'GPS Co',
      status:  'Info Request',
      source:  'Direct',
    });
    if (leadRes.status !== 201) {
      fail(`lead create HTTP ${leadRes.status}: ${leadRes.raw.slice(0, 250)}`);
      throw new Error('lead create failed');
    }
    const leadId = leadRes.body.data.id;
    info(`lead id = ${leadId}`);
    pass(`lead created`);

    // -- step 3: set location + add opportunity with contract_status=sent --
    out.push(`-- step 3: backfill location + sent opportunity --`);
    await pool.query(
      `UPDATE sales.lead
          SET location = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography
        WHERE id = $3`,
      [-73.98, 40.75, leadId],
    );
    await pool.query(
      `INSERT INTO sales.opportunity
         (tenant_id, lead_id, name, stage, amount, contract_status)
       VALUES ($1, $2, $3, 'proposal', 10000, 'sent')`,
      [tenantId, leadId, `Opp ${stamp}`],
    );
    pass('lead.location + opportunity(contract_status=sent) seeded');

    // -- step 4: GET /crm/map/pins (no bbox) --
    out.push(`-- step 4: GET /crm/map/pins --`);
    const allRes = await authedGet(adminLogin.token, '/crm/map/pins');
    if (allRes.status !== 200) {
      fail(`pins HTTP ${allRes.status}: ${allRes.raw.slice(0, 250)}`);
    } else {
      const fc = allRes.body?.data;
      if (fc?.type !== 'FeatureCollection') fail(`expected FeatureCollection, got ${fc?.type}`);
      else                                  pass('response is a FeatureCollection');
      const feature = (fc?.features ?? []).find((f) => f.properties?.lead_id === leadId);
      if (!feature) {
        fail(`feature for lead ${leadId} not found in ${fc?.features?.length ?? 0} features`);
      } else {
        const [lon, lat] = feature.geometry.coordinates;
        info(`feature coords = [${lon}, ${lat}]`);
        if (Math.abs(lon - -73.98) < 0.001 && Math.abs(lat - 40.75) < 0.001) {
          pass('feature coordinates match [-73.98, 40.75]');
        } else {
          fail(`coords drifted: [${lon}, ${lat}]`);
        }
        if (feature.properties?.contractStatus === 'sent') {
          pass('feature properties.contractStatus = sent');
        } else {
          fail(`expected contractStatus=sent, got ${feature.properties?.contractStatus}`);
        }
        // PII hygiene: never expose email/phone in pin payload.
        if (feature.properties?.email || feature.properties?.phone) {
          fail('PII leaked: properties contain email/phone');
        } else {
          pass('no PII (email/phone) in pin properties');
        }
      }
    }

    // -- step 5: GET /crm/map/pins?bbox=-180,-90,180,90 --
    out.push(`-- step 5: GET /crm/map/pins?bbox=-180,-90,180,90 --`);
    const worldRes = await authedGet(adminLogin.token, '/crm/map/pins?bbox=-180,-90,180,90');
    if (worldRes.status !== 200) {
      fail(`world-bbox HTTP ${worldRes.status}: ${worldRes.raw.slice(0, 250)}`);
    } else {
      const f = (worldRes.body?.data?.features ?? []).find((x) => x.properties?.lead_id === leadId);
      if (f) pass('world-bbox includes the seeded lead');
      else   fail('world-bbox missed the seeded lead');
    }

    // -- step 6: GET /crm/map/pins?bbox=0,0,1,1 (Atlantic Ocean) --
    out.push(`-- step 6: GET /crm/map/pins?bbox=0,0,1,1 (Atlantic) --`);
    const oceanRes = await authedGet(adminLogin.token, '/crm/map/pins?bbox=0,0,1,1');
    if (oceanRes.status !== 200) {
      fail(`ocean-bbox HTTP ${oceanRes.status}: ${oceanRes.raw.slice(0, 250)}`);
    } else {
      const f = (oceanRes.body?.data?.features ?? []).find((x) => x.properties?.lead_id === leadId);
      if (!f) pass('ocean-bbox excludes the NYC lead (no false intersect)');
      else    fail('ocean-bbox INCORRECTLY included the NYC lead');
    }

    // -- step 7: POST /crm/map/pins/:id/visit --
    out.push(`-- step 7: POST /crm/map/pins/:id/visit --`);
    const visitRes = await authedPost(adminLogin.token, `/crm/map/pins/${leadId}/visit`, {});
    if (visitRes.status !== 200) {
      fail(`visit HTTP ${visitRes.status}: ${visitRes.raw.slice(0, 250)}`);
    } else {
      pass('visit returned 200');
    }
    // Audit is fire-and-forget; give it a moment to flush.
    await delay(250);
    const aud = await pool.query(
      `SELECT id, action, resource, resource_id
         FROM iam.audit_event
        WHERE tenant_id = $1
          AND action    = 'crm.map.lead.visited'
          AND resource_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, leadId],
    );
    if (aud.rows.length === 1) pass('iam.audit_event recorded crm.map.lead.visited');
    else                       fail(`expected 1 audit row, got ${aud.rows.length}`);

    // Confirm the pins.read audit also fired (every GET should emit one).
    const audRead = await pool.query(
      `SELECT id FROM iam.audit_event
        WHERE tenant_id = $1
          AND action    = 'crm.map.pins.read'
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId],
    );
    if (audRead.rows.length === 1) pass('iam.audit_event recorded crm.map.pins.read');
    else                           fail('expected >=1 crm.map.pins.read audit row');
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s5a-pins PASS' : `qa-s5a-pins FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s5a-pins-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
