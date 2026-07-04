// =============================================================================
// qa-s3a-rbac.mjs — Sprint 3A (EPIC-005 P-004 Phase 1) HTTP integration test.
// -----------------------------------------------------------------------------
// Steps:
//   1) dev-login admin@demoville-a.local (platform:admin via dev seed shim).
//   2) Resolve an existing demoville-a lead id (any tenant lead works).
//   3) POST /chat/conversations { scope_kind:'lead', scope_id, subject }.
//   4) POST /chat/conversations/:id/members add the agent user as participant.
//   5) dev-login as the agent; GET /chat/conversations/:id/messages → expect 200
//      with an empty array.
//   6) POST /chat/conversations/:id/messages as admin → expect 201.
//   7) GET as agent → expect 1 message.
//   8) POST /chat/conversations/:id/messages/:mid/read as agent → expect 204;
//      second GET shows the message has the agent in read_by.
//   9) Membership negative: dev-login as a fresh THIRD user (no membership);
//      GET /chat/conversations/:id → expect 403.
//
// Port defaults to 5180 (override via QA_PORT). Server is spawned with
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
async function authedGet(token, path) {
  const r = await fetch(`${BASE}/api/v1${path}`, { headers: headers(token) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json, raw: text };
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

(async () => {
  await startServer();
  try {
    const t = await pool.query(`SELECT id FROM iam.tenant WHERE slug = $1`, [TENANT_SLUG]);
    if (t.rows.length === 0) throw new Error(`tenant ${TENANT_SLUG} missing`);
    const tenantId = t.rows[0].id;
    info(`tenant_id = ${tenantId}`);

    // Make sure admin has the full admin role bundle (qa-s2a does this too).
    await pool.query(
      `INSERT INTO iam.user_profile (tenant_id, email, display_name, roles, status)
       VALUES ($1, 'admin@demoville-a.local', 'QA Admin',
               ARRAY['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
               'active')
       ON CONFLICT (tenant_id, email) DO UPDATE
          SET roles = EXCLUDED.roles, status = 'active'`,
      [tenantId],
    );
    // Seed a chat agent + outsider.
    await ensureUser(tenantId, 'qa-chat-agent@demoville-a.local',    'QA Chat Agent',    'sales.manager');
    await ensureUser(tenantId, 'qa-chat-outsider@demoville-a.local', 'QA Chat Outsider', 'sales.manager');

    // Resolve a lead id in the tenant. Create one if none exists.
    let leadId = null;
    {
      const r = await pool.query(
        `SELECT id FROM sales.lead WHERE tenant_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [tenantId],
      );
      leadId = r.rows[0]?.id ?? null;
    }

    // -- 1) admin dev-login --
    out.push(`-- step 1: dev-login admin@demoville-a.local --`);
    const adminLogin = await login('admin@demoville-a.local');
    info(`admin token len = ${adminLogin.token.length}`);

    if (!leadId) {
      // Create a lead via REST so we always have one to thread chat against.
      const leadRes = await authedPost(adminLogin.token, '/sales/leads', {
        name: 'QA Chat Lead', email: 'qa-chat-lead@demoville-a.local',
        company: 'QA Chat Co', status: 'Info Request', source: 'Direct',
      });
      if (leadRes.status !== 201) {
        fail(`lead create HTTP ${leadRes.status}: ${leadRes.raw.slice(0, 200)}`);
        throw new Error('cannot resolve lead');
      }
      leadId = leadRes.body.data.id;
    }
    info(`lead_id = ${leadId}`);

    // -- 2) Create conversation --
    out.push(`-- step 2: POST /chat/conversations --`);
    const convRes = await authedPost(adminLogin.token, '/chat/conversations', {
      scope_kind: 'lead', scope_id: leadId, subject: 'QA test',
    });
    if (convRes.status !== 201) {
      fail(`conversation create HTTP ${convRes.status}: ${convRes.raw.slice(0, 200)}`);
      throw new Error('conversation create failed');
    }
    const convId = convRes.body.data.id;
    info(`conversation_id = ${convId}`);
    pass(`conversation created`);

    // -- 3) Add second user as participant --
    out.push(`-- step 3: POST /chat/conversations/:id/members --`);
    const agentRow = await pool.query(
      `SELECT id FROM iam.user_profile
        WHERE tenant_id = $1 AND email = 'qa-chat-agent@demoville-a.local'`,
      [tenantId],
    );
    const agentId = agentRow.rows[0].id;
    info(`agent_user_id = ${agentId}`);
    const addRes = await authedPost(adminLogin.token, `/chat/conversations/${convId}/members`, {
      user_id: agentId, role_in_convo: 'participant',
    });
    if (addRes.status !== 201) {
      fail(`add member HTTP ${addRes.status}: ${addRes.raw.slice(0, 200)}`);
      throw new Error('add member failed');
    }
    pass(`member added`);

    // -- 4) Agent dev-login + GET messages (empty array) --
    out.push(`-- step 4: agent GET /chat/conversations/:id/messages (empty) --`);
    const agentLogin = await login('qa-chat-agent@demoville-a.local');
    const agentMsgsEmpty = await authedGet(agentLogin.token, `/chat/conversations/${convId}/messages`);
    if (agentMsgsEmpty.status !== 200) {
      fail(`agent messages GET HTTP ${agentMsgsEmpty.status}: ${agentMsgsEmpty.raw.slice(0, 200)}`);
    } else {
      const arr = agentMsgsEmpty.body?.data ?? [];
      info(`initial messages count = ${arr.length}`);
      if (arr.length === 0) pass(`agent sees empty message list`);
      else                  info(`(non-empty initial messages — backfill OK)`);
    }

    // -- 5) Admin posts a message --
    out.push(`-- step 5: admin POST /chat/conversations/:id/messages --`);
    const postRes = await authedPost(adminLogin.token, `/chat/conversations/${convId}/messages`, {
      body: 'hello qa',
    });
    if (postRes.status !== 201) {
      fail(`message create HTTP ${postRes.status}: ${postRes.raw.slice(0, 200)}`);
      throw new Error('message create failed');
    }
    const msgId = postRes.body.data.id;
    info(`message_id = ${msgId}`);
    pass(`message posted by admin`);

    // -- 6) Agent GETs and sees 1 message --
    out.push(`-- step 6: agent GET /chat/conversations/:id/messages (after post) --`);
    const agentMsgs = await authedGet(agentLogin.token, `/chat/conversations/${convId}/messages`);
    if (agentMsgs.status !== 200) {
      fail(`agent messages GET HTTP ${agentMsgs.status}: ${agentMsgs.raw.slice(0, 200)}`);
    } else {
      const arr = agentMsgs.body?.data ?? [];
      info(`messages count after post = ${arr.length}`);
      const found = arr.find((m) => m.id === msgId);
      if (found) pass(`agent sees posted message`);
      else       fail(`agent did NOT see posted message id=${msgId}`);
    }

    // -- 7) Agent marks message read; GET again confirms read_by --
    out.push(`-- step 7: agent POST /chat/conversations/:id/messages/:mid/read --`);
    const readRes = await authedPost(agentLogin.token,
      `/chat/conversations/${convId}/messages/${msgId}/read`, {});
    if (readRes.status !== 204) {
      fail(`mark-read HTTP ${readRes.status}: ${readRes.raw.slice(0, 200)}`);
    } else {
      pass(`mark-read returned 204`);
    }
    const agentMsgsAfterRead = await authedGet(agentLogin.token, `/chat/conversations/${convId}/messages`);
    if (agentMsgsAfterRead.status !== 200) {
      fail(`messages re-GET HTTP ${agentMsgsAfterRead.status}`);
    } else {
      const m = (agentMsgsAfterRead.body?.data ?? []).find((x) => x.id === msgId);
      const readers = (m?.read_by ?? []).map(String);
      if (readers.includes(agentId)) pass(`read_by contains agent user`);
      else                            fail(`read_by missing agent user (got: ${readers.join(',')})`);
    }

    // -- 8) Outsider (third user, no membership) -> 403 on GET conversation --
    out.push(`-- step 8: outsider GET /chat/conversations/:id (expect 403) --`);
    const outsiderLogin = await login('qa-chat-outsider@demoville-a.local');
    const outsiderGet = await authedGet(outsiderLogin.token, `/chat/conversations/${convId}`);
    info(`outsider GET status = ${outsiderGet.status}`);
    if (outsiderGet.status === 403) pass(`outsider receives 403 on non-member conversation`);
    else                            fail(`expected 403, got ${outsiderGet.status}: ${outsiderGet.raw.slice(0, 200)}`);
  } catch (e) {
    out.push(`FATAL: ${e?.stack ?? e?.message ?? e}`);
    failures++;
  } finally {
    stopServer();
    await pool.end();
  }

  out.push('');
  out.push(failures === 0 ? 'qa-s3a-rbac PASS' : `qa-s3a-rbac FAIL (${failures} failures)`);
  const txt = out.join('\n');
  writeFileSync('D:/Projects/RWR/mvp/.qa-s3a-rbac-out.txt', txt, 'utf8');
  console.log(txt);
  process.exit(failures === 0 ? 0 : 1);
})();
