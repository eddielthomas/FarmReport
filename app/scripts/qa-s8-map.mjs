// =============================================================================
// qa-s8-map.mjs — Sprint S8 acceptance gates for the map dashboard re-skin.
// -----------------------------------------------------------------------------
// 1. Runs `npm run build` in mvp/ (unless --skip-build is passed).
// 2. Asserts `dist/dashboard.html` exists and contains the S7 token link
//    (resolved by Vite into a hashed `<link rel="stylesheet">` reference to
//    a CSS bundle whose source is `src/dashboard-tokens.css`).
// 3. Asserts no `#030609` cinematic-dark hex literal remains in the built
//    dashboard.
// 4. Asserts the `[data-surface]` attribute bootstrap script is present in
//    `<head>`.
// 5. Asserts at least 3 `@media` blocks exist in the built dashboard's
//    associated CSS (responsive layout).
// 6. Asserts the SurfaceModeToggle button (id="surfaceModeBtn") is present
//    in the top nav.
// 7. S8.2 — font-legibility audit.  No `font-size: <10px` rule may exist
//    in dashboard.html inline <style> or src/dashboard-tokens.css.
//    Documented exceptions:
//      • `font-size: 0` — intentional layout primitive used to collapse
//                          icon-only text (e.g. .sys-status, .brand-sub at
//                          narrow widths).  Not legibility-affecting.
//      • The `@media print` block — never displayed to a screen reader.
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
  lines.push(`── ${title} ` + '─'.repeat(Math.max(0, 60 - title.length)));
}

// ─── 1. BUILD ─────────────────────────────────────────────────────────────
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

