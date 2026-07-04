// =============================================================================
// smoke-rbac-matrix.mjs — role × resource × method coverage matrix.
// -----------------------------------------------------------------------------
// Phase 1 of Play A — fast, deterministic, API-level RBAC coverage. Logs in as
// every demo role across every seeded tenant and exercises a declarative
// matrix of (method, path, role) tuples, asserting expected allow/deny.
//
// Run:
//   node mvp/scripts/smoke-rbac-matrix.mjs
//   API=http://localhost:5180/api/v1 node mvp/scripts/smoke-rbac-matrix.mjs
//
// Style mirrors smoke-staff-prod.mjs / smoke-register-prod.mjs:
//   - plain Node fetch, no deps
//   - ✓/✗ line output, grouped by role then resource
//   - exit 0 only on all-green
// =============================================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const API     = process.env.API   ?? 'https://alphageo.eddiethomas.space/api/v1';
const TENANTS = ['demoville-a', 'acme-water'];

// Demo accounts. NOTE: no seeded account for roles `dashboard:view` or
// `vendor:view` — TODO to seed them once admin@…demo provisions them.
const ROLES = [
  { key: 'admin',    email: (s) => `admin@${s}.demo`,    expectedRole: 'platform:admin' },
  { key: 'ops',      email: (s) => `ops@${s}.demo`,      expectedRole: 'ops:manage'     },
  { key: 'sales',    email: (s) => `sales@${s}.demo`,    expectedRole: 'sales:manage'   },
  { key: 'analyst',  email: (s) => `analyst@${s}.demo`,  expectedRole: 'analytics:view' },
  { key: 'customer', email: (s) => `customer@${s}.demo`, expectedRole: 'customer:view'  },
];

// -----------------------------------------------------------------------------
// MATRIX — single source of truth for (role × method × path) expectations.
// -----------------------------------------------------------------------------
// Each row:
//   resource    : grouping label for output
//   method      : HTTP verb
//   path        : template; `{leadId}`, `{caseId}`, `{teamId}`, `{userId}`,
//                 `{tenantId}` substituted from runtime fixtures
//   body        : optional request body (or factory `(ctx) => {...}`)
//   exp[role]   : { expectedStatuses:[…], mode:'allow'|'deny' }
//   captureAs   : optional fixture key to stash response.body.data.id for
//                 dependent rows / cleanup
//   needsFixture: optional list of fixture keys required (skip if missing)
//
// Customers (customer:view) get a read-only carve-out for /sales/leads,
// /sales/leads/:id/{messages,files} and /sales/meetings (see api/v1/index.mjs).
// -----------------------------------------------------------------------------

const ALLOW = (...s) => ({ expectedStatuses: s, mode: 'allow' });
const DENY  = (...s) => ({ expectedStatuses: s.length ? s : [403], mode: 'deny' });

