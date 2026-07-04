// =============================================================================
// qa-s12-roles.mjs — Sprint 12 role → surface allow-list correctness.
// -----------------------------------------------------------------------------
// Pure logic test (no server, no DB). Verifies three things:
//
//   1. The canonical role → surface mapping in this script's TEST_CASES is
//      respected by a JS port of allowedSurfacesForRoles + primarySurfaceForRoles.
//      The JS port lives inline here AND in mvp/public/role-gate.js — keeping
//      them in lockstep with mvp/src/crm/lib/auth-store.ts is the orchestrator's
//      manual responsibility (the parity-string check below catches the
//      obvious drift cases).
//   2. The TS source file in auth-store.ts contains the load-bearing role
//      keys and surface names so a refactor that accidentally drops a clause
//      gets caught.
//   3. The /role-gate.js script's allowedSurfacesForRoles agrees with the
//      canonical test cases (cell-by-cell).
//
// Runs in <100ms.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';

const OUT_PATH = 'D:/Projects/RWR/mvp/.qa-s12-roles-out.txt';
const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

// -----------------------------------------------------------------------------
// JS port of the auth-store.ts functions. MUST stay in sync — any change to
// the TS source must be mirrored here.
// -----------------------------------------------------------------------------
function primarySurfaceForRoles(roles) {
  if (roles.includes('platform:admin'))      return 'tenants.html';
  if (roles.some((r) => String(r).startsWith('vendor:'))) return 'vendor.html';
  if (roles.includes('ops.field_specialist') ||
      roles.includes('field.technician') ||
      roles.includes('field:technician')) return 'field.html';
  if (roles.includes('ops.coordinator'))     return 'operations.html';
  if (roles.includes('ops:manage'))          return 'operations.html';
  if (roles.includes('sales:manage'))        return 'sales.html';
  if (roles.includes('analytics:view'))      return 'analytics.html';
  if (roles.includes('customer:view'))       return 'customer.html';
  if (roles.includes('dashboard:view'))      return 'dashboard.html';
  return 'login.html';
}

const ALL_AUTHED_SURFACES = new Set([
  'tenants.html','staff.html','sales.html','pm.html','analytics.html',
  'operations.html','customer.html','vendor.html','field.html',
  'dashboard.html','login.html',
]);

function allowedSurfacesForRoles(roles) {
  if (roles.includes('platform:admin')) return new Set(ALL_AUTHED_SURFACES);
  const allowed = new Set(['login.html']);
  if (roles.some((r) => String(r).startsWith('vendor:'))) {
    allowed.add('vendor.html'); return allowed;
  }
  const isFieldTier = roles.includes('field.technician')
                   || roles.includes('field:technician')
                   || roles.includes('ops.field_specialist');
  if (isFieldTier) { allowed.add('field.html'); return allowed; }
  if (roles.includes('ops.coordinator') || roles.includes('ops:manage')) {
    allowed.add('operations.html');
    allowed.add('dashboard.html');
    allowed.add('pm.html');
    allowed.add('analytics.html');
    return allowed;
  }
  if (roles.includes('sales:manage')) {
    allowed.add('sales.html');
    allowed.add('analytics.html');
    return allowed;
  }
  if (roles.includes('analytics:view')) { allowed.add('analytics.html'); return allowed; }
  if (roles.includes('customer:view'))  { allowed.add('customer.html');  return allowed; }
  return allowed;
}

