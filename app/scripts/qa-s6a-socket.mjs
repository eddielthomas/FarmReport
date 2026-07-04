// =============================================================================
// qa-s6a-socket.mjs — Sprint 6A (EPIC-005 P-004 Phase 2) socket.io integration.
// -----------------------------------------------------------------------------
// Spawns the API server (with attached socket.io), dev-logins as admin, creates
// a conversation, opens a socket.io-client connection, joins the room, and
// verifies that a REST POST /messages results in a chat.message.sent envelope
// on the wire within 2s. Also asserts:
//   - missing-token connections are rejected with connect_error
//   - non-member chat:join requests are NACK'd by the server
//
// Port defaults to 5189 (override via QA_PORT). Server is spawned with
// NODE_ENV=development + ALLOW_DEV_LOGIN=1 + JWT_SECRET=test-key.
// =============================================================================

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const PORT = Number(process.env.QA_PORT ?? 5189);
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
    NODE_ENV:        'development',
    ALLOW_DEV_LOGIN: '1',
    JWT_SECRET:      'test-key',
    PORT:            String(PORT),
    PGPORT:          String(cfg.port),
    PGHOST:          cfg.host,
    PGUSER:          cfg.user,
    PGPASSWORD:      cfg.password,
    PGDATABASE:      cfg.database,
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
  return { token: body.data.token, user: body.data.user };
}

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    'x-tenant-id':  TENANT_SLUG,
    'content-type': 'application/json',
  };
}
async function authedPost(token, path, payload) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: 'POST', headers: headers(token), body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
}

async function ensureUser(tenantId, email, displayName, systemRoleKey) {
  await pool.query(
    `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
     VALUES ($1, $2, $3, ARRAY[]::TEXT[], 'active')
     ON CONFLICT (tenant_id, email) DO UPDATE
        SET status = 'active', display_name = EXCLUDED.display_name`,
    [tenantId, email, displayName],
  );
  if (systemRoleKey) {
    await pool.query(`
      INSERT INTO iam.user_role (user_id, role_id)
        SELECT up.id, r.id
          FROM iam.user_profile up, iam.role r
         WHERE up.email = $1 AND up.tenant_id = $2
           AND r.key    = $3 AND r.tenant_id IS NULL
      ON CONFLICT DO NOTHING
    `, [email, tenantId, systemRoleKey]);
  }
}

// Wait for one of the named events on a socket; rejects after `ms` ms.
function waitFor(socket, eventName, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(eventName, onEvt);
      reject(new Error(`timeout waiting for ${eventName} after ${ms}ms`));
    }, ms);
    const onEvt = (data) => {
      clearTimeout(t);
      resolve(data);
    };
    socket.once(eventName, onEvt);
  });
}

