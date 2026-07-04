// Smoke test: customer:view RBAC carve-out for /sales/leads reads + message send
const API = process.env.API ?? 'http://localhost:5180';
const TENANT = 'demoville-a';

async function login(email) {
  const r = await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ tenant_slug: TENANT, email }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data?.token ?? j.token;
}

async function call(method, path, token, body) {
  const r = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
      'x-tenant-id': TENANT,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = r.status < 400 ? await r.json().catch(() => null) : await r.text();
  const data = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
  return { status: r.status, body: data };
}

const expect = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${actual} (expected ${expected})`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  const customer = await login('customer-demoville-a@example.com');
  const admin    = await login('admin@demoville-a.local');

  // Read leads -> should 200 (carve-out)
  const r1 = await call('GET', '/sales/leads', customer);
  expect('customer GET /sales/leads', r1.status, 200);

  // Pick a lead
  const leadId = Array.isArray(r1.body) && r1.body[0]?.id;
  if (!leadId) { console.log('FAIL no leads to test against'); process.exit(1); }

  const r2 = await call('GET', `/sales/leads/${leadId}`, customer);
  expect('customer GET /sales/leads/:id', r2.status, 200);

  const r3 = await call('GET', `/sales/leads/${leadId}/messages`, customer);
  expect('customer GET /sales/leads/:id/messages', r3.status, 200);

  const r4 = await call('GET', `/sales/leads/${leadId}/files`, customer);
  expect('customer GET /sales/leads/:id/files', r4.status, 200);

  const r5 = await call('GET', `/sales/meetings`, customer);
  expect('customer GET /sales/meetings', r5.status, 200);

  // Send a message as contact
  const r6 = await call('POST', `/sales/leads/${leadId}/messages`, customer, {
    body: 'smoke-test ping from customer portal',
    sender: 'contact',
  });
  expect('customer POST /sales/leads/:id/messages', r6.status, 201);

  // Block writes outside carve-out
  const r7 = await call('PATCH', `/sales/leads/${leadId}`, customer, { status: 'client' });
  expect('customer PATCH /sales/leads/:id (denied)', r7.status, 403);

  // Block /ops, /analytics
  const r8 = await call('GET', '/ops/cases', customer);
  expect('customer GET /ops/cases (denied)', r8.status, 403);
  const r9 = await call('GET', '/analytics/dashboard/metrics', customer);
  expect('customer GET /analytics/dashboard/metrics (denied)', r9.status, 403);

  // Admin still works on same routes
  const r10 = await call('GET', '/ops/cases', admin);
  expect('admin GET /ops/cases', r10.status, 200);

  console.log(process.exitCode ? 'CUSTOMER SMOKE FAILED' : 'CUSTOMER SMOKE PASSED');
})().catch(e => { console.error(e); process.exit(1); });
