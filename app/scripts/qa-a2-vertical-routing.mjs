#!/usr/bin/env node
// =============================================================================
// qa-a2-vertical-routing.mjs — Sprint A2 gate.
// -----------------------------------------------------------------------------
// Proves that role + surface routing is now PACK-DRIVEN end-to-end:
//
//   (A) Active vertical = rwr (default) reproduces the S12 routing decisions
//       byte-for-byte — the production path is unchanged.
//   (B) Switching the active vertical to `pipeline` (pipeline.example.yaml)
//       changes the routing maps with ZERO code edits — the verticalization
//       proof. A concrete discriminator: `sales:manage` routes to sales.html
//       under RWR but to login.html under pipeline (no sales surface there).
//   (C) KNOWN_ROLES merges the pack's roles — the pipeline pack contributes
//       `pipeline:integrity_engineer`; the rwr pack is a superset of the
//       platform base.
//   (D) vendor/customer routing stays intact under the RWR pack (roadmap A2).
//   (E) The public /api/v1/vertical endpoint is wired (single source of truth).
//
// The routing engine below mirrors public/role-gate.js's pack path 1:1 so the
// gate validates the SAME decisions the browser makes from the generated pack.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadVertical } from '../../packages/config/verticals/index.mjs';
import { buildClientPack, ALL_AUTHED_SURFACES } from './gen-role-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

let failures = 0;
const pass = (m) => console.log(`  PASS: ${m}`);
const fail = (m) => { console.log(`  FAIL: ${m}`); failures++; };
const eq = (label, got, want) =>
  (got === want ? pass(`${label} = ${got}`) : fail(`${label} = ${got}; expected ${want}`));

// --- routing engine: 1:1 mirror of role-gate.js pack path --------------------
function roleMatches(key, rs) {
  if (key === '*admin') return rs.includes('platform:admin');
  if (key === 'vendor:*') return rs.some((r) => typeof r === 'string' && r.indexOf('vendor:') === 0);
  return rs.includes(key);
}
function primaryFromPack(rs, pack) {
  if (rs.includes('platform:admin')) {
    const e = pack.primarySurfaceByRole.find(([k]) => k === 'platform:admin' || k === '*admin');
    return e ? e[1] : 'tenants.html';
  }
  for (const [k, surface] of pack.primarySurfaceByRole) {
    if (k === 'platform:admin' || k === '*admin') continue;
    if (roleMatches(k, rs)) return surface;
  }
  return 'login.html';
}
function allowedFromPack(rs, pack) {
  if (rs.includes('platform:admin')) {
    const s = {}; for (const x of ALL_AUTHED_SURFACES) s[x] = true; return s;
  }
  const allowed = { 'login.html': true };
  for (const [k, surfaces] of pack.roleSurfaceAllowList) {
    if (k === '*admin') continue;
    if (roleMatches(k, rs)) { for (const x of surfaces || []) allowed[x] = true; return allowed; }
  }
  return allowed;
}

function checkCase(label, client, rs, expPrimary, mustAllow = [], mustForbid = []) {
  eq(`${label}.primary`, primaryFromPack(rs, client), expPrimary);
  const a = allowedFromPack(rs, client);
  for (const s of mustAllow)  (a[s] ? pass(`${label}.allow includes ${s}`) : fail(`${label}.allow MISSING ${s}`));
  for (const s of mustForbid) (!a[s] ? pass(`${label}.allow forbids ${s}`) : fail(`${label}.allow WRONGLY INCLUDES ${s}`));
}

// =============================================================================
console.log('-- (A) active=rwr reproduces S12 routing (production unchanged) --');
const rwr = buildClientPack(loadVertical('rwr'));
eq('rwr client pack id', rwr.id, 'rwr');
checkCase('rwr[admin]',  rwr, ['platform:admin'], 'tenants.html',
  ['tenants.html', 'staff.html', 'sales.html', 'dashboard.html'], []);
checkCase('rwr[ops]',    rwr, ['ops:manage'], 'operations.html',
  ['operations.html', 'dashboard.html', 'pm.html', 'analytics.html', 'login.html'],
  ['sales.html', 'tenants.html', 'field.html']);
checkCase('rwr[sales]',  rwr, ['sales:manage'], 'sales.html',
  ['sales.html', 'analytics.html', 'login.html'], ['dashboard.html', 'operations.html']);
checkCase('rwr[field]',  rwr, ['field.technician'], 'field.html',
  ['field.html', 'login.html'], ['dashboard.html', 'operations.html', 'analytics.html']);
checkCase('rwr[analyst]', rwr, ['analytics:view'], 'analytics.html',
  ['analytics.html', 'login.html'], ['sales.html', 'dashboard.html']);
