// =============================================================================
// qa-s9a-flow.mjs — Sprint 9A end-to-end flow.
// -----------------------------------------------------------------------------
// 1) Dev-login admin@demoville-a.local
// 2) Create field.job at (40.7128, -74.0060) radius=100m
// 3) Provision a tech user with role field.technician + assign the job
// 4) Tech: POST /field/location at (40.0, -74.0)  → far from job
// 5) Tech: POST /field/jobs/:id/check-in same far coords → 422 gps_out_of_geofence
// 6) Tech: POST /field/location at exact job coords
// 7) Tech: POST /field/jobs/:id/check-in same exact coords → 200 + time_entry opened
// 8) Tech: POST /field/jobs/:id/uploads multipart PNG + lat/lon exact → 200, gps_verified=true
// 9) Tech: POST /field/jobs/:id/uploads multipart PNG + far coords → 200, gps_verified=false  (lenient)
// 10) Admin: PUT /iam/tenants/:id/flags  set field.geofence_strict_upload=true
// 11) Tech: POST /field/jobs/:id/uploads far coords again → 422 (strict mode)
// 12) Tech: POST /field/jobs/:id/check-out  → 200 + duration_seconds populated
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Use a unique port range so we never collide with a stale long-running
// dev server on 5180. The QA flow tears down its child cleanly on exit.
const PRIMARY_PORT  = Number(process.env.QA_PORT ?? 5189);
const FALLBACK_PORT = 5190;
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

// Build a minimal multipart body containing a tiny PNG + the file field.
function buildMultipart(filename, buf, mimeType) {
  const boundary = '----qa-s9a-' + randomUUID();
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buf, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function authedUpload(token, path, filename, fileBuf, mimeType) {
  const m = buildMultipart(filename, fileBuf, mimeType);
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST',
    headers: authHeaders(token, { 'content-type': m.contentType }),
    body: m.body,
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: parsed, raw: text };
}

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C63000100000005000119DEC6E60000000049454E44AE426082',
  'hex',
);

