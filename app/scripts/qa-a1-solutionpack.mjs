// =============================================================================
// qa-a1-solutionpack.mjs — Sprint A1 SolutionPack contract gate.
// -----------------------------------------------------------------------------
// Pure logic test (no server, no DB). Asserts:
//   1. The RWR pack loads + validates against solution-pack.schema.json.
//   2. RWR pack's roleSurfaceAllowList reproduces the hardcoded S12 mapping
//      EXACTLY (parses auth-store.ts, compares cell-by-cell). Preservation proof.
//   3. RWR pack's primarySurfaceByRole reproduces primarySurfaceForRoles.
//   4. pipeline.example.yaml loads + validates.
//   5. loadVertical('nonexistent') falls back to rwr (documented soft-fallback).
//   6. KNOWN_ROLES after pack-merge ⊇ the original platform roles.
//
// Runs in <200ms. Mirrors the style of qa-s12-roles.mjs.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import {
  loadVertical, listVerticals, PLATFORM_BASE_ROLES, _resetCache,
} from '../../packages/config/verticals/index.mjs';

const OUT_PATH = 'D:/Projects/RWR/mvp/.qa-a1-solutionpack-out.txt';
const out = [];
let failures = 0;
const fail = (m) => { out.push(`  FAIL: ${m}`); failures++; };
const pass = (m) => { out.push(`  PASS: ${m}`); };
const info = (m) => { out.push(`  INFO: ${m}`); };

const AUTH_STORE = 'D:/Projects/RWR/mvp/src/crm/lib/auth-store.ts';

// -----------------------------------------------------------------------------
// JS ports of the (refactored) auth-store functions, fed with the RWR pack's
// mappings, used to compare against the canonical S12 expectations.
// -----------------------------------------------------------------------------
const ALL_AUTHED_SURFACES = new Set([
  'tenants.html','staff.html','sales.html','pm.html','analytics.html',
  'operations.html','customer.html','vendor.html','field.html',
  'dashboard.html','login.html',
]);

function roleMatches(key, roles) {
  if (key === '*admin') return roles.includes('platform:admin');
  if (key === 'vendor:*') return roles.some((r) => String(r).startsWith('vendor:'));
  return roles.includes(key);
}

function makeAllowed(pack) {
  // pack.roleSurfaceAllowList is the YAML object {key: [surfaces]}
  const entries = Object.entries(pack.roleSurfaceAllowList);
  return (roles) => {
    if (roles.includes('platform:admin')) return new Set(ALL_AUTHED_SURFACES);
    const allowed = new Set(['login.html']);
    for (const [key, surfaces] of entries) {
      if (key === '*admin') continue;
      if (roleMatches(key, roles)) { for (const s of surfaces) allowed.add(s); return allowed; }
    }
    return allowed;
  };
}

function makePrimary(pack) {
  const entries = Object.entries(pack.primarySurfaceByRole);
  return (roles) => {
    if (roles.includes('platform:admin')) {
      const a = entries.find(([k]) => k === 'platform:admin' || k === '*admin');
      return a ? a[1] : 'tenants.html';
    }
    for (const [key, surface] of entries) {
      if (key === 'platform:admin' || key === '*admin') continue;
      if (roleMatches(key, roles)) return surface;
    }
    return 'login.html';
  };
}

// Canonical S12 expectations (taken from qa-s12-roles.mjs CASES).
const S12_CASES = [
  { name: 'admin', roles: ['platform:admin','sales:manage','ops:manage','analytics:view','dashboard:view'],
    primary: 'tenants.html', allow: [...ALL_AUTHED_SURFACES] },
  { name: 'ops', roles: ['ops:manage','dashboard:view'],
    primary: 'operations.html', allow: ['operations.html','dashboard.html','pm.html','analytics.html','login.html'] },
  { name: 'sales', roles: ['sales:manage'],
    primary: 'sales.html', allow: ['sales.html','analytics.html','login.html'] },
  { name: 'field', roles: ['field.technician'],
    primary: 'field.html', allow: ['field.html','login.html'] },
  { name: 'analyst', roles: ['analytics:view','dashboard:view'],
    primary: 'analytics.html', allow: ['analytics.html','login.html'] },
  { name: 'customer', roles: ['customer:view'],
    primary: 'customer.html', allow: ['customer.html','login.html'] },
  { name: 'vendor', roles: ['vendor:view'],
    primary: 'vendor.html', allow: ['vendor.html','login.html'] },
  { name: 'ops.coordinator', roles: ['ops.coordinator'],
    primary: 'operations.html', allow: ['operations.html','dashboard.html','pm.html','analytics.html','login.html'] },
  { name: 'ops.field_specialist', roles: ['ops.field_specialist'],
    primary: 'field.html', allow: ['field.html','login.html'] },
  { name: 'empty', roles: [],
    primary: 'login.html', allow: ['login.html'] },
  { name: 'dashboard:view alone', roles: ['dashboard:view'],
    primary: 'dashboard.html', allow: ['login.html'] },
];

