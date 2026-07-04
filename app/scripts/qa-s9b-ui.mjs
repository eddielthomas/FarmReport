// =============================================================================
// qa-s9b-ui.mjs — Sprint S9B acceptance gates for the field PWA + manager panels.
// -----------------------------------------------------------------------------
// 1. Runs `npm run build` in mvp/ (skip with --skip-build).
// 2. Asserts dist/field.html exists and references the hashed main-field-*.js
//    bundle AND links the field manifest.
// 3. Asserts dist/field-manifest.json exists with the required PWA fields.
// 4. Asserts dist/field-sw.js exists and contains a `caches.open` call.
// 5. Static-analysis: useGeolocation + getFieldSocket references survive the
//    rollup tree-shake (grep the emitted asset bundles).
//
// Exits non-zero on any failure so CI can gate on it.
// =============================================================================

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT       = resolve(__filename, '..', '..');           // mvp/
const DIST       = resolve(ROOT, 'dist');

const args       = new Set(process.argv.slice(2));
const skipBuild  = args.has('--skip-build');

const lines      = [];
let failures     = 0;

function ok(msg)   { lines.push(`  ok   ${msg}`); }
function fail(msg) { lines.push(`  FAIL ${msg}`); failures += 1; }
function section(title) {
  lines.push('');
  lines.push(`-- ${title} ` + '-'.repeat(Math.max(0, 60 - title.length)));
}

// --- 1. BUILD ----------------------------------------------------------------
section('Build');
if (skipBuild) {
  lines.push('  skipped (--skip-build)');
} else {
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    ok('npm run build completed');
  } catch (e) {
    fail(`npm run build failed: ${e.message}`);
  }
}