async function run() {
  await startServer();

  // -- Step 1: admin login + tenant lookup
  out.push('-- admin login --');
  const admin = await login('admin@demoville-a.local');
  pass(`admin token len=${admin.token.length}`);
  const tres = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
  if (!tres.rows.length) { fail('tenant slug missing'); return; }
  const tenantId = tres.rows[0].id;
  info(`tenant=${tenantId}`);

  // Reset upload-strict flag to false (test 9 expects lenient behaviour).
  await fetch(`${BASE}/api/v1/iam/tenants/${tenantId}/flags`, {
    method: 'PUT',
    headers: authHeaders(admin.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ set: { 'field.geofence_strict_upload': false } }),
  });

  // -- Step 2: create a job at NYC City Hall coords --
  out.push('-- create job --');
  const jobRes = await authedJson(admin.token, '/field/jobs', 'POST', {
    title: 'QA S9A job', description: 'Geofence-gated check-in test',
    lat: 40.7128, lon: -74.0060, geofence_radius_m: 100,
    priority: 'high',
  });
  if (jobRes.status !== 201) {
    fail(`create job failed: ${jobRes.status} ${jobRes.raw.slice(0, 300)}`);
    return;
  }
  const job = jobRes.body?.data ?? jobRes.body;
  pass(`job id=${job.id}`);
  info(`job status=${job.status} radius=${job.geofence_radius_m}`);

  // -- Step 3: provision a tech user + assign the job --
  out.push('-- provision tech --');
  const techEmail = 'qa-s9a-tech@demoville-a.local';
  // dev-login to upsert the user_profile, then attach the field.technician role.
  const tech1 = await login(techEmail);
  const techId = tech1.user?.id ?? (await pool.query(
    `SELECT id FROM iam.user_profile WHERE tenant_id = $1 AND email = $2`,
    [tenantId, techEmail])).rows[0]?.id;
  if (!techId) { fail('cannot resolve tech id'); return; }
  // Force-grant field.technician role via SQL.
  await pool.query(
    `INSERT INTO iam.user_role (user_id, role_id)
       SELECT $1, r.id FROM iam.role r WHERE r.key = 'field.technician' AND r.tenant_id IS NULL
     ON CONFLICT DO NOTHING`,
    [techId]);
  // Also seed legacy roles so policy.mjs gates don't lock the tech out.
  await pool.query(
    `UPDATE iam.user_profile SET roles = ARRAY['dashboard:view'] WHERE id = $1`, [techId]);
  // Assign the job to this tech via admin PUT.
  const asgRes = await authedJson(admin.token, `/field/jobs/${job.id}`, 'PUT', {
    assigned_to: techId,
  });
  if (asgRes.status !== 200) {
    fail(`assign failed: ${asgRes.status} ${asgRes.raw.slice(0, 300)}`);
    return;
  }
  pass(`assigned job to tech ${techId}`);

  // Re-login as tech so JWT picks up roles via cache invalidation.
  const tech = await login(techEmail);
  pass(`tech token len=${tech.token.length}`);

  // -- Step 4: post FAR position (40.0, -74.0)
  out.push('-- step 4: tech posts far position --');
  const farPos = await authedJson(tech.token, '/field/location', 'POST', {
    lat: 40.0, lon: -74.0, accuracy_m: 8,
  });
  if (farPos.status === 201) pass(`far position accepted (status 201)`);
  else fail(`far position post: ${farPos.status} ${farPos.raw.slice(0, 200)}`);

  // -- Step 5: check-in far coords -> 422
  out.push('-- step 5: check-in far -> 422 expected --');
  const ciFar = await authedJson(tech.token, `/field/jobs/${job.id}/check-in`, 'POST', {
    lat: 40.0, lon: -74.0, accuracy_m: 8,
  });
  if (ciFar.status === 422 && /gps_out_of_geofence/i.test(JSON.stringify(ciFar.body))) {
    pass(`check-in far rejected with gps_out_of_geofence (distance_m=${ciFar.body?.detail?.distance_m})`);
  } else {
    fail(`check-in far expected 422 gps_out_of_geofence; got ${ciFar.status} ${ciFar.raw.slice(0, 200)}`);
  }

  // -- Step 6: post exact position
  out.push('-- step 6: tech posts exact-at-job position --');
  const exactPos = await authedJson(tech.token, '/field/location', 'POST', {
    lat: 40.7128, lon: -74.0060, accuracy_m: 4,
  });
  if (exactPos.status === 201) pass(`exact position accepted`);
  else fail(`exact position post: ${exactPos.status} ${exactPos.raw.slice(0, 200)}`);

  // -- Step 7: check-in exact coords -> 200 + time_entry opened, geofence entered
  out.push('-- step 7: check-in at job --');
  const ciOk = await authedJson(tech.token, `/field/jobs/${job.id}/check-in`, 'POST', {
    lat: 40.7128, lon: -74.0060, accuracy_m: 4,
  });
  if (ciOk.status !== 200) {
    fail(`check-in expected 200; got ${ciOk.status} ${ciOk.raw.slice(0, 300)}`);
  } else {
    pass(`check-in OK time_entry_id=${ciOk.body?.data?.time_entry_id}`);
  }
  // Inspect DB for time_entry + geofence_event
  const teRow = await pool.query(
    `SELECT id, ended_at FROM field.time_entry WHERE job_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
    [job.id, techId]);
  if (teRow.rows[0] && teRow.rows[0].ended_at == null) pass('open time_entry row exists');
  else fail(`time_entry not in expected open state: ${JSON.stringify(teRow.rows[0])}`);
  const evRow = await pool.query(
    `SELECT event_kind FROM field.geofence_event WHERE job_id = $1 AND user_id = $2 ORDER BY posted_at DESC LIMIT 5`,
    [job.id, techId]);
  if (evRow.rows.some((r) => r.event_kind === 'checkin' || r.event_kind === 'entered'))
    pass(`geofence_event has checkin/entered (${evRow.rows.map((r) => r.event_kind).join(',')})`);
  else
    fail(`geofence_event missing checkin/entered: ${JSON.stringify(evRow.rows)}`);

  // -- Step 8: upload at exact coords -> gps_verified true
  out.push('-- step 8: upload at job coords (lenient) --');
  const up1 = await authedUpload(
    tech.token,
    `/field/jobs/${job.id}/uploads?lat=40.7128&lon=-74.0060&accuracy_m=4`,
    'inside.png', TINY_PNG, 'image/png',
  );
  if (up1.status !== 201) {
    fail(`upload exact expected 201; got ${up1.status} ${up1.raw.slice(0, 300)}`);
  } else {
    const u = up1.body?.data ?? up1.body;
    if (u.gps_verified === true) pass(`upload at exact coords gps_verified=true mode=${u.gps_verification_mode}`);
    else                          fail(`upload at exact coords expected gps_verified=true; got ${JSON.stringify(u)}`);
  }

  // -- Step 9: upload far coords lenient -> gps_verified false but allowed
  out.push('-- step 9: upload far coords lenient --');
  const up2 = await authedUpload(
    tech.token,
    `/field/jobs/${job.id}/uploads?lat=40.0&lon=-74.0`,
    'far.png', TINY_PNG, 'image/png',
  );
  if (up2.status !== 201) {
    fail(`upload far lenient expected 201; got ${up2.status} ${up2.raw.slice(0, 300)}`);
  } else {
    const u = up2.body?.data ?? up2.body;
    if (u.gps_verified === false) pass(`upload far lenient gps_verified=false (distance ~${u.gps_distance_from_job_m?.toFixed?.(0)}m)`);
    else                           fail(`upload far lenient expected gps_verified=false; got ${JSON.stringify(u)}`);
  }

  // -- Step 10: switch flag to strict_upload=true
  out.push('-- step 10: switch tenant flag to strict_upload=true --');
  const flagRes = await fetch(`${BASE}/api/v1/iam/tenants/${tenantId}/flags`, {
    method: 'PUT',
    headers: authHeaders(admin.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ set: { 'field.geofence_strict_upload': true } }),
  });
  if (flagRes.ok) pass('flag toggled to strict_upload=true');
  else fail(`flag toggle failed: ${flagRes.status}`);
  // Flag cache TTL is 60s — to flip the in-process cache instantly we force a
  // restart of the server. Simpler: hit a route that re-reads via the cache
  // bust. The tenant-flag endpoint invalidates via invalidateFlags; check it.

  // Give the flag cache a moment to settle (invalidateFlags is sync but
  // hydrateFlags runs on the next request).
  await delay(200);

  // -- Step 11: upload far coords strict -> 422
  out.push('-- step 11: upload far coords strict -> 422 expected --');
  const up3 = await authedUpload(
    tech.token,
    `/field/jobs/${job.id}/uploads?lat=40.0&lon=-74.0`,
    'far2.png', TINY_PNG, 'image/png',
  );
  if (up3.status === 422 && /gps_out_of_geofence/i.test(JSON.stringify(up3.body))) {
    pass(`upload far strict rejected with gps_out_of_geofence`);
  } else {
    fail(`upload far strict expected 422; got ${up3.status} ${up3.raw.slice(0, 300)}`);
  }
  // Restore the flag for downstream re-runs.
  await fetch(`${BASE}/api/v1/iam/tenants/${tenantId}/flags`, {
    method: 'PUT',
    headers: authHeaders(admin.token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ set: { 'field.geofence_strict_upload': false } }),
  });

  // -- Step 12: check-out
  out.push('-- step 12: check-out --');
  const coRes = await authedJson(tech.token, `/field/jobs/${job.id}/check-out`, 'POST', {
    lat: 40.7128, lon: -74.0060,
  });
  if (coRes.status !== 200) {
    fail(`check-out expected 200; got ${coRes.status} ${coRes.raw.slice(0, 300)}`);
  } else {
    const d = coRes.body?.data ?? coRes.body;
    if (d.ended_at && Number.isFinite(d.duration_seconds))
      pass(`check-out OK ended_at=${d.ended_at} duration_seconds=${d.duration_seconds}`);
    else
      fail(`check-out missing ended_at or duration_seconds: ${JSON.stringify(d)}`);
  }
  // Verify time_entry row is closed in DB
  const teClosed = await pool.query(
    `SELECT ended_at, duration_seconds FROM field.time_entry
      WHERE job_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1`,
    [job.id, techId]);
  if (teClosed.rows[0]?.ended_at != null && teClosed.rows[0]?.duration_seconds != null)
    pass(`time_entry closed in DB (duration_seconds=${teClosed.rows[0].duration_seconds})`);
  else
    fail(`time_entry not closed: ${JSON.stringify(teClosed.rows[0])}`);
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
out.push(failures === 0 ? 'qa-s9a-flow PASS' : `qa-s9a-flow FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync('D:/Projects/RWR/mvp/.qa-s9a-flow-out.txt', txt, 'utf8');
console.log(txt);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
