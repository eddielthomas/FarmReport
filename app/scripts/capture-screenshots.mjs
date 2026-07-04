/* =============================================================================
 * capture-screenshots.mjs
 * -----------------------------------------------------------------------------
 * Regenerates premium product screenshots for the marketing surface placeholders
 * declared via [data-screenshot="<slug>"] across the six marketing pages.
 *
 * REQUIREMENTS:
 *   - Playwright (NOT installed by default). Install once with:
 *       npm i -D playwright @playwright/test
 *       npx playwright install chromium
 *   - The dev server is running locally:
 *       npm run dev
 *     (default port 5275 — adjust BASE_URL via env if different)
 *   - For /dashboard.html captures the script currently does NOT supply a
 *     logged-in cookie. The Wave-1 contract is to capture against PUBLIC-FACING
 *     marketing pages only — dashboard captures will land on the gate. Wire a
 *     cookie injector here if/when authenticated captures are required.
 *
 * USAGE:
 *   node scripts/capture-screenshots.mjs
 *   BASE_URL=http://localhost:5275 node scripts/capture-screenshots.mjs
 *
 * OUTPUT:
 *   mvp/public/screenshots/<slug>.webp  (quality 88)
 *
 * EXIT CODES:
 *   0 — all targets captured
 *   1 — Playwright missing or a target failed
 * ============================================================================= */

import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:5275';
const OUT_DIR  = resolve(__dirname, '..', 'public', 'screenshots');
const QUALITY  = 88;

/** All data-screenshot slugs across the six marketing pages. */
const SCREENSHOT_TARGETS = [
  // index.html
  { slug: 'hero-dashboard',         url: `${BASE_URL}/dashboard.html#tenant=demoville-a`, selector: '#engineMount', viewport: { width: 1600, height: 900 } },
  { slug: 'mission-leak',           url: `${BASE_URL}/dashboard.html`,                     selector: '.viewport',    viewport: { width: 1600, height: 900 } },
  { slug: 'mission-recovery',       url: `${BASE_URL}/dashboard.html`,                     selector: '.viewport',    viewport: { width: 1600, height: 900 } },
  { slug: 'mission-risk',           url: `${BASE_URL}/dashboard.html`,                     selector: '.viewport',    viewport: { width: 1600, height: 900 } },

  // solutions.html
  { slug: 'solutions-overview',         url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-leak-detection',   url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-asset-recovery',   url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-infra-risk',       url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-physical-ai',      url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-integration',      url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'solutions-operations',       url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },

  // industries.html
  { slug: 'industries-overview',      url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-water',         url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-oil-gas',       url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-power',         url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-defense',       url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-insurance',     url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
  { slug: 'industries-asset-finance', url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },

  // platform.html
  { slug: 'platform-command-center',  url: `${BASE_URL}/dashboard.html`, selector: '.viewport', viewport: { width: 1600, height: 900 } },
];

/** Lazy-require Playwright so the script exits cleanly when it's not installed. */
async function loadPlaywright() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch (err) {
    console.error('[capture] Playwright is not installed.');
    console.error('[capture] Run:  npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

async function captureOne(browser, target) {
  const { slug, url, selector, viewport } = target;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const outPath = resolve(OUT_DIR, `${slug}.webp`);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

    let node = null;
    if (selector) {
      try {
        node = await page.waitForSelector(selector, { timeout: 8_000 });
      } catch {
        node = null;
      }
    }

    if (node) {
      await node.screenshot({ path: outPath, type: 'webp', quality: QUALITY });
    } else {
      await page.screenshot({ path: outPath, type: 'webp', quality: QUALITY, fullPage: false });
    }

    const info = await stat(outPath);
    console.log(`[capture] ${slug.padEnd(28)} → public/screenshots/${slug}.webp (${fmtKB(info.size)})`);
    return true;
  } catch (err) {
    console.error(`[capture] FAILED ${slug}: ${err.message}`);
    return false;
  } finally {
    await ctx.close();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromium = await loadPlaywright();

  console.log(`[capture] launching headless Chromium · ${SCREENSHOT_TARGETS.length} targets`);
  console.log(`[capture] base URL: ${BASE_URL}`);
  console.log(`[capture] output:   ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  let failures = 0;

  for (const target of SCREENSHOT_TARGETS) {
    const ok = await captureOne(browser, target);
    if (!ok) failures += 1;
  }

  await browser.close();

  if (failures) {
    console.error(`[capture] DONE — ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`[capture] DONE — ${SCREENSHOT_TARGETS.length} captured`);
}

main().catch((err) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});
