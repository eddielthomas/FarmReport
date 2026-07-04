// Smoke test the production /api/v1/auth/register endpoint.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const API = 'https://alphageo.eddiethomas.space/api/v1';

async function call(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

const stamp = Date.now();
for (const t of ['employee', 'customer', 'vendor']) {
  const r = await call('/auth/register', {
    tenant_slug:  'demoville-a',
    email:        `${t}-prod-${stamp}@example.com`,
    display_name: `${t} Prod`,
    invite_type:  t,
  });
  console.log(t.padEnd(10), 'status=' + r.status, 'roles=', r.body?.data?.user?.roles, 'err=', r.body?.error || '-');
}

const bad = await call('/auth/register', {
  tenant_slug:  'demoville-a',
  email:        'x@y.z',
  display_name: 'x',
  invite_type:  'godmode',
});
console.log('bad-type  ', 'status=' + bad.status, 'err=', bad.body?.error || '-');