function sanitizeNextUrl(next) {
  if (!next || typeof next !== 'string') return null;
  if (/^[a-z]+:/i.test(next))     return null;
  if (next.startsWith('//'))      return null;
  let path = next.replace(/^\/+/, '');
  const qIdx = path.search(/[?#]/);
  if (qIdx >= 0) path = path.slice(0, qIdx);
  if (path.includes('..') || path.includes('\\')) return null;
  if (path.includes('/'))         return null;
  if (!/\.html$/.test(path))      return null;
  return path;
}

// -----------------------------------------------------------------------------
// 1) canonical test table.
// -----------------------------------------------------------------------------
const ALL = ['tenants.html','staff.html','sales.html','pm.html','analytics.html',
             'operations.html','customer.html','vendor.html','field.html',
             'dashboard.html','login.html'];

const CASES = [
  {
    name: 'admin bundle (super-user)',
    roles: ['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
    expectedPrimary: 'tenants.html',
    mustAllow:  ALL,
    mustForbid: [],
  },
  {
    name: 'ops bundle',
    roles: ['ops:manage','dashboard:view','cases.read','cases.manage'],
    expectedPrimary: 'operations.html',
    mustAllow:  ['operations.html','dashboard.html','pm.html','analytics.html','login.html'],
    mustForbid: ['tenants.html','sales.html','field.html','vendor.html','customer.html','staff.html'],
  },
  {
    name: 'sales bundle',
    roles: ['sales:manage','crm.lead.read','crm.lead.write','crm.opportunity.read'],
    expectedPrimary: 'sales.html',
    mustAllow:  ['sales.html','analytics.html','login.html'],
    mustForbid: ['dashboard.html','operations.html','field.html','tenants.html','vendor.html','customer.html','staff.html','pm.html'],
  },
  {
    name: 'field bundle',
    roles: ['field.technician','field.job.read','field.location.write','field.checkin','field.upload.write','field.task.complete'],
    expectedPrimary: 'field.html',
    mustAllow:  ['field.html','login.html'],
    mustForbid: ['dashboard.html','sales.html','operations.html','tenants.html','vendor.html','customer.html','staff.html','pm.html','analytics.html'],
  },
  {
    name: 'analyst bundle (analytics:view + dashboard:view)',
    roles: ['analytics:view','dashboard:view','crm.dashboard.view'],
    // analytics:view branch hits first in allowedSurfacesForRoles and yields
    // [analytics.html, login.html]. dashboard:view ALONE no longer entitles.
    expectedPrimary: 'analytics.html',
    mustAllow:  ['analytics.html','login.html'],
    mustForbid: ['sales.html','operations.html','field.html','tenants.html','vendor.html','customer.html','staff.html','pm.html','dashboard.html'],
  },
  {
    name: 'customer bundle',
    roles: ['customer:view'],
    expectedPrimary: 'customer.html',
    mustAllow:  ['customer.html','login.html'],
    mustForbid: ['dashboard.html','sales.html','field.html','operations.html','tenants.html','vendor.html','staff.html','pm.html','analytics.html'],
  },
  {
    name: 'vendor bundle',
    roles: ['vendor:view'],
    expectedPrimary: 'vendor.html',
    mustAllow:  ['vendor.html','login.html'],
    mustForbid: ['dashboard.html','sales.html','field.html','operations.html','tenants.html','customer.html','staff.html','pm.html','analytics.html'],
  },
  {
    name: 'ops.coordinator (S9.1)',
    roles: ['ops.coordinator'],
    expectedPrimary: 'operations.html',
    mustAllow:  ['operations.html','dashboard.html','pm.html','analytics.html','login.html'],
    mustForbid: ['tenants.html','sales.html','field.html','vendor.html','customer.html','staff.html'],
  },
  {
    name: 'ops.field_specialist (S9.1)',
    roles: ['ops.field_specialist'],
    expectedPrimary: 'field.html',
    mustAllow:  ['field.html','login.html'],
    mustForbid: ['operations.html','dashboard.html','sales.html','tenants.html','vendor.html','customer.html','staff.html','pm.html','analytics.html'],
  },
  {
    name: 'empty roles',
    roles: [],
    expectedPrimary: 'login.html',
    mustAllow:  ['login.html'],
    mustForbid: ['dashboard.html','sales.html','field.html','operations.html','tenants.html','vendor.html','customer.html','staff.html','pm.html','analytics.html'],
  },
  {
    name: 'dashboard:view alone (legacy)',
    roles: ['dashboard:view'],
    // primarySurfaceForRoles still falls through to dashboard.html — that's
    // intentional so legacy demo users land somewhere. BUT the allow-list
    // does NOT grant dashboard.html — only login.html. The login.html gate
    // sees the token, allow does not include dashboard.html, and bounces
    // them straight back to login.html (no useful landing). Operators MUST
    // grant an explicit surface role.
    expectedPrimary: 'dashboard.html',
    mustAllow:  ['login.html'],
    mustForbid: ['dashboard.html','operations.html','sales.html','field.html','tenants.html','vendor.html','customer.html','staff.html','pm.html','analytics.html'],
  },
];

// -----------------------------------------------------------------------------
// 2) run each case against the JS port.
// -----------------------------------------------------------------------------
for (const tc of CASES) {
  out.push(`-- case: ${tc.name} --`);
  const primary = primarySurfaceForRoles(tc.roles);
  if (primary === tc.expectedPrimary) {
    pass(`primarySurfaceForRoles → ${primary}`);
  } else {
    fail(`primarySurfaceForRoles → ${primary}; expected ${tc.expectedPrimary}`);
  }
  const allowed = allowedSurfacesForRoles(tc.roles);
  for (const s of tc.mustAllow) {
    if (allowed.has(s)) pass(`allow includes ${s}`);
    else                fail(`allow MISSING ${s} (set: ${[...allowed].join(',')})`);
  }
  for (const s of tc.mustForbid) {
    if (!allowed.has(s)) pass(`allow correctly FORBIDS ${s}`);
    else                 fail(`allow WRONGLY INCLUDES ${s} (set: ${[...allowed].join(',')})`);
  }
}

// -----------------------------------------------------------------------------
// 2b) post-login landing (Login.tsx landAfterAuth port).
//     Mirrors: compute primary, sanitize next, redirect to next only if it is
//     in the allow-list, else /<primary>. The bare surface (no leading slash)
//     is asserted here.
// -----------------------------------------------------------------------------
function landAfterAuth(roles, next) {
  const primary = primarySurfaceForRoles(roles);
  const allowed = allowedSurfacesForRoles(roles);
  const safeNext = sanitizeNextUrl(next);
  return safeNext && allowed.has(safeNext) ? safeNext : primary;
}

out.push('-- landAfterAuth landing --');
const LANDING_CASES = [
  {
    name: 'field bundle + next=/dashboard.html (forbidden) → field.html',
    roles: ['field.technician'],
    next: '/dashboard.html',
    want: 'field.html',
  },
  {
    name: 'customer bundle, no next → customer.html',
    roles: ['customer:view'],
    next: null,
    want: 'customer.html',
  },
  {
    name: 'admin + next=/sales.html (allowed) → sales.html',
    roles: ['platform:admin'],
    next: '/sales.html',
    want: 'sales.html',
  },
  {
    name: 'sales + next=/operations.html (forbidden) → sales.html',
    roles: ['sales:manage'],
    next: '/operations.html',
    want: 'sales.html',
  },
];
for (const lc of LANDING_CASES) {
  const got = landAfterAuth(lc.roles, lc.next);
  if (got === lc.want) pass(`land[${lc.name}] → ${got}`);
  else                 fail(`land[${lc.name}] → ${got}; expected ${lc.want}`);
}

// -----------------------------------------------------------------------------
// 3) sanitizeNextUrl tests.
// -----------------------------------------------------------------------------
out.push('-- sanitizeNextUrl --');
const sanCases = [
  { in: '/dashboard.html',          want: 'dashboard.html' },
  { in: 'dashboard.html',           want: 'dashboard.html' },
  { in: '/field.html?tab=jobs',     want: 'field.html' },
  { in: '/sales.html#anchor',       want: 'sales.html' },
  { in: 'https://evil.com/x.html',  want: null },
  { in: '//evil.com/x.html',        want: null },
  { in: '/../etc/passwd',           want: null },
  { in: '/foo',                     want: null },
  { in: '/sub/dir.html',            want: null },
  { in: '',                         want: null },
  { in: null,                       want: null },
];
for (const c of sanCases) {
  const got = sanitizeNextUrl(c.in);
  if (got === c.want) pass(`sanitize(${JSON.stringify(c.in)}) → ${JSON.stringify(got)}`);
  else                fail(`sanitize(${JSON.stringify(c.in)}) → ${JSON.stringify(got)}; expected ${JSON.stringify(c.want)}`);
}

// -----------------------------------------------------------------------------
// 4) source-string parity check: the TS source MUST mention the canonical
//    role keys and surface names so a future refactor that drops a clause
//    fails this gate.
// -----------------------------------------------------------------------------
out.push('-- auth-store.ts source parity --');
const TS_PATH = 'D:/Projects/RWR/mvp/src/crm/lib/auth-store.ts';
const tsSrc   = readFileSync(TS_PATH, 'utf8');
const TS_REQUIRED_TOKENS = [
  'allowedSurfacesForRoles',
  'sanitizeNextUrl',
  'canVisit',
  'primarySurfaceForRoles',
  'platform:admin',
  'ops.field_specialist',
  'ops.coordinator',
  'ops:manage',
  'sales:manage',
  'analytics:view',
  'customer:view',
  'field.technician',
  'dashboard.html',
  'tenants.html',
  'operations.html',
  'sales.html',
  'field.html',
  'analytics.html',
  'customer.html',
  'vendor.html',
  'pm.html',
  'staff.html',
  'login.html',
];
for (const tok of TS_REQUIRED_TOKENS) {
  if (tsSrc.includes(tok)) pass(`auth-store.ts contains ${tok}`);
  else                     fail(`auth-store.ts MISSING ${tok}`);
}

// -----------------------------------------------------------------------------
// 5) role-gate.js parity check — load + extract inner funcs by regex, then
//    run them against the same canonical CASES.
// -----------------------------------------------------------------------------
out.push('-- public/role-gate.js parity --');
const GATE_PATH = 'D:/Projects/RWR/mvp/public/role-gate.js';
const gateSrc   = readFileSync(GATE_PATH, 'utf8');

function extractInnerFn(src, name) {
  const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) throw new Error(`function ${name} not found in role-gate.js`);
  const braceStart = src.indexOf('{', m.index);
  if (braceStart < 0) throw new Error(`no body for ${name} in role-gate.js`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

// Sprint A2: role-gate.js routing is now PACK-DRIVEN — primarySurfaceForRoles /
// allowedSurfacesForRoles delegate to primaryFromPack/allowedFromPack when a
// module-level PACK (window.__RWR_ROLE_PACK, set by the build-generated
// role-gate-pack.js) is present, else to the hardcoded RWR fallback. To prove
// RWR behavior is byte-identical we exercise BOTH paths against the canonical
// CASES: (A) pack-driven with the real generated pack loaded, (B) hardcoded
// fallback with PACK=null. Both must reproduce S12 exactly.
const GATE_HELPERS = [
  'roleMatches', 'primaryFromPack', 'primaryFromHardcoded', 'primarySurfaceForRoles',
  'allowedFromPack', 'allowedFromHardcoded', 'allowedSurfacesForRoles',
];

// Load the build-generated pack the way the browser does (role-gate-pack.js
// assigns window.__RWR_ROLE_PACK), so the pack path is tested with the SAME
// object the pre-paint gate reads in production.
let GENERATED_PACK = null;
try {
  const packSrc = readFileSync('D:/Projects/RWR/mvp/public/role-gate-pack.js', 'utf8');
  const win = {};
  new Function('window', packSrc)(win);
  GENERATED_PACK = win.__RWR_ROLE_PACK || null;
  if (GENERATED_PACK) pass('loaded build-generated role-gate-pack.js (window.__RWR_ROLE_PACK)');
  else                fail('role-gate-pack.js did not set window.__RWR_ROLE_PACK');
} catch (e) {
  fail(`could not load role-gate-pack.js: ${e.message}`);
}

function makeGateApi(pack) {
  let fnSrc = "var ALL_SURFACES = ['tenants.html','staff.html','sales.html','pm.html'," +
              "'analytics.html','operations.html','customer.html','vendor.html'," +
              "'field.html','dashboard.html','login.html'];\n" +
              'var PACK = __INJECTED_PACK__;\n';
  for (const h of GATE_HELPERS) fnSrc += extractInnerFn(gateSrc, h) + '\n';
  const ctor = new Function('__INJECTED_PACK__',
    `${fnSrc}\n return { primarySurfaceForRoles, allowedSurfacesForRoles };`);
  return ctor(pack);
}

function runGatePath(label, pack) {
  let api;
  try {
    api = makeGateApi(pack);
    pass(`extracted gate funcs [${label}]`);
  } catch (e) {
    fail(`gate fn extract failed [${label}]: ${e.message}`);
    return;
  }
  for (const tc of CASES) {
    const gp = api.primarySurfaceForRoles(tc.roles);
    if (gp === tc.expectedPrimary) pass(`gate.primary[${label}][${tc.name}] = ${gp}`);
    else fail(`gate.primary[${label}][${tc.name}] = ${gp}; expected ${tc.expectedPrimary}`);
    const ga = api.allowedSurfacesForRoles(tc.roles);
    for (const s of tc.mustAllow) {
      if (ga[s]) pass(`gate.allow[${label}][${tc.name}] includes ${s}`);
      else       fail(`gate.allow[${label}][${tc.name}] MISSING ${s} (keys: ${Object.keys(ga).join(',')})`);
    }
    for (const s of tc.mustForbid) {
      if (!ga[s]) pass(`gate.allow[${label}][${tc.name}] forbids ${s}`);
      else        fail(`gate.allow[${label}][${tc.name}] WRONGLY INCLUDES ${s}`);
    }
  }
}

// (A) pack-driven path with the real generated RWR pack — the production path.
if (GENERATED_PACK) runGatePath('pack', GENERATED_PACK);
// (B) hardcoded fallback path — what runs if role-gate-pack.js is ever absent.
runGatePath('fallback', null);

// -----------------------------------------------------------------------------
// 6) verify every authenticated HTML entry references role-gate.js with the
//    correct data-surface attribute.
// -----------------------------------------------------------------------------
out.push('-- HTML entry role-gate wiring --');
const HTML_ENTRIES = [
  ['dashboard.html',  'dashboard.html'],
  ['sales.html',      'sales.html'],
  ['pm.html',         'pm.html'],
  ['analytics.html',  'analytics.html'],
  ['tenants.html',    'tenants.html'],
  ['staff.html',      'staff.html'],
  ['customer.html',   'customer.html'],
  ['operations.html', 'operations.html'],
  ['vendor.html',     'vendor.html'],
  ['field.html',      'field.html'],
  ['login.html',      'login.html'],
];
for (const [file, surface] of HTML_ENTRIES) {
  const path = `D:/Projects/RWR/mvp/${file}`;
  const src  = readFileSync(path, 'utf8');
  const pattern = new RegExp(`<script\\s+src=["']/role-gate\\.js["']\\s+data-surface=["']${surface.replace('.', '\\.')}["']`);
  if (pattern.test(src)) {
    pass(`${file} references role-gate.js data-surface=${surface}`);
  } else {
    fail(`${file} does NOT reference role-gate.js with data-surface=${surface}`);
  }
}

// -----------------------------------------------------------------------------
out.push('');
out.push(failures === 0 ? 'qa-s12-roles PASS' : `qa-s12-roles FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync(OUT_PATH, txt, 'utf8');
console.log(txt);
process.exit(failures === 0 ? 0 : 1);