(async () => {
  // Lazy-load socket.io-client so the script fails with a clear message when
  // the dep is missing rather than blowing up at import time.
  let ioClient;
  try {
    const mod = await import('socket.io-client');
    ioClient = mod.io ?? mod.default ?? mod;
  } catch (err) {
    out.push(`FATAL: socket.io-client not installed: ${err?.message ?? err}`);
    out.push('Run: npm install --save-dev socket.io-client@4');
    writeFileSync('D:/Projects/RWR/mvp/.qa-s6a-socket-out.txt', out.join('\n'), 'utf8');
    console.log(out.join('\n'));
    process.exit(2);
  }

  await startServer();

  const sockets = [];
  function trackSocket(s) { sockets.push(s); return s; }

  try {
    const t = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
    if (t.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = t.rows[0].id;
    info(`tenant_id = ${tenantId}`);

    // Ensure the admin + chat-agent + outsider users exist.
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );
    await ensureUser(tenantId, 'qa-s6a-outsider@demoville-a.local', 'QA S6A Outsider', 'sales.manager');

    // Resolve or create a lead so we can scope the conversation to it.
    let leadId = null;
    {
      const r = await pool.query(
        `SELECT id FROM sales.lead WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      );
      leadId = r.rows[0]?.id ?? null;
    }

    out.push(`-- step 1: admin dev-login --`);
    const adminLogin = await login('admin@demoville-a.local');
    info(`admin token len = ${adminLogin.token.length}`);

    if (!leadId) {
      const leadRes = await authedPost(adminLogin.token, '/sales/leads', {
        name: 'QA S6A Lead', email: 'qa-s6a-lead@demoville-a.local',
        company: 'QA S6A Co', status: 'Info Request', source: 'Direct',
      });
      if (leadRes.status !== 201) {
        fail(`lead create HTTP ${leadRes.status}: ${leadRes.raw.slice(0, 200)}`);
        throw new Error('cannot resolve lead');
      }
      leadId = leadRes.body.data.id;
    }
    info(`lead_id = ${leadId}`);

    out.push(`-- step 2: POST /chat/conversations --`);
    const convRes = await authedPost(adminLogin.token, '/chat/conversations', {
      scope_kind: 'lead', scope_id: leadId, subject: 'S6A socket test',
    });
    if (convRes.status !== 201) {
      fail(`conversation create HTTP ${convRes.status}: ${convRes.raw.slice(0, 200)}`);
      throw new Error('conversation create failed');
    }
    const convId = convRes.body.data.id;
    info(`conversation_id = ${convId}`);
    pass(`conversation created`);

    // -- step 3: connect socket.io client as admin (member) -----------------
    out.push(`-- step 3: open socket.io connection as admin --`);
    const adminSocket = trackSocket(ioClient(`http://127.0.0.1:${PORT}`, {
      transports: ['websocket'],
      auth: { token: adminLogin.token, tenant_id: TENANT_SLUG },
      reconnection: false,
      timeout: 4000,
    }));
    try {
      await waitFor(adminSocket, 'connect', 5000);
      pass(`admin socket connected (id=${adminSocket.id})`);
    } catch (err) {
      fail(`admin socket connect failed: ${err?.message ?? err}`);
      throw err;
    }

    // -- step 4: chat:join --------------------------------------------------
    out.push(`-- step 4: chat:join { conversation_id } --`);
    const joinAck = await new Promise((resolve) => {
      adminSocket.emit('chat:join', { conversation_id: convId }, resolve);
    });
    if (joinAck?.ok) pass(`chat:join acked ok`);
    else             fail(`chat:join ack = ${JSON.stringify(joinAck)}`);

    // -- step 5: REST POST message → expect chat.message.sent envelope on WS
    out.push(`-- step 5: POST /messages → wait for chat.message.sent --`);
    const evtPromise = waitFor(adminSocket, 'chat.message.sent', 4000);
    const postRes = await authedPost(adminLogin.token,
      `/chat/conversations/${convId}/messages`, { body: 'hello realtime' });
    if (postRes.status !== 201) {
      fail(`message POST HTTP ${postRes.status}: ${postRes.raw.slice(0, 200)}`);
      throw new Error('message post failed');
    }
    info(`message_id = ${postRes.body.data.id}`);
    try {
      const env = await evtPromise;
      info(`received envelope type=${env?.type} schema_version=${env?.schema_version}`);
      const body = env?.payload?.message?.body;
      if (env?.type === 'chat.message.sent' && env?.schema_version === 1
          && env?.payload?.conversation_id === convId
          && body === 'hello realtime') {
        pass(`chat.message.sent envelope received on conversation room`);
      } else {
        fail(`envelope mismatch: ${JSON.stringify(env).slice(0, 300)}`);
      }
    } catch (err) {
      fail(`did not receive chat.message.sent: ${err?.message ?? err}`);
    }

    // -- step 6: negative — connect with no token --------------------------
    out.push(`-- step 6: open socket with NO auth (expect connect_error) --`);
    const anonSocket = trackSocket(ioClient(`http://127.0.0.1:${PORT}`, {
      transports: ['websocket'],
      auth: {},
      reconnection: false,
      timeout: 4000,
    }));
    let anonRejected = false;
    try {
      const errEvt = waitFor(anonSocket, 'connect_error', 4000);
      const okEvt  = waitFor(anonSocket, 'connect',       4000)
        .then(() => 'connected', () => null);
      const winner = await Promise.race([errEvt, okEvt]);
      if (winner && winner !== 'connected') {
        anonRejected = true;
        info(`anon connect_error: ${winner?.message ?? winner}`);
      }
    } catch (_e) { /* timeout race */ }
    if (anonRejected) pass(`anonymous socket rejected with connect_error`);
    else              fail(`anonymous socket was not rejected`);

    // -- step 7: negative — outsider join attempt on convId -----------------
    out.push(`-- step 7: outsider chat:join (expect NACK) --`);
    const outsiderLogin = await login('qa-s6a-outsider@demoville-a.local');
    const outsiderSocket = trackSocket(ioClient(`http://127.0.0.1:${PORT}`, {
      transports: ['websocket'],
      auth: { token: outsiderLogin.token, tenant_id: TENANT_SLUG },
      reconnection: false,
      timeout: 4000,
    }));
    try {
      await waitFor(outsiderSocket, 'connect', 5000);
      info(`outsider socket connected (id=${outsiderSocket.id})`);
      const ack = await new Promise((resolve) => {
        outsiderSocket.emit('chat:join', { conversation_id: convId }, resolve);
      });
      if (ack && ack.ok === false) pass(`outsider chat:join rejected (${ack.error})`);
      else                          fail(`outsider chat:join unexpectedly accepted: ${JSON.stringify(ack)}`);
    } catch (err) {
      fail(`outsider socket flow failed: ${err?.message ?? err}`);
    }
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    for (const s of sockets) {
      try { s.disconnect(); } catch (_e) { /* ignore */ }
    }
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s6a-socket PASS' : `qa-s6a-socket FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s6a-socket-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
