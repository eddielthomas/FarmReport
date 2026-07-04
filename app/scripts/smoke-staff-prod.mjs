// Smoke test the production /api/v1/iam/* user-management surface end-to-end.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const API = 'https://alphageo.eddiethomas.space/api/v1';

async function login(email, slug = 'demoville-a') {
  const r = await fetch(API + '/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: slug, email }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('login failed: ' + JSON.stringify(j));
  return { token: j.data.token, user: j.data.user };
}

async function call(method, path, token, tenant_id, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token,
      'X-Tenant-Id':   tenant_id,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* 204 etc */ }
  return { status: r.status, body: j };
}

const tests = [];
function expect(name, cond, detail) {
  tests.push({ name, pass: !!cond, detail });
  const tag = cond ? '\u2713 OK  ' : '\u2717 FAIL';
  console.log(`${tag} ${name}${detail ? '  · ' + detail : ''}`);
}

const admin = await login('admin@demoville-a.demo');
console.log('admin roles:', admin.user.roles);

// list users
const list = await call('GET', '/iam/users', admin.token, admin.user.tenant_id);
expect('list users 200', list.status === 200, 'count=' + (list.body?.data?.length ?? '?'));

// list teams
const teams = await call('GET', '/iam/teams', admin.token, admin.user.tenant_id);
expect('list teams 200', teams.status === 200, 'count=' + (teams.body?.data?.length ?? '?'));

// create user
const stamp = Date.now();
const newEmail = `smoke-${stamp}@demoville-a.test`;
const create = await call('POST', '/iam/users', admin.token, admin.user.tenant_id, {
  email:        newEmail,
  display_name: 'Smoke User',
  roles:        ['sales:manage', 'dashboard:view'],
});
expect('create user 201', create.status === 201, 'id=' + create.body?.data?.id);
const newId = create.body?.data?.id;

// update roles (PUT)
const patch = await call('PUT', '/iam/users/' + newId, admin.token, admin.user.tenant_id, {
  roles: ['ops:manage', 'dashboard:view'],
});
expect('update roles 200', patch.status === 200, JSON.stringify(patch.body?.data?.roles));

// create team
const teamName = 'Smoke Team ' + stamp;
const ctm = await call('POST', '/iam/teams', admin.token, admin.user.tenant_id, {
  name:        teamName,
  description: 'smoke',
});
expect('create team 201', ctm.status === 201, 'id=' + ctm.body?.data?.id);
const teamId = ctm.body?.data?.id;

// add user to team
const addMem = await call('POST', `/iam/teams/${teamId}/members`, admin.token, admin.user.tenant_id, {
  user_id: newId,
  role:    'member',
});
expect('add team member 201', addMem.status === 201);

// list team members
const mems = await call('GET', `/iam/teams/${teamId}/members`, admin.token, admin.user.tenant_id);
expect('list members 200', mems.status === 200, 'count=' + (mems.body?.data?.length ?? '?'));

// non-admin can't list users
const sales = await login('sales@demoville-a.demo');
const denied = await call('GET', '/iam/users', sales.token, sales.user.tenant_id);
expect('non-admin denied 403', denied.status === 403, 'err=' + denied.body?.error);

// cleanup: delete the smoke user (admin)
const del = await call('DELETE', '/iam/users/' + newId, admin.token, admin.user.tenant_id);
expect('delete user 204', del.status === 204 || del.status === 200);
const delT = await call('DELETE', '/iam/teams/' + teamId, admin.token, admin.user.tenant_id);
expect('delete team 204', delT.status === 204 || delT.status === 200);

const passed = tests.filter(t => t.pass).length;
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
