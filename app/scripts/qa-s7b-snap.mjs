#!/usr/bin/env node
// =============================================================================
// qa-s7b-snap.mjs — pixel-perfect verification harness for S7B (Sales)
// -----------------------------------------------------------------------------
// 1. Confirms `dist/sales.html` exists and references the bundled chunk.
// 2. If Puppeteer is installed (preferred) OR Playwright, opens both
//    surface modes at 1920×1080 and writes screenshots under
//    `mvp/.qa-s7b-snapshots/` for human eye-comparison vs. the concept boards.
// 3. Always emits a checklist mapping concept files → SalesManager view.
//
// Run:
//    node mvp/scripts/qa-s7b-snap.mjs            # asserts dist
//    PREVIEW_URL=http://localhost:5275 node mvp/scripts/qa-s7b-snap.mjs
//
// Never kills `node.exe`. Skips screenshot step if no headless lib is found.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SNAP_DIR = path.join(ROOT, '.qa-s7b-snapshots');
const PREVIEW = process.env.PREVIEW_URL ?? 'https://localhost:5275';

const CONCEPT_MAP = [
  ['1.webp',                                       'Overview Panel (desktop, full)'],
  ['a767d848b947a9e60c8ab02c352ef575.webp',       'Overview Panel (desktop tilt)'],
  ['7757b6619f6aaede2e0a1080e71aae3e.webp',       'Overview Panel (top-left close-up)'],
  ['8296929e03cffadd74e87bfdc89ddf70.webp',       'Overview Panel (overall tilt)'],
  ['556fd4773ad5a6015fb25a12b4efc491.webp',       'Overview Panel (right rail close-up · AI Assistant)'],
  ['89558a04a045fc6a9f40b56fa4de285f.webp',       'Overview Panel (AI assistant + bottom contacts close-up)'],
  ['8e9f74a65e5ae337b23c9d0b3254140e.webp',       'Overview Panel (top-nav close-up)'],
  ['e19357096efea8f522b3cd81e59187a2.webp',       'Overview Panel (mobile portrait, full)'],
  ['0aec6491bb0d639c6dfcc1e9a5ea3dd0.webp',       'Overview Panel (mobile, two screens)'],
  ['9b5694404b9a2cfd0a531f3237c2dcc3.webp',       'Overview Panel + AI rail (mobile 3 screens)'],
  ['200553e4ff0d6bb29ca5f79b92e82552.webp',       'Account Performance Trends (mobile)'],
  ['eff8ba4274882ee3939d81cd31c3d253.webp',       'AI Assistant (mobile, full + collapsed)'],
  ['c2ab68e8fe872f7c3cb2e663d53f9c4f.webp',       'AI Assistant (mobile tilt)'],
  ['a3f977b3b2f0d7d2764c8fbb8d892eac.webp',       'Account Performance Trends (alt mobile)'],
  ['2.webp',                                       'Analytics view — Income Statement (laptop frame)'],
  ['original-5f47dd47cb6c06a52cda1cf3d4c1d1f6.webp', 'Analytics view — Income Statement (close-up)'],
  ['original-6b903ffd3e40552e22dc2a143a9ce6ba.webp', 'Analytics view — Income Statement (tablet rig)'],
  ['original-9d6accbe2f26ac2fdfe38503775888c1.webp', 'Foundation — Urbanist + green/white/black tokens'],
];

const VIEW_MAP = [
  ['Overview Panel (desktop & mobile, all close-ups)',          'OverviewPanel.tsx via SalesManager.tsx (tab = overview)'],
  ['Account Performance Trends (mobile)',                       'PerformanceTrendsCard.tsx (embedded in OverviewPanel on small screens)'],
  ['Account Insights green frosted hero',                       'AccountInsightsHero.tsx → GlassPanel'],
  ['AI Assistant rail (desktop + mobile)',                      'AiAssistantChat.tsx → AiAssistantRail'],
  ['Income Statement (Analytics, Accounting concept)',          'IncomeStatementCard.tsx via SalesManager.tsx (tab = analytics)'],
  ['Lead pipeline cards / dark workspace',                      'WorkspaceView.tsx (toggle button in top nav, key shortcut "g w")'],
  ['Companies list with engagement arc',                        'CompaniesView.tsx (tab = companies)'],
  ['Documents grid',                                            'DocumentsView.tsx (tab = documents)'],
  ['Calculator (no concept image, on-brand placeholder)',       'CalculatorView.tsx (tab = calculator)'],
  ['Foundation tokens (Urbanist + green/black/white)',          'theme/tokens.css (already shipped in S7A)'],
];