checkCase('rwr[ops.coordinator]', rwr, ['ops.coordinator'], 'operations.html',
  ['operations.html', 'dashboard.html', 'pm.html', 'analytics.html'], ['field.html']);
checkCase('rwr[ops.field_specialist]', rwr, ['ops.field_specialist'], 'field.html',
  ['field.html', 'login.html'], ['operations.html']);

console.log('-- (D) vendor/customer routing intact under RWR --');
checkCase('rwr[vendor]',   rwr, ['vendor:view'],   'vendor.html',
  ['vendor.html', 'login.html'], ['dashboard.html', 'customer.html']);
checkCase('rwr[customer]', rwr, ['customer:view'], 'customer.html',
  ['customer.html', 'login.html'], ['dashboard.html', 'vendor.html']);

// =============================================================================
console.log('-- (B) active=pipeline changes routing with zero code edits --');
const pipe = buildClientPack(loadVertical('pipeline'));
eq('pipeline client pack id', pipe.id, 'pipeline');
checkCase('pipe[admin]', pipe, ['platform:admin'], 'tenants.html', ['tenants.html', 'analytics.html'], []);
checkCase('pipe[ops]',   pipe, ['ops:manage'], 'operations.html',
  ['operations.html', 'analytics.html', 'login.html'], ['dashboard.html', 'pm.html']);
checkCase('pipe[integrity_engineer]', pipe, ['pipeline:integrity_engineer'], 'operations.html',
  ['operations.html', 'analytics.html', 'login.html'], ['dashboard.html', 'sales.html']);
checkCase('pipe[analyst]',  pipe, ['analytics:view'], 'analytics.html', ['analytics.html', 'login.html'], []);
checkCase('pipe[vendor]',   pipe, ['vendor:view'],   'vendor.html',   ['vendor.html', 'login.html'], []);
checkCase('pipe[customer]', pipe, ['customer:view'], 'customer.html', ['customer.html', 'login.html'], []);
checkCase('pipe[field]',    pipe, ['field.technician'], 'field.html',  ['field.html', 'login.html'], []);

// The discriminator: sales:manage routes differently between the two packs,
// with no code change — only the active YAML differs.
const rwrSales  = primaryFromPack(['sales:manage'], rwr);
const pipeSales = primaryFromPack(['sales:manage'], pipe);
(rwrSales === 'sales.html' && pipeSales === 'login.html')
  ? pass(`switch proof: sales:manage → rwr:${rwrSales} vs pipeline:${pipeSales} (routing changed, zero code edits)`)
  : fail(`switch proof failed: rwr:${rwrSales} pipeline:${pipeSales}`);

// =============================================================================
console.log('-- (C) KNOWN_ROLES merges pack roles --');
const rwrKnown  = loadVertical('rwr').knownRoles || [];
const pipeKnown = loadVertical('pipeline').knownRoles || [];
const PLATFORM_BASE = ['platform:admin', 'sales:manage', 'ops:manage', 'analytics:view',
  'dashboard:view', 'customer:view', 'vendor:view'];
const baseOk = PLATFORM_BASE.every((r) => rwrKnown.includes(r));
baseOk ? pass(`rwr.knownRoles ⊇ platform base (${rwrKnown.length} roles)`)
       : fail(`rwr.knownRoles missing platform base members`);
pipeKnown.includes('pipeline:integrity_engineer')
  ? pass('pipeline.knownRoles contributes pipeline:integrity_engineer (vertical role merged)')
  : fail(`pipeline.knownRoles missing pipeline:integrity_engineer (${pipeKnown.join(',')})`);

// =============================================================================
console.log('-- (E) /api/v1/vertical endpoint wired --');
const idxSrc = readFileSync(resolve(REPO, 'mvp/api/v1/index.mjs'), 'utf8');
[
  ["registers '/vertical' as public", /['"`]\/vertical['"`]/],
  ['handles GET /vertical', /path === '\/vertical'\s*&&\s*method === 'GET'/],
  ['imports getActiveVertical', /getActiveVertical/],
  ['emits roleSurfaceAllowList in projection', /roleSurfaceAllowList/],
  ['emits primarySurfaceByRole in projection', /primarySurfaceByRole/],
].forEach(([label, re]) => (re.test(idxSrc) ? pass(label) : fail(`index.mjs ${label} — not found`)));

// =============================================================================
console.log('');
if (failures === 0) { console.log('qa-a2-vertical-routing PASS'); process.exit(0); }
console.log(`qa-a2-vertical-routing FAIL (${failures} failures)`); process.exit(1);