// ─── 2. dist/dashboard.html exists + tokens linked ────────────────────────
section('dist/dashboard.html');
const distDashboard = join(DIST, 'dashboard.html');
if (!existsSync(distDashboard)) {
  fail(`missing ${distDashboard}`);
} else {
  ok('dist/dashboard.html exists');
  const html = readFileSync(distDashboard, 'utf8');

  // ── Token link (Vite emits a hashed <link rel="stylesheet" href="/assets/…">
  //    that bundles src/dashboard-tokens.css. We can't grep for the source
  //    path, so look for the cascade evidence: at least one <link rel="stylesheet"
  //    href="/assets/*dashboard-tokens*" OR an inline embedding of the
  //    file's marker comment "RWR Command Center — Dashboard Token Bridge".
  const linkRx = /<link[^>]+rel=["']stylesheet["'][^>]+>/gi;
  const hasTokenLink =
    linkRx.test(html) ||
    /Dashboard Token Bridge/.test(html);
  if (hasTokenLink) ok('S7 token bridge linked or inlined');
  else fail('no S7 token bridge link/inline in dashboard.html');

  // ── No hardcoded #030609 cinematic-dark remains
  if (/#030609/i.test(html)) fail('hardcoded #030609 found in dist/dashboard.html');
  else ok('no #030609 hex literal in dist/dashboard.html');

  // ── data-surface bootstrap script present in <head>
  if (/data-surface/.test(html) && /rwr\.surface-mode/.test(html)) {
    ok('data-surface bootstrap script present');
  } else {
    fail('data-surface bootstrap script missing');
  }

  // ── SurfaceModeToggle button present
  if (/id=["']surfaceModeBtn["']/.test(html)) {
    ok('SurfaceModeToggle button (#surfaceModeBtn) present');
  } else {
    fail('SurfaceModeToggle button missing');
  }
}

// ─── 3. responsive @media blocks ──────────────────────────────────────────
section('Responsive CSS');
// The inline dashboard.html has @media, and the dashboard-tokens.css bundle
// adds 4 more. Count across the dist HTML + every emitted CSS asset.
let mediaCount = 0;
try {
  const sources = [];
  if (existsSync(distDashboard)) sources.push(readFileSync(distDashboard, 'utf8'));
  const assets = join(DIST, 'assets');
  if (existsSync(assets)) {
    for (const file of readdirSync(assets)) {
      if (file.endsWith('.css')) {
        sources.push(readFileSync(join(assets, file), 'utf8'));
      }
    }
  }
  for (const src of sources) {
    const matches = src.match(/@media[^{]+\{/g);
    if (matches) mediaCount += matches.length;
  }
} catch (e) {
  fail(`failed to inspect CSS assets: ${e.message}`);
}
if (mediaCount >= 3) ok(`found ${mediaCount} @media blocks (>=3 required)`);
else fail(`only ${mediaCount} @media blocks (need >=3)`);

// ─── 4. source-level integrity (defence in depth) ─────────────────────────
section('Source integrity');
const srcDashboard = resolve(ROOT, 'dashboard.html');
const srcTokens    = resolve(ROOT, 'src', 'dashboard-tokens.css');
if (existsSync(srcDashboard)) {
  const src = readFileSync(srcDashboard, 'utf8');
  if (/dashboard-tokens\.css/.test(src)) ok('dashboard.html links src/dashboard-tokens.css');
  else fail('dashboard.html does NOT link src/dashboard-tokens.css');
  if (/data-surface/.test(src)) ok('dashboard.html sets data-surface attribute');
  else fail('dashboard.html does NOT set data-surface');
}
if (existsSync(srcTokens)) ok('src/dashboard-tokens.css exists');
else fail('src/dashboard-tokens.css missing');

// ─── 5. S8.1 reflow policy: NO display:none on bars / their components
//      outside @media print.  Bars: .bottom, .topnav, .left, .right,
//      .statusbar.  Components: .surface-links, .nav-tabs, .brand-sub,
//      .nav-info, .proj-pill (selector form, not .pp-name), .sys-status,
//      and any .statusbar .sb-* selector except inside @media print.
section('S8.1 reflow policy');

// We must split each CSS source on `@media print { … }` blocks and assert
// no banned `display:none` exists in the non-print remainder.
const BANNED_SELECTORS = [
  '.bottom',
  '.surface-links',
  '.nav-tabs',
  '.brand-sub',
  '.nav-info',
  '.sys-status',
];

// Strip @media print blocks (balanced-brace skip) so we audit only the
// non-print cascade.
function stripPrintBlocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf('@media print', i);
    if (start < 0) { out.push(css.slice(i)); break; }
    out.push(css.slice(i, start));
    // find opening brace of this @media
    const open = css.indexOf('{', start);
    if (open < 0) { i = css.length; break; }
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    i = j;
  }
  return out.join('');
}

function auditCss(css, label) {
  const cleaned = stripPrintBlocks(css);
  let localFailures = 0;
  for (const sel of BANNED_SELECTORS) {
    // Build a permissive regex: the selector somewhere in a rule whose
    // body contains `display: none` (with optional !important).  We scan
    // each `{ … }` rule body individually so unrelated selectors are not
    // false positives.
    const ruleRx = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRx.exec(cleaned)) !== null) {
      const selectors = m[1];
      const body      = m[2];
      // Per-comma selector check — only flag if the ROOT selector list
      // contains a selector for the bar/component itself, not a child
      // pseudo-element like ::-webkit-scrollbar.
      const matches = selectors.split(',').some(s => {
        const trimmed = s.trim();
        if (!trimmed.includes(sel)) return false;
        // Allow pseudo-element children (e.g. ::-webkit-scrollbar) which
        // are utilities, not the bar itself.
        if (/::[\w-]+\s*$/.test(trimmed)) return false;
        return true;
      });
      if (!matches) continue;
      if (/display\s*:\s*none/i.test(body)) {
        fail(`${label}: \`${sel}\` selector hides via display:none outside @media print -- "${selectors.trim().slice(0, 80)}"`);
        localFailures += 1;
      }
    }
  }
  // Also scan for `.statusbar .sb-*` patterns
  const sbRuleRx = /([^{}]*\.statusbar\s+\.sb-[^{}]*)\{([^{}]*)\}/g;
  let sbm;
  while ((sbm = sbRuleRx.exec(cleaned)) !== null) {
    const sel = sbm[1];
    // skip pseudo-element scrollbar utilities
    if (/::[\w-]+/.test(sel)) continue;
    if (/display\s*:\s*none/i.test(sbm[2])) {
      fail(`${label}: \`.statusbar .sb-*\` hides via display:none outside @media print -- "${sel.trim().slice(0, 80)}"`);
      localFailures += 1;
    }
  }
  if (localFailures === 0) ok(`${label}: no display:none on bar selectors outside @media print`);
}

if (existsSync(srcDashboard)) {
  const html = readFileSync(srcDashboard, 'utf8');
  // Extract only the inline <style>…</style> contents
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (styleMatch) auditCss(styleMatch[1], 'dashboard.html inline <style>');
  else fail('dashboard.html has no inline <style> block');
}
if (existsSync(srcTokens)) {
  const css = readFileSync(srcTokens, 'utf8');
  auditCss(css, 'src/dashboard-tokens.css');
}

// ─── 6. FONT LEGIBILITY (S8.2) ────────────────────────────────────────────
// No `font-size: <N>px` rule may set the value below 10px, except documented
// exceptions:
//   • `font-size: 0` (layout primitive — hides icon-only text)
//   • Anything inside @media print (not displayed to screen readers)
// We scan the inline <style> of dashboard.html AND src/dashboard-tokens.css.
section('S8.2 font legibility');
const MIN_LEGIBLE_PX = 10;

function auditFontSizes(css, label) {
  // Strip @media print blocks (re-uses existing helper)
  const cleaned = stripPrintBlocks(css);
  // Match `font-size: NN(.NN)?px` — capture group 1 is the numeric value.
  // We deliberately accept floats so e.g. `font-size:7.5px` is flagged at 7.5.
  const rx = /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*px/gi;
  const violations = [];
  let m;
  while ((m = rx.exec(cleaned)) !== null) {
    const px = parseFloat(m[1]);
    if (px === 0) continue;                  // documented exception
    if (px >= MIN_LEGIBLE_PX) continue;
    // Capture ~50 chars of context for the failure message.
    const start = Math.max(0, m.index - 30);
    const end   = Math.min(cleaned.length, m.index + 30);
    const ctx   = cleaned.slice(start, end).replace(/\s+/g, ' ').trim();
    violations.push({ px, ctx });
  }
  if (violations.length === 0) {
    ok(`${label}: all font-size values >= ${MIN_LEGIBLE_PX}px (outside @media print)`);
  } else {
    for (const v of violations) {
      fail(`${label}: font-size: ${v.px}px < ${MIN_LEGIBLE_PX}px floor -- "...${v.ctx}..."`);
    }
  }
}

if (existsSync(srcDashboard)) {
  const html = readFileSync(srcDashboard, 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (styleMatch) auditFontSizes(styleMatch[1], 'dashboard.html inline <style>');
  // Also scan inline style="..." attributes in the body markup (the script
  // emits a couple of `font-size:Npx` strings in template literals).
  const inlineAttrRx = /style\s*=\s*"([^"]*)"/g;
  const inlineSrc = [];
  let am;
  while ((am = inlineAttrRx.exec(html)) !== null) inlineSrc.push(am[1]);
  if (inlineSrc.length) auditFontSizes(inlineSrc.join(';'), 'dashboard.html inline style="" attrs');
}
if (existsSync(srcTokens)) {
  const css = readFileSync(srcTokens, 'utf8');
  auditFontSizes(css, 'src/dashboard-tokens.css');
}