// ---------------------------------------------------------------------------
// 1. Static assertions
// ---------------------------------------------------------------------------
function asserts() {
  const failures = [];
  const salesHtml = path.join(DIST, 'sales.html');
  if (!fs.existsSync(salesHtml)) {
    failures.push(`dist/sales.html missing — run npm run build first`);
    return failures;
  }
  const html = fs.readFileSync(salesHtml, 'utf8');
  const match = html.match(/\/assets\/sales-[A-Za-z0-9_-]+\.js/);
  if (!match) failures.push(`dist/sales.html does not reference a bundled sales-*.js chunk`);
  return failures;
}

// ---------------------------------------------------------------------------
// 2. Try headless screenshot capture (Puppeteer first, then Playwright)
// ---------------------------------------------------------------------------
async function tryScreenshots() {
  const states = [
    { name: 'overview-light',   tab: 'overview',   mode: 'light' },
    { name: 'overview-dark',    tab: 'overview',   mode: 'dark'  },
    { name: 'analytics-light',  tab: 'analytics',  mode: 'light' },
    { name: 'workspace',        tab: 'workspace',  mode: 'dark'  },
  ];

  let driver = null;
  try { driver = await loadDriver(); }
  catch (err) {
    return { taken: false, reason: `no headless driver available (${err.message})` };
  }

  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

  const { browser, newPage, close } = driver;
  const failures = [];
  for (const s of states) {
    try {
      const page = await newPage({ width: 1920, height: 1080 });
      const target = new URL('/sales.html', PREVIEW).toString();
      await page.goto(target, { waitUntil: 'networkidle', timeout: 30_000 });
      // Set surface mode by writing localStorage, then reload so head script reads it.
      await page.evaluate((mode) => {
        try { window.localStorage.setItem('rwr.surface-mode', JSON.stringify({ state: { mode }, version: 0 })); }
        catch {/* */}
      }, s.mode);
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      // Click the right tab inside SalesManager (best-effort, ignore failure).
      await page.evaluate((tab) => {
        const buttons = Array.from(document.querySelectorAll('[role="tab"], button'));
        const re = new RegExp(`^${tab}$`, 'i');
        const b = buttons.find((x) => re.test((x.textContent ?? '').trim()));
        if (b) (b).click();
      }, s.tab);
      // Settle.
      await new Promise((r) => setTimeout(r, 600));
      const out = path.join(SNAP_DIR, `${s.name}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`captured ${s.name} → ${out}`);
    } catch (err) {
      failures.push(`${s.name}: ${err.message}`);
    }
  }
  await close();
  return { taken: true, failures };
}

async function loadDriver() {
  // Puppeteer (preferred — simpler API surface)
  try {
    const pup = await import('puppeteer');
    const browser = await pup.default.launch({ headless: 'new' });
    return {
      browser,
      newPage: async ({ width, height }) => {
        const p = await browser.newPage();
        await p.setViewport({ width, height });
        return p;
      },
      close: () => browser.close(),
    };
  } catch { /* try playwright */ }
  try {
    const pw = await import('playwright');
    const browser = await pw.chromium.launch({ headless: true });
    return {
      browser,
      newPage: async ({ width, height }) => browser.newContext({ viewport: { width, height } }).then((c) => c.newPage()),
      close: () => browser.close(),
    };
  } catch { /* try puppeteer-core */ }
  try {
    const pc = await import('puppeteer-core');
    const exec = process.env.CHROME_PATH;
    if (!exec) throw new Error('CHROME_PATH unset');
    const browser = await pc.default.launch({ headless: 'new', executablePath: exec });
    return {
      browser,
      newPage: async ({ width, height }) => {
        const p = await browser.newPage();
        await p.setViewport({ width, height });
        return p;
      },
      close: () => browser.close(),
    };
  } catch (err) {
    throw new Error(`puppeteer / playwright / puppeteer-core all missing`);
  }
}

// ---------------------------------------------------------------------------
// 3. Run
// ---------------------------------------------------------------------------
const errs = asserts();
if (errs.length) {
  console.error('\n[FAIL] static asserts');
  errs.forEach((e) => console.error('   - ' + e));
} else {
  console.log('[OK] dist/sales.html references bundled sales-*.js');
}

console.log('\nConcept → View map:');
for (const [c, v] of CONCEPT_MAP) console.log(`   ${c.padEnd(58)} → ${v}`);

console.log('\nSurface coverage:');
for (const [c, v] of VIEW_MAP) console.log(`   ${c.padEnd(58)} → ${v}`);

const snap = await tryScreenshots();
if (snap.taken) {
  if (snap.failures.length) {
    console.log('\nScreenshots: completed with some failures:');
    snap.failures.forEach((f) => console.log('   - ' + f));
  } else {
    console.log(`\nScreenshots saved → ${SNAP_DIR}`);
  }
} else {
  console.log(`\nScreenshots: skipped (${snap.reason}).`);
  console.log(`Open ${PREVIEW}/sales.html and toggle the surface mode via the top-right Sun/Moon control to verify by eye.`);
}

process.exit(errs.length ? 1 : 0);
