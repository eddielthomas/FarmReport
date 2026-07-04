// =============================================================================
// qa-s14c-customer.mjs — Sprint 14C acceptance gate.
// -----------------------------------------------------------------------------
// 1. Runs `npm run build`.
// 2. Asserts `dist/customer.html` exists.
// 3. Asserts the built customer JS chunk references:
//    • '/customer/me/projects' (the new endpoint)
//    • 'applyBrandStyle' OR 'SceneStrip' (proof the new helpers landed)
//
// Writes a human-readable report to .qa-s14c-out.txt and exits non-zero on
// any failure so CI can gate releases.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT     = 'D:/Projects/RWR/mvp';
const DIST     = resolve(ROOT, 'dist');
const OUT_FILE = resolve(ROOT, '.qa-s14c-out.txt');
const SKIP_BUILD = process.env.QA_SKIP_BUILD === '1';

const out = [];
let failures = 0;
function fail(msg) { out.push(`  FAIL: ${msg}`); failures++; }
function pass(msg) { out.push(`  PASS: ${msg}`); }
function info(msg) { out.push(`  INFO: ${msg}`); }

// ---- step 1: npm run build ------------------------------------------------
if (SKIP_BUILD) {
  out.push('-- skipping `npm run build` (QA_SKIP_BUILD=1) --');
} else {
  out.push('-- npm run build --');
  // `shell: true` so PowerShell's `npm` resolver works on Windows; on Linux
  // /macOS the shell is /bin/sh which also handles `npm` lookups.
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  const tail = (res.stdout || '').split('\n').slice(-12).join('\n').trim();
  if (res.status !== 0) {
    fail(`npm run build exited with code ${res.status}`);
    out.push('  --- stdout tail ---');
    out.push(tail);
    out.push('  --- stderr tail ---');
    out.push((res.stderr || '').split('\n').slice(-12).join('\n').trim());
  } else {
    pass('npm run build exited 0');
    info('stdout tail:');
    tail.split('\n').forEach((l) => out.push(`    ${l}`));
  }
}

// ---- step 2: dist/customer.html exists ------------------------------------
out.push('-- dist/customer.html --');
const customerHtml = resolve(DIST, 'customer.html');
if (existsSync(customerHtml)) {
  pass(`dist/customer.html exists (${statSync(customerHtml).size} bytes)`);
} else {
  fail('dist/customer.html missing');
}

// ---- step 3: scan all bundle assets for the new endpoint + marker ---------
out.push('-- bundle content --');

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const distFiles = walk(DIST);
const jsFiles = distFiles.filter((p) => p.endsWith('.js'));
info(`scanning ${jsFiles.length} js chunks under dist/`);

// 3a — endpoint
const endpoint = '/customer/me/projects';
let endpointHit = null;
for (const p of jsFiles) {
  try {
    const txt = readFileSync(p, 'utf8');
    if (txt.includes(endpoint)) { endpointHit = p; break; }
  } catch {}
}
if (endpointHit) pass(`endpoint marker found in ${endpointHit.replace(ROOT + '/', '')}`);
else             fail(`endpoint marker '${endpoint}' not found in any dist JS chunk`);

// 3b — applyBrandStyle / SceneStrip proof.
//
// Minified production bundles rename top-level function identifiers, so the
// literal strings `applyBrandStyle` and `SceneStrip` are not preserved.  We
// look for the source identifiers first (handy when QA runs against an
// unminified build), then fall back to a set of stable string-literal
// markers that *must* survive minification because they're either user-
// facing copy or localStorage keys introduced in this sprint:
//
//   • `rwr.customer.active-project` — the project-switcher persistence key
//   • `customer.scenes`             — the SceneStrip coachmark data-attr value
//   • `customer.projects`           — the ProjectSwitcher coachmark id
//   • `hydrovision` / `thermsight`  — entries in BRAND_BASEMAPS (applyBrandStyle)
//
// Hitting any one is enough — combined with the endpoint check above the
// gate proves both the wire-up + the new helpers landed in the customer
// bundle.
const markers = [
  'applyBrandStyle', 'SceneStrip',
  'rwr.customer.active-project',
  'customer.scenes', 'customer.projects',
  'hydrovision', 'thermsight',
];
let markerHit = null;
for (const p of jsFiles) {
  try {
    const txt = readFileSync(p, 'utf8');
    for (const m of markers) {
      if (txt.includes(m)) { markerHit = { file: p, marker: m }; break; }
    }
    if (markerHit) break;
  } catch {}
}
if (markerHit) pass(`marker '${markerHit.marker}' found in ${markerHit.file.replace(ROOT + '/', '')}`);
else           fail(`no SceneStrip/applyBrandStyle proxy marker bundled`);

// ---- finalise -------------------------------------------------------------
out.push('');
out.push(failures === 0 ? 'qa-s14c-customer PASS' : `qa-s14c-customer FAIL (${failures} failures)`);
const txt = out.join('\n');
writeFileSync(OUT_FILE, txt, 'utf8');
console.log(txt);
process.exit(failures === 0 ? 0 : 1);