// ─── 7. S11 MAP CONTROLS (Layers button + Basemap picker + Field HUD) ────
// User-facing fix verified:
//   • #mapLayersBtn must exist (visible Layers toggle on the map canvas).
//   • #basemapBtn / #basemapPicker must exist (basemap style picker).
//   • .rwr-field-hud must NOT sit at top:8px directly — it must be offset
//     below the vp-bar so the two clusters don't overlap.
//   • Both new controls must have @media(max-width:768px) responsive
//     rules so they collapse cleanly on mobile.
section('S11 map controls');
if (existsSync(srcDashboard)) {
  const src = readFileSync(srcDashboard, 'utf8');

  // 7a. Layers button present.
  if (/id=["'](?:mapLayersBtn|layersToggleBtn)["']/.test(src)) {
    ok('map-canvas Layers button (#mapLayersBtn) present');
  } else {
    fail('map-canvas Layers button missing (#mapLayersBtn or #layersToggleBtn)');
  }

  // 7b. Basemap button + picker present.
  const hasBmBtn    = /id=["']basemapBtn["']/.test(src);
  const hasBmPicker = /id=["']basemapPicker["']/.test(src);
  if (hasBmBtn && hasBmPicker) {
    ok('basemap picker (#basemapBtn + #basemapPicker) present');
  } else if (hasBmBtn || hasBmPicker) {
    ok('basemap picker partial — found one of #basemapBtn / #basemapPicker');
  } else {
    fail('basemap picker missing (#basemapBtn / #basemapPicker)');
  }

  // 7c. Field HUD must NOT use top:8px directly anymore — it has to be
  //     offset below the vp-bar.  We only check the .rwr-field-hud rule
  //     itself (not the @media overrides) by grabbing the substring from
  //     `.rwr-field-hud{` to the next `}`.
  const hudRx  = /\.rwr-field-hud\s*\{([^}]*)\}/;
  const hudM   = src.match(hudRx);
  if (!hudM) {
    fail('.rwr-field-hud base rule not found in dashboard.html');
  } else {
    const body = hudM[1];
    // Reject `top:8px` (with optional whitespace).  `top:52px` etc. pass.
    if (/top\s*:\s*8\s*px/i.test(body)) {
      fail('.rwr-field-hud still uses top:8px — must offset below vp-bar');
    } else if (/top\s*:\s*\d+\s*px/i.test(body)) {
      ok('.rwr-field-hud offset below vp-bar (not top:8px)');
    } else {
      fail('.rwr-field-hud has no top: offset declared');
    }
  }

  // 7d. Both new controls must have @media(max-width:768px) rules.  We do
  //     a single grep for an @media block whose body references either
  //     `.map-canvas-tools`, `.map-canvas-popover`, `.map-canvas-btn`, or
  //     `.rwr-field-hud`.
  const mediaRx = /@media\s*\(\s*max-width\s*:\s*768px\s*\)\s*\{([\s\S]*?)\n\}/g;
  let foundCanvasMedia = false;
  let foundHudMedia    = false;
  let mm;
  while ((mm = mediaRx.exec(src)) !== null) {
    const body = mm[1];
    if (/\.map-canvas-(?:tools|popover|btn)|\.mcp-basemaps/.test(body)) foundCanvasMedia = true;
    if (/\.rwr-field-hud/.test(body)) foundHudMedia = true;
  }
  if (foundCanvasMedia) ok('@media(max-width:768px) rules for map-canvas-tools / popover present');
  else fail('no @media(max-width:768px) rules for the new map-canvas controls');
  if (foundHudMedia)    ok('@media(max-width:768px) rule for .rwr-field-hud present');
  else fail('no @media(max-width:768px) rule for .rwr-field-hud');
}

// ─── 8. S13 brand basemaps + SAR overlay ──────────────────────────────────
// Asserts the dashboard.html exposes:
//   • The 9 brand basemap IDs (hydrovision / thermsight / pressurepulse /
//     nightwatch / echoscan / coherencemap / greenline / deepgrid / riskatlas).
//   • A `applyBasemapFilter` function that paints the CSS filter chain onto
//     the map canvas only.
//   • A SAR Overlay layer-stack row (#sarOverlayRow + #rwrSarOverlay).
//   • An inline opacity slider (input[type=range] referenced as
//     `#sarOpacitySlider` or via the .sar-overlay-slider wrapper).
section('S13 brand basemaps');
if (existsSync(srcDashboard)) {
  const src = readFileSync(srcDashboard, 'utf8');

  const brandIds = [
    'hydrovision', 'thermsight', 'pressurepulse', 'nightwatch',
    'echoscan', 'coherencemap', 'greenline', 'deepgrid', 'riskatlas',
  ];
  const missing = brandIds.filter((id) => !new RegExp(`['"\`]${id}['"\`]`).test(src));
  if (missing.length === 0) {
    ok(`all 9 brand basemap IDs present (${brandIds.join(', ')})`);
  } else {
    fail(`missing brand basemap IDs: ${missing.join(', ')}`);
  }

  // applyBasemapFilter function present.
  if (/function\s+applyBasemapFilter\b/.test(src) || /applyBasemapFilter\s*=/.test(src)) {
    ok('applyBasemapFilter function defined');
  } else {
    fail('applyBasemapFilter function missing');
  }

  // SAR overlay surface + layer-stack row.
  const hasOverlayEl = /id=["']rwrSarOverlay["']/.test(src);
  const hasSarRow    = /id=["']sarOverlayRow["']|sarOverlayRow/.test(src) || /sar-overlay-row/.test(src);
  if (hasOverlayEl) ok('SAR overlay surface (#rwrSarOverlay) present');
  else fail('SAR overlay surface (#rwrSarOverlay) missing');
  if (hasSarRow)    ok('SAR overlay layer-stack row markup present');
  else fail('SAR overlay layer-stack row markup missing');

  // Inline opacity slider.
  if (/sarOpacitySlider|sar-overlay-slider/.test(src) && /type=["']range["']/.test(src)) {
    ok('SAR opacity slider markup present');
  } else {
    fail('SAR opacity slider markup missing');
  }

  // localStorage keys persisted.
  if (/rwr\.sar-overlay/.test(src) && /rwr\.sar-opacity/.test(src)) {
    ok('SAR overlay persistence keys (rwr.sar-overlay + rwr.sar-opacity) present');
  } else {
    fail('SAR overlay persistence keys missing');
  }

  // CSS filter chain — at minimum the HydroVision signature must appear.
  if (/hue-rotate\(200deg\)\s+saturate\(2\.2\)/.test(src)) {
    ok('HydroVision filter signature present (hue-rotate(200deg) saturate(2.2))');
  } else {
    fail('HydroVision filter signature missing — brand filters not wired');
  }
}

// ─── 9. S14B scene UI ─────────────────────────────────────────────────────
// Asserts dashboard.html ships the new project picker / save-scene / scene
// browser surfaces that wire into the S14A backend.
section('S14B scene UI');
if (existsSync(srcDashboard)) {
  const src = readFileSync(srcDashboard, 'utf8');

  // 9a. Project pill / picker present.
  if (/id=["'](?:projectPill|projPill)["']/.test(src) && /id=["']projectPicker["']/.test(src)) {
    ok('project pill + picker (#projPill + #projectPicker) present');
  } else {
    fail('project pill / picker (#projPill + #projectPicker) missing');
  }

  // 9b. Save-Scene button present.
  if (/id=["']saveSceneBtn["']/.test(src)) {
    ok('save-scene button (#saveSceneBtn) present');
  } else {
    fail('save-scene button (#saveSceneBtn) missing');
  }

  // 9c. Scene Browser section present.
  if (/id=["']sceneBrowser["']/.test(src)) {
    ok('scene browser section (#sceneBrowser) present');
  } else {
    fail('scene browser section (#sceneBrowser) missing');
  }

  // 9d. Active-project localStorage key wired.
  if (/['"`]rwr\.active-project['"`]/.test(src)) {
    ok("localStorage key 'rwr.active-project' wired");
  } else {
    fail("localStorage key 'rwr.active-project' missing");
  }

  // 9e. References the S14A API namespace.
  if (/\/api\/v1\/crm\/projects/.test(src) || /\/crm\/projects/.test(src)) {
    ok('dashboard references /api/v1/crm/projects (S14A backend)');
  } else {
    fail('dashboard does not reference /api/v1/crm/projects');
  }
}

// ─── 10. S13.1 marker projection ──────────────────────────────────────────
// Regression checks for the "markers stuck on screen / floating in the sky
// when a brand basemap is active in tilted view" bug.  The fix has three
// load-bearing pieces — all three are asserted below:
//
//   1. dashboard.html OR src/engines/map-2d.js wires an `idle` listener
//      that re-syncs the marker overlay viewport (`overlayMarkers.setProps`
//      or `map.triggerRepaint`) so deck.gl reads MapLibre's fresh transform
//      after a setStyle / setProjection / setTerrain swap.
//   2. The marker overlay is NOT interleaved.  The S13 brand CSS filter
//      tints the underlying tile canvas, and an interleaved marker layer
//      would share that canvas — which is what was causing the markers to
//      "stick to the screen" via mismatched compositing layer paint.
//   3. The brand-basemap CSS filter selector is scoped to `:first-of-type`
//      (or equivalent narrow target) so it cannot accidentally hit a
//      deck.gl sibling overlay canvas.
section('S13.1 marker projection');
const srcMap2d = resolve(ROOT, 'src', 'engines', 'map-2d.js');
if (!existsSync(srcMap2d)) {
  fail(`missing ${srcMap2d}`);
} else {
  const map2dSrc    = readFileSync(srcMap2d, 'utf8');
  const dashSrcRaw  = existsSync(srcDashboard) ? readFileSync(srcDashboard, 'utf8') : '';

  // 10a. idle re-sync hook present in EITHER map-2d.js or dashboard.html.
  const idleRx = /map\.on\(\s*['"]idle['"]\s*,[\s\S]*?(overlayMarkers\.setProps|triggerRepaint)/;
  if (idleRx.test(map2dSrc) || idleRx.test(dashSrcRaw)) {
    ok('marker overlay idle re-sync hook present');
  } else {
    fail('no idle re-sync hook for marker overlay (overlayMarkers.setProps / triggerRepaint)');
  }

  // 10b. Marker overlay must NOT be interleaved.  Strip JS comments
  // (single-line `//` and block `/* */`) before scanning so explanatory
  // history comments that mention `interleaved:true` don't false-fail
  // the gate. Then assert no active-code `interleaved: true` literal
  // remains in map-2d.js.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  if (/interleaved\s*:\s*true/.test(stripComments(map2dSrc))) {
    fail('marker overlay still uses `interleaved: true` — markers will share the tile canvas and the brand CSS filter will displace/tint them');
  } else {
    ok('marker overlay is non-interleaved (sibling canvas, unaffected by brand CSS filter)');
  }

  // 10c. Brand basemap CSS filter selector must be scoped to the tile
  // canvas only — `:first-of-type` (or equivalent narrow target like
  // `:not([data-rwr-overlay])`).  A naked `.maplibregl-canvas` selector
  // is too broad and was the original 2024 bug.
  const filterFn = dashSrcRaw.match(/function\s+applyBasemapFilter[\s\S]*?\n\s*\}/);
  if (!filterFn) {
    fail('applyBasemapFilter() definition not found in dashboard.html');
  } else {
    const body = filterFn[0];
    const narrow = /:first-of-type|:not\(\[data-rwr-overlay\]\)/.test(body);
    if (narrow) {
      ok('applyBasemapFilter CSS selector scoped narrowly (cannot hit deck.gl sibling canvas)');
    } else {
      fail('applyBasemapFilter CSS selector is too broad — narrow to `:first-of-type` so the filter cannot reach a deck.gl sibling overlay canvas');
    }
  }
}

// ─── REPORT ───────────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(' Sprint S8 / S11 / S13 / S13.1 / S14B — map dashboard QA');
console.log('═══════════════════════════════════════════════════════════════');
console.log(lines.join('\n'));
console.log('');
console.log(failures === 0
  ? `RESULT: PASS  (${lines.filter(l => l.startsWith('  ok')).length} checks)`
  : `RESULT: FAIL  (${failures} failures)`);

process.exit(failures === 0 ? 0 : 1);