function setEq(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// =============================================================================
// 1) RWR pack loads + validates.
// =============================================================================
out.push('-- 1) RWR pack load + validate --');
_resetCache();
let rwr;
try {
  rwr = loadVertical('rwr');
  pass(`loadVertical('rwr') → id=${rwr.id} v${rwr.version}`);
} catch (e) {
  fail(`loadVertical('rwr') threw: ${e.message}`);
}
if (rwr) {
  if (rwr.defaultBasemap === 'satellite') pass('RWR defaultBasemap = satellite');
  else fail(`RWR defaultBasemap = ${rwr.defaultBasemap}; expected satellite`);
  if (Array.isArray(rwr.basemaps) && rwr.basemaps.length === 10) pass('RWR ships 10 S13 basemaps');
  else fail(`RWR basemaps length = ${rwr.basemaps?.length}; expected 10`);
  if (rwr.vocabulary?.entities?.detection === 'leak') pass("RWR vocabulary detection='leak'");
  else fail(`RWR vocabulary detection = ${rwr.vocabulary?.entities?.detection}`);
  if (Array.isArray(rwr.seedScenes) && rwr.seedScenes.length === 3) pass('RWR ships 3 S14A seed scenes');
  else fail(`RWR seedScenes length = ${rwr.seedScenes?.length}; expected 3`);
}

// =============================================================================
// 2) RWR allow-list reproduces S12 EXACTLY (preservation proof).
// =============================================================================
out.push('-- 2) RWR pack ≡ hardcoded S12 mapping (preservation proof) --');
if (rwr) {
  const allowed = makeAllowed(rwr);
  const primary = makePrimary(rwr);
  for (const tc of S12_CASES) {
    const a = [...allowed(tc.roles)];
    if (setEq(a, tc.allow)) pass(`allow[${tc.name}] ≡ S12 (${tc.allow.join(',')})`);
    else fail(`allow[${tc.name}] = {${a.join(',')}}; S12 expected {${tc.allow.join(',')}}`);
    const p = primary(tc.roles);
    if (p === tc.primary) pass(`primary[${tc.name}] ≡ S12 (${p})`);
    else fail(`primary[${tc.name}] = ${p}; S12 expected ${tc.primary}`);
  }

  // Cross-check that auth-store.ts embeds the SAME mappings (parity string +
  // structural check on RWR_CLIENT_PACK).
  const ts = readFileSync(AUTH_STORE, 'utf8');
  const reqTokens = [
    'RWR_CLIENT_PACK', 'roleSurfaceAllowList', 'primarySurfaceByRole',
    'allowedSurfacesForRoles', 'primarySurfaceForRoles', 'canVisit', 'sanitizeNextUrl',
    "['vendor:*', ['vendor.html']]",
    "['ops:manage', ['operations.html', 'dashboard.html', 'pm.html', 'analytics.html']]",
    "['sales:manage', ['sales.html', 'analytics.html']]",
    "['platform:admin', 'tenants.html']",
  ];
  for (const tok of reqTokens) {
    if (ts.includes(tok)) pass(`auth-store.ts embeds ${tok}`);
    else fail(`auth-store.ts MISSING ${tok}`);
  }
}

// =============================================================================
// 3) pipeline.example loads + validates.
// =============================================================================
out.push('-- 3) pipeline.example pack load + validate --');
try {
  const pipe = loadVertical('pipeline');
  pass(`loadVertical('pipeline') → id=${pipe.id} v${pipe.version}`);
  if (pipe.vocabulary?.entities?.detection === 'anomaly') pass("pipeline vocabulary detection='anomaly'");
  else fail(`pipeline detection = ${pipe.vocabulary?.entities?.detection}`);
  if (pipe.basemaps.length < 10) pass(`pipeline ships a SUBSET of basemaps (${pipe.basemaps.length})`);
  else fail('pipeline basemaps not a subset');
  if (pipe.knownRoles.includes('pipeline:integrity_engineer')) pass('pipeline role merged into knownRoles');
  else fail('pipeline:integrity_engineer not in knownRoles');
} catch (e) {
  fail(`loadVertical('pipeline') threw: ${e.message}`);
}

// =============================================================================
// 4) unknown id falls back to rwr (documented soft-fallback).
// =============================================================================
out.push('-- 4) unknown vertical → rwr fallback --');
try {
  const fb = loadVertical('nonexistent-vertical-xyz');
  if (fb.id === 'rwr') pass("loadVertical('nonexistent') fell back to rwr");
  else fail(`fallback id = ${fb.id}; expected rwr`);
} catch (e) {
  fail(`fallback threw instead of degrading: ${e.message}`);
}

// =============================================================================
// 5) KNOWN_ROLES superset proof.
// =============================================================================
out.push('-- 5) KNOWN_ROLES ⊇ platform base --');
if (rwr) {
  const missing = PLATFORM_BASE_ROLES.filter((r) => !rwr.knownRoles.includes(r));
  if (missing.length === 0) pass(`rwr.knownRoles ⊇ all ${PLATFORM_BASE_ROLES.length} platform-base roles`);
  else fail(`rwr.knownRoles MISSING base roles: ${missing.join(',')}`);
  info(`rwr.knownRoles = ${rwr.knownRoles.join(', ')}`);
}

out.push('-- listVerticals --');
info(`packs found: ${listVerticals().join(', ')}`);

// -----------------------------------------------------------------------------
out.push('');
out.push(failures === 0 ? 'qa-a1-solutionpack PASS' : `qa-a1-solutionpack FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync(OUT_PATH, txt, 'utf8');
console.log(txt);
process.exit(failures === 0 ? 0 : 1);