// --- 2. dist/field.html ------------------------------------------------------
section('dist/field.html');
const distField = join(DIST, 'field.html');
let fieldHtml   = '';
if (!existsSync(distField)) {
  fail(`missing ${distField}`);
} else {
  ok('dist/field.html exists');
  fieldHtml = readFileSync(distField, 'utf8');

  // Manifest link
  if (/<link[^>]+rel=["']manifest["'][^>]+href=["']\/field-manifest\.json["']/i.test(fieldHtml)) {
    ok('manifest link present');
  } else {
    fail('manifest link missing or wrong href');
  }

  // Vite names the entry chunk after the rollup input key (`field` from
  // vite.config.js -> rollupOptions.input.field). The emitted module
  // therefore appears as `assets/field-<hash>.js`.
  if (/assets\/field-[A-Za-z0-9_-]+\.js/.test(fieldHtml)) {
    ok('field entry bundle (assets/field-*.js) referenced');
  } else {
    fail('field entry bundle (assets/field-*.js) reference missing');
  }

  // Apple PWA meta tags
  if (/apple-mobile-web-app-capable/.test(fieldHtml)) ok('iOS PWA meta tags present');
  else fail('iOS PWA meta tags missing');

  // theme-color
  if (/<meta[^>]+name=["']theme-color["']/i.test(fieldHtml)) ok('theme-color meta present');
  else fail('theme-color meta missing');

  // viewport with viewport-fit
  if (/viewport-fit=cover/.test(fieldHtml)) ok('viewport viewport-fit=cover present');
  else fail('viewport viewport-fit=cover missing');

  // Surface bootstrap defaults to dark
  if (/data-surface/.test(fieldHtml) && /rwr\.surface-mode/.test(fieldHtml)) {
    ok('data-surface bootstrap script present');
  } else {
    fail('data-surface bootstrap script missing');
  }
}

// --- 3. dist/field-manifest.json --------------------------------------------
section('dist/field-manifest.json');
const distManifest = join(DIST, 'field-manifest.json');
if (!existsSync(distManifest)) {
  fail(`missing ${distManifest}`);
} else {
  ok('dist/field-manifest.json exists');
  try {
    const m = JSON.parse(readFileSync(distManifest, 'utf8'));
    const required = ['name', 'short_name', 'start_url', 'display', 'icons'];
    for (const k of required) {
      if (m[k] == null) fail(`manifest missing ${k}`);
    }
    if (m.display !== 'standalone') fail(`display must be "standalone" (got "${m.display}")`);
    else ok('display=standalone');
    if (!Array.isArray(m.icons) || m.icons.length === 0) fail('manifest has no icons');
    else ok(`${m.icons.length} icon entr${m.icons.length === 1 ? 'y' : 'ies'}`);
    if (m.start_url !== '/field.html') fail(`start_url mismatch: ${m.start_url}`);
    else ok('start_url=/field.html');
    if (m.theme_color && m.background_color) ok('theme_color + background_color set');
    else fail('theme_color/background_color missing');
  } catch (e) {
    fail(`manifest JSON parse failed: ${e.message}`);
  }
}

// --- 4. dist/field-sw.js -----------------------------------------------------
section('dist/field-sw.js');
const distSw = join(DIST, 'field-sw.js');
if (!existsSync(distSw)) {
  fail(`missing ${distSw}`);
} else {
  ok('dist/field-sw.js exists');
  const sw = readFileSync(distSw, 'utf8');
  if (/caches\.open\s*\(/.test(sw)) ok('service worker calls caches.open(...)');
  else fail('service worker does not call caches.open()');
  if (/addEventListener\(['"]fetch['"]/.test(sw)) ok("'fetch' listener registered");
  else fail("'fetch' event listener missing");
  if (/addEventListener\(['"]activate['"]/.test(sw)) ok("'activate' listener registered");
  else fail("'activate' event listener missing");
}

// --- 5. bundle introspection -------------------------------------------------
section('Bundle introspection');
const assetsDir = join(DIST, 'assets');
if (!existsSync(assetsDir)) {
  fail('dist/assets directory missing');
} else {
  const all = readdirSync(assetsDir).filter((n) => n.endsWith('.js'));
  ok(`scanned ${all.length} js bundles`);

  let bigBlob = '';
  for (const name of all) {
    try { bigBlob += readFileSync(join(assetsDir, name), 'utf8'); } catch { /* ignore */ }
  }

  // The minifier mangles local identifiers, but the browser API call sites
  // (`watchPosition`, `getCurrentPosition`) and the socket.io path
  // (`/socket.io/`) cannot be renamed. Their presence proves both modules
  // are bundled into the field entry.
  if (/watchPosition|getCurrentPosition/.test(bigBlob)) {
    ok('useGeolocation hook bundled (watchPosition/getCurrentPosition present)');
  } else {
    fail('useGeolocation hook not bundled — no geolocation API calls in dist/');
  }

  // The dedicated field-socket-*.js chunk is emitted whenever the symbol is
  // shared between FieldApp and FieldOpsPanel. Either the chunk file itself
  // or the inlined call to `io(...)` with `field.tech.moved` proves wiring.
  const hasFieldSocketChunk = all.some((n) => /^field-socket-/.test(n));
  if (hasFieldSocketChunk || /field\.tech\.moved/.test(bigBlob)) {
    ok('field-socket wiring bundled (chunk or topic literal present)');
  } else {
    fail('field-socket wiring not bundled');
  }

  // The field manifest path must be referenced from the field.html bundle.
  if (/field-manifest\.json/.test(fieldHtml + bigBlob)) ok('/field-manifest.json referenced in shipped artifacts');
  else fail('/field-manifest.json not referenced anywhere');
}

// --- 6. Source-level integrity (defence-in-depth) ---------------------------
section('Source integrity');
const srcEntry = resolve(ROOT, 'field.html');
if (existsSync(srcEntry)) {
  const src = readFileSync(srcEntry, 'utf8');
  if (/main-field\.tsx/.test(src)) ok('field.html mounts /src/crm/main-field.tsx');
  else fail('field.html does NOT reference main-field.tsx');
  if (/data-surface/.test(src)) ok('field.html sets data-surface attribute');
  else fail('field.html does NOT set data-surface');
} else {
  fail('mvp/field.html source missing');
}
// Vite serves files in public/ at the site root. The manifest + sw must live
// there so /field-manifest.json and /field-sw.js are reachable from field.html.
const srcManifest = resolve(ROOT, 'public', 'field-manifest.json');
if (existsSync(srcManifest)) ok('public/field-manifest.json present');
else fail('public/field-manifest.json missing');
const srcSw = resolve(ROOT, 'public', 'field-sw.js');
if (existsSync(srcSw)) ok('public/field-sw.js present');
else fail('public/field-sw.js missing');

const fieldAppPath = resolve(ROOT, 'src', 'crm', 'pages', 'FieldApp.tsx');
if (existsSync(fieldAppPath)) ok('FieldApp.tsx present');
else fail('FieldApp.tsx missing');

const tabs = ['JobsTab', 'MapTab', 'UploadTab', 'TimeTab', 'MeTab', 'JobSheet'];
for (const t of tabs) {
  const p = resolve(ROOT, 'src', 'crm', 'pages', 'field', `${t}.tsx`);
  if (existsSync(p)) ok(`${t}.tsx present`);
  else fail(`${t}.tsx missing`);
}

const opsPanel = resolve(ROOT, 'src', 'crm', 'components', 'field', 'FieldOpsPanel.tsx');
if (existsSync(opsPanel)) ok('FieldOpsPanel.tsx present');
else fail('FieldOpsPanel.tsx missing');

const techMarker = resolve(ROOT, 'src', 'crm', 'components', 'field', 'TechMarker.tsx');
if (existsSync(techMarker)) ok('TechMarker.tsx present');
else fail('TechMarker.tsx missing');

// vite.config.js must list field as an entry
const viteCfg = readFileSync(resolve(ROOT, 'vite.config.js'), 'utf8');
if (/field:\s*resolve\(__dirname,\s*['"]field\.html['"]\)/.test(viteCfg)) {
  ok('vite.config.js lists field entry');
} else {
  fail('vite.config.js missing field entry');
}

// auth-store routes field.technician → field.html
const authStore = readFileSync(resolve(ROOT, 'src', 'crm', 'lib', 'auth-store.ts'), 'utf8');
if (/field\.technician|field:technician/.test(authStore) && /field\.html/.test(authStore)) {
  ok('auth-store routes field.technician → field.html');
} else {
  fail('auth-store does NOT route field.technician → field.html');
}

// dashboard.html Field HUD
const dashHtml = readFileSync(resolve(ROOT, 'dashboard.html'), 'utf8');
if (/id="rwrFieldHud"/.test(dashHtml) && /rwrFieldHudBoot/.test(dashHtml)) {
  ok('dashboard.html Field HUD present');
} else {
  fail('dashboard.html Field HUD missing');
}

// =============================================================================
// Report
// =============================================================================
console.log(lines.join('\n'));
console.log('');
console.log(failures === 0 ? `RESULT: ok (${lines.length} checks)` : `RESULT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