const MATRIX = [
  // ---- iam/users (admin-only end-to-end) ---------------------------------
  // /iam/users is the full directory and is now gated to platform:admin.
  // Other tenant roles use the narrow /tenants/me/users carve-out instead.
  { resource: 'iam/users', method: 'GET', path: '/iam/users', exp: {
      admin: ALLOW(200), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'iam/users', method: 'POST', path: '/iam/users',
    body: (ctx) => ({ email: `rbac-${ctx.stamp}-${ctx.tenantSlug}@test.local`, display_name: 'RBAC Smoke', roles: ['dashboard:view'] }),
    captureAs: 'createdUserId',
    exp: {
      admin: ALLOW(201), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'iam/users', method: 'PUT', path: '/iam/users/{createdUserId}',
    body: { roles: ['dashboard:view'] }, needsFixture: ['createdUserId'],
    exp: {
      admin: ALLOW(200), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'iam/users', method: 'DELETE', path: '/iam/users/{createdUserId}',
    needsFixture: ['createdUserId'], cleanup: true,
    exp: {
      admin: ALLOW(200, 204), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},

  // ---- iam/teams ----------------------------------------------------------
  // /iam/teams list is gated to platform:admin OR ops:manage. Sales / analyst
  // / customer have no need for the org-wide team roster.
  { resource: 'iam/teams', method: 'GET', path: '/iam/teams', exp: {
      admin: ALLOW(200), ops: ALLOW(200), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'iam/teams', method: 'POST', path: '/iam/teams',
    body: (ctx) => ({ name: `RBAC Team ${ctx.stamp}`, description: 'rbac smoke' }),
    captureAs: 'createdTeamId',
    exp: {
      admin: ALLOW(201), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'iam/teams', method: 'POST', path: '/iam/teams/{createdTeamId}/members',
    body: (ctx) => ({ user_id: ctx.fixtures.adminUserId, role: 'member' }),
    needsFixture: ['createdTeamId', 'adminUserId'],
    exp: {
      admin: ALLOW(201), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  // Single-team roster — narrower than the global list and intentionally
  // ungated so any authenticated tenant member can see their own team.
  // Non-admin roles may see 404 if admin has already cleaned up the fixture.
  { resource: 'iam/teams', method: 'GET', path: '/iam/teams/{createdTeamId}/members',
    needsFixture: ['createdTeamId'],
    exp: {
      admin: ALLOW(200), ops: ALLOW(200, 404), sales: ALLOW(200, 404), analyst: ALLOW(200, 404), customer: ALLOW(200, 404),
  }},
  { resource: 'iam/teams', method: 'DELETE', path: '/iam/teams/{createdTeamId}',
    needsFixture: ['createdTeamId'], cleanup: true,
    exp: {
      admin: ALLOW(200, 204), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},

  // ---- sales/leads --------------------------------------------------------
  { resource: 'sales/leads', method: 'GET', path: '/sales/leads', exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: ALLOW(200),
  }},
  { resource: 'sales/leads', method: 'POST', path: '/sales/leads',
    body: (ctx) => ({ name: `RBAC Lead ${ctx.stamp}`, status: 'Info Request' }),
    captureAs: 'createdLeadId',
    exp: {
      admin: ALLOW(201), ops: DENY(), sales: ALLOW(201), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'sales/leads', method: 'GET', path: '/sales/leads/{createdLeadId}',
    needsFixture: ['createdLeadId'],
    exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: ALLOW(200, 404),
  }},
  { resource: 'sales/leads', method: 'PUT', path: '/sales/leads/{createdLeadId}',
    body: { interest: 'rbac' }, needsFixture: ['createdLeadId'],
    exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: DENY(),
  }},
  // customers may GET messages/files on any lead they can address
  { resource: 'sales/leads', method: 'GET', path: '/sales/leads/{createdLeadId}/messages',
    needsFixture: ['createdLeadId'],
    exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: ALLOW(200, 404),
  }},
  { resource: 'sales/leads', method: 'POST', path: '/sales/leads/{createdLeadId}/messages',
    body: { body: 'rbac smoke message' }, needsFixture: ['createdLeadId'],
    exp: {
      admin: ALLOW(200, 201), ops: DENY(), sales: ALLOW(200, 201), analyst: DENY(), customer: ALLOW(200, 201, 404),
  }},
  { resource: 'sales/leads', method: 'GET', path: '/sales/leads/{createdLeadId}/files',
    needsFixture: ['createdLeadId'],
    exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: ALLOW(200, 404),
  }},
  { resource: 'sales/leads', method: 'DELETE', path: '/sales/leads/{createdLeadId}',
    needsFixture: ['createdLeadId'], cleanup: true,
    exp: {
      admin: ALLOW(200, 204), ops: DENY(), sales: ALLOW(200, 204), analyst: DENY(), customer: DENY(),
  }},

  // ---- sales/meetings (customer:view allowed to GET) ---------------------
  { resource: 'sales/meetings', method: 'GET', path: '/sales/meetings', exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: ALLOW(200),
  }},

  // ---- sales/opportunities -----------------------------------------------
  { resource: 'sales/opps', method: 'GET', path: '/sales/opportunities', exp: {
      admin: ALLOW(200), ops: DENY(), sales: ALLOW(200), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'sales/opps', method: 'POST', path: '/sales/opportunities',
    body: (ctx) => ({ name: `RBAC Opp ${ctx.stamp}`, amount: 1000 }),
    captureAs: 'createdOppId',
    exp: {
      admin: ALLOW(200, 201, 400), ops: DENY(), sales: ALLOW(200, 201, 400), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'sales/opps', method: 'PUT', path: '/sales/opportunities/{createdOppId}',
    body: { name: 'RBAC Opp updated' }, needsFixture: ['createdOppId'],
    exp: {
      admin: ALLOW(200, 400, 404), ops: DENY(), sales: ALLOW(200, 400, 404), analyst: DENY(), customer: DENY(),
  }},

  // ---- ops/cases ---------------------------------------------------------
  { resource: 'ops/cases', method: 'GET', path: '/ops/cases', exp: {
      admin: ALLOW(200), ops: ALLOW(200), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'POST', path: '/ops/cases',
    body: (ctx) => ({ title: `RBAC Case ${ctx.stamp}`, priority: 'low' }),
    captureAs: 'createdCaseId',
    exp: {
      admin: ALLOW(201), ops: ALLOW(201), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'GET', path: '/ops/cases/{createdCaseId}',
    needsFixture: ['createdCaseId'],
    exp: {
      admin: ALLOW(200), ops: ALLOW(200), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'PUT', path: '/ops/cases/{createdCaseId}',
    body: { priority: 'medium' }, needsFixture: ['createdCaseId'],
    exp: {
      admin: ALLOW(200), ops: ALLOW(200), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'POST', path: '/ops/cases/{createdCaseId}/assign',
    body: (ctx) => ({ assignee_id: ctx.fixtures.adminUserId }), needsFixture: ['createdCaseId', 'adminUserId'],
    exp: {
      admin: ALLOW(200, 201, 400), ops: ALLOW(200, 201, 400), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'POST', path: '/ops/cases/{createdCaseId}/activity',
    body: { kind: 'comment', body: 'rbac smoke' }, needsFixture: ['createdCaseId'],
    exp: {
      admin: ALLOW(200, 201), ops: ALLOW(200, 201), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
  { resource: 'ops/cases', method: 'POST', path: '/ops/cases/{createdCaseId}/attachments',
    body: { file_name: 'rbac.txt', file_size: 4, storage_path: 'rbac/rbac.txt' }, needsFixture: ['createdCaseId'],
    exp: {
      admin: ALLOW(200, 201, 400), ops: ALLOW(200, 201, 400), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},

  // ---- analytics ---------------------------------------------------------
  { resource: 'analytics', method: 'GET', path: '/analytics/dashboard/metrics', exp: {
      admin: ALLOW(200), ops: DENY(), sales: DENY(), analyst: ALLOW(200), customer: DENY(),
  }},
  { resource: 'analytics', method: 'GET', path: '/analytics/income/month', exp: {
      admin: ALLOW(200), ops: DENY(), sales: DENY(), analyst: ALLOW(200), customer: DENY(),
  }},

  // ---- tenants (platform:admin only) ------------------------------------
  { resource: 'tenants', method: 'GET', path: '/tenants', exp: {
      admin: ALLOW(200), ops: DENY(), sales: DENY(), analyst: DENY(), customer: DENY(),
  }},
];

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------
async function login(email, slug) {
  const r = await fetch(API + '/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: slug, email }),
  });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(`login failed (${slug}/${email}): ${r.status} ${JSON.stringify(j)}`);
  return { token: j.data.token, user: j.data.user };
}

async function call(method, path, token, tenantId, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token,
      'X-Tenant-Id':   tenantId,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* 204 / empty */ }
  return { status: r.status, body: j };
}

function fillTemplate(tpl, fixtures) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => fixtures[k] ?? `{${k}}`);
}

function resolveBody(row, ctx) {
  if (row.body === undefined) return undefined;
  return typeof row.body === 'function' ? row.body(ctx) : row.body;
}

// -----------------------------------------------------------------------------
// Per-tenant runner
// -----------------------------------------------------------------------------
async function runForTenant(tenantSlug, results) {
  console.log('\n========================================================');
  console.log(`TENANT  ${tenantSlug}`);
  console.log('========================================================');

  // Log in everyone in this tenant first; capture tenantId + adminUserId.
  const sessions = {};
  for (const r of ROLES) {
    try {
      const s = await login(r.email(tenantSlug), tenantSlug);
      sessions[r.key] = s;
    } catch (err) {
      console.log(`  ✗ login ${r.key}@${tenantSlug}: ${err.message}`);
      results.push({ tenant: tenantSlug, role: r.key, resource: 'login', method: '-', path: '-',
                     status: 0, expected: 200, pass: false, note: err.message });
    }
  }
  const adminSession = sessions.admin;
  if (!adminSession) {
    console.log(`  -- no admin session for ${tenantSlug}; skipping tenant matrix --`);
    return null;
  }
  const tenantId = adminSession.user.tenant_id;
  const adminUserId = adminSession.user.sub ?? adminSession.user.id;

  // Per-role fixtures store ids captured by that role's own create calls.
  const stamp = Date.now();
  const perRoleFixtures = {};
  for (const r of ROLES) perRoleFixtures[r.key] = { adminUserId };

  // Iterate role × matrix-row.
  for (const role of ROLES) {
    const sess = sessions[role.key];
    if (!sess) continue;

    console.log(`\n  -- role: ${role.key.padEnd(8)} (${role.expectedRole}) --`);

    let currentResource = '';
    for (const row of MATRIX) {
      if (row.resource !== currentResource) {
        currentResource = row.resource;
        console.log(`     [${currentResource}]`);
      }

      const exp = row.exp[role.key];
      if (!exp) continue;

      const fixtures = { ...perRoleFixtures[role.key], tenantId };
      // For mutation/follow-up rows that depend on something an unauthorized
      // role couldn't create, fall back to the admin's captured fixture so we
      // still test the gate (the admin's id is in a different role's bucket).
      for (const k of (row.needsFixture ?? [])) {
        if (!fixtures[k] && perRoleFixtures.admin[k]) fixtures[k] = perRoleFixtures.admin[k];
      }

      if (row.needsFixture && row.needsFixture.some((k) => !fixtures[k])) {
        // Cannot run row — log as skipped (not failure).
        console.log(`       ⤳ skip   ${row.method.padEnd(6)} ${row.path}  (missing fixture)`);
        continue;
      }

      const realPath = fillTemplate(row.path, fixtures);
      const body = resolveBody(row, { stamp, tenantSlug, fixtures });

      let resp;
      try {
        resp = await call(row.method, realPath, sess.token, tenantId, body);
      } catch (err) {
        resp = { status: 0, body: { error: err.message } };
      }

      const pass = exp.expectedStatuses.includes(resp.status);
      const tag  = pass ? '✓ OK  ' : '✗ FAIL';
      const note = pass ? '' : `got ${resp.status} expected [${exp.expectedStatuses.join('|')}] err=${resp.body?.error ?? '-'}`;
      console.log(`       ${tag} ${row.method.padEnd(6)} ${realPath}  ${exp.mode === 'allow' ? 'allow' : 'deny '}  ${note}`);

      results.push({
        tenant: tenantSlug,
        role: role.key,
        resource: row.resource,
        method: row.method,
        path: row.path,
        status: resp.status,
        expected: exp.expectedStatuses,
        mode: exp.mode,
        pass,
      });

      // Capture id on success (allow-mode only).
      if (pass && row.captureAs && resp.body?.data?.id) {
        perRoleFixtures[role.key][row.captureAs] = resp.body.data.id;
      }
    }
  }

  // -- cleanup pass: admin deletes anything other roles created -------------
  // The DELETE rows above already attempt cleanup for the role that created
  // the row. For any leftover ids in non-admin buckets, have admin sweep.
  for (const r of ROLES) {
    if (r.key === 'admin') continue;
    const fx = perRoleFixtures[r.key];
    if (fx.createdLeadId) {
      try { await call('DELETE', `/sales/leads/${fx.createdLeadId}`, adminSession.token, tenantId); } catch {}
    }
    if (fx.createdCaseId) {
      try { await call('DELETE', `/ops/cases/${fx.createdCaseId}`, adminSession.token, tenantId); } catch {}
    }
  }

  return { adminSession, tenantId, adminUserId };
}

// -----------------------------------------------------------------------------
// Cross-tenant isolation test
// -----------------------------------------------------------------------------
async function crossTenantIsolation(tenantCtx, results) {
  console.log('\n========================================================');
  console.log('CROSS-TENANT ISOLATION');
  console.log('========================================================');

  const a = tenantCtx['demoville-a'];
  const b = tenantCtx['acme-water'];
  if (!a || !b) {
    console.log('  -- skip: need both tenants logged in --');
    return;
  }

  // demoville-a admin token + acme-water tenant id
  const probes = [
    { method: 'GET', path: '/sales/leads' },
    { method: 'GET', path: '/ops/cases' },
    { method: 'GET', path: '/iam/users' },
    { method: 'GET', path: '/iam/teams' },
  ];
  // Capture what admin sees in their own tenant for disjoint check.
  for (const probe of probes) {
    const own = await call(probe.method, probe.path, a.adminSession.token, a.tenantId);
    const cross = await call(probe.method, probe.path, a.adminSession.token, b.tenantId);

    const ownIds = new Set((own.body?.data ?? []).map((r) => r.id).filter(Boolean));
    const crossIds = new Set((cross.body?.data ?? []).map((r) => r.id).filter(Boolean));
    const overlap = [...crossIds].filter((id) => ownIds.has(id)).length;

    const denied  = cross.status === 403;
    const disjoint = cross.status === 200 && overlap === 0;
    const pass = denied || disjoint;

    const tag = pass ? '✓ OK  ' : '✗ FAIL';
    const note = denied
      ? '403 forbidden (good)'
      : `200 own=${ownIds.size} cross=${crossIds.size} overlap=${overlap}`;
    console.log(`  ${tag} ${probe.method} ${probe.path}  ${note}`);

    results.push({
      tenant: 'cross', role: 'admin@demoville-a', resource: 'isolation',
      method: probe.method, path: probe.path,
      status: cross.status, expected: '403 or disjoint',
      mode: 'isolation', pass,
    });
  }
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
function summarize(results) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);

  const roleKeys     = new Set(results.map((r) => r.role));
  const resourceKeys = new Set(results.map((r) => r.resource));

  console.log('\n========================================================');
  console.log(`SUMMARY  ${passed}/${total} passed · ${roleKeys.size} roles · ${resourceKeys.size} resources`);
  console.log('========================================================');

  if (failed.length === 0) {
    console.log('all cells matched expectation ✓');
    return true;
  }

  // Tabular failure summary
  console.log('\nFAILURES:');
  console.log('  tenant            role       resource        method  path                                              status  expected');
  console.log('  ----------------  ---------  --------------  ------  ------------------------------------------------  ------  --------');
  for (const f of failed) {
    const exp = Array.isArray(f.expected) ? f.expected.join('|') : f.expected;
    console.log(
      '  ' +
      String(f.tenant).padEnd(16) + '  ' +
      String(f.role).padEnd(9)    + '  ' +
      String(f.resource).padEnd(14) + '  ' +
      String(f.method).padEnd(6)    + '  ' +
      String(f.path).padEnd(48)     + '  ' +
      String(f.status).padEnd(6)    + '  ' +
      String(exp)
    );
  }

  // Per-resource breakdown
  console.log('\nPER-RESOURCE BREAKDOWN:');
  const byRes = new Map();
  for (const r of results) {
    if (!byRes.has(r.resource)) byRes.set(r.resource, { pass: 0, fail: 0 });
    byRes.get(r.resource)[r.pass ? 'pass' : 'fail']++;
  }
  for (const [k, v] of [...byRes.entries()].sort()) {
    console.log(`  ${k.padEnd(20)}  ${v.pass}/${v.pass + v.fail}`);
  }

  return false;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
const results = [];
const tenantCtx = {};
for (const slug of TENANTS) {
  tenantCtx[slug] = await runForTenant(slug, results);
}
await crossTenantIsolation(tenantCtx, results);

const allGreen = summarize(results);
console.log('\nAPI = ' + API);
process.exit(allGreen ? 0 : 1);
