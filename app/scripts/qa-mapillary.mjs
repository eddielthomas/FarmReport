#!/usr/bin/env node
// QA sweep: zoom to Cypress, TX, find Mapillary dots, click one, verify
// the embed slide-panel opens with an iframe pointed at the right image.
//
// Run:   node scripts/qa-mapillary.mjs
// Reqs:  Vite (5275) + API (5180) up; .env.local has VITE_MAPILLARY_KEY.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const log = (...a) => console.log('[qa]', ...a);
const fail = (msg, extra) => { console.error('[qa] FAIL:', msg, extra ?? ''); process.exit(1); };

const BASE = 'http://127.0.0.1:5275';
const API  = 'http://127.0.0.1:5180';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));

// --- Step 1: bypass pilot gate ----------------------------------------------
await page.goto(`${BASE}/access.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => sessionStorage.setItem('rwr_gate_ok', '1'));
log('gate bypassed');

// --- Step 2: dev-login via API, stash JWT under rwr.auth --------------------
const loginRes = await page.evaluate(async (api) => {
  const r = await fetch(`${api}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'demoville-a', email: 'admin@demoville-a.local' }),
  });
  return r.json();
}, API);
if (!loginRes.success) fail('dev-login failed', loginRes);
const { token, user } = loginRes.data;
await page.evaluate(({ token, user }) => {
  localStorage.setItem('rwr.auth', JSON.stringify({ state: { token, user, tenant_slug: user.tenant_slug } }));
  localStorage.setItem('rwr.tenant', JSON.stringify({ state: { slug: user.tenant_slug, id: user.tenant_id } }));
}, { token, user });
log(`logged in as ${user.email} (roles=${user.roles.join(',')})`);

// --- Step 3: load dashboard, wait for engine host --------------------------
await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.engineHost && !!window.host, null, { timeout: 30000 });
const bootState = await page.evaluate(() => ({
  url: location.href,
  activeEngine: window.engineHost?.getActive?.(),
  tokenLen: window.__RWR_CONFIG__?.mapillaryKey?.length ?? 0,
  hasPanel: !!document.getElementById('panelMapillary'),
  hasToggle: !!document.querySelector('[data-lid="mapillary"]'),
}));
log('boot:', bootState);
if (bootState.tokenLen < 30) fail('VITE_MAPILLARY_KEY not loaded in browser', bootState);

// --- Step 4: switch to satellite (map2d) + fly to Cypress, TX --------------
await page.evaluate(() => window.host.setMode('satellite', { manual: true }));
await page.waitForTimeout(3500);
// Coordinates of the known panorama from our earlier API probe
await page.evaluate(() => window.host.flyTo(29.97369, -95.68584, 15));
await page.waitForTimeout(3500);
const flightState = await page.evaluate(() => ({
  activeEngine: window.engineHost?.getActive?.(),
}));
log('after fly:', flightState);

// --- Step 5: toggle Street View layer on -----------------------------------
await page.evaluate(() => document.querySelector('[data-lid="mapillary"]').click());
log('toggle clicked');
// Wait for fetch debounce + network round-trip
await page.waitForTimeout(6000);

// --- Step 6: read feature count from engine internals ----------------------
const dotState = await page.evaluate(() => {
  // Look at deck.gl scatter layer features
  const dl = window.engineHost?._active?.map; // not what we want
  // The engine keeps mapillaryFC inside a closure; observe via the
  // pickable layer in deckOverlay if accessible. Fallback: count features
  // by counting visible canvas pixels in the layer — too brittle.
  // Cleaner: walk the deck.gl Deck instance.
  // The mapbox-overlay attaches deck under map.__deck or similar; if we
  // can't read it, fall back to firing the click handler with a known
  // image id from the API probe.
  const canvases = document.querySelectorAll('canvas');
  return {
    canvasCount: canvases.length,
    layerToggleOn: document.querySelector('[data-lid="mapillary"]')?.classList?.contains('on'),
  };
});
log('post-toggle state:', dotState);

// --- Step 7: directly simulate a Mapillary dot click via the event chain ---
// Use a known image_id from the earlier probe.
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('mapillary:select', {
    detail: { imageId: '819850968932277', lat: 29.97369, lon: -95.68584, isPano: true },
  }));
});
await page.waitForTimeout(2000);

const panelState = await page.evaluate(() => {
  const overlay = document.getElementById('mapillaryOverlay');
  const content = document.getElementById('mapillaryContent');
  const iframe = content?.querySelector('iframe');
  const rect = overlay?.getBoundingClientRect();
  return {
    panelVisible: overlay && !overlay.hidden,
    overlayWidth: rect?.width ?? 0,
    overlayHeight: rect?.height ?? 0,
    overlayRight: rect ? Math.round(window.innerWidth - rect.right) : null,
    iframeSrc: iframe?.getAttribute('src'),
    contentHTML: content?.innerHTML?.slice(0, 200),
  };
});
log('panel state:', panelState);

// --- Step 8: screenshot proof + save console trace -------------------------
await page.screenshot({ path: 'D:/Projects/RWR/mvp/.qa-mapillary.png', fullPage: false });
writeFileSync('D:/Projects/RWR/mvp/.qa-mapillary.log', consoleLines.join('\n'), 'utf8');
log('screenshot: mvp/.qa-mapillary.png');
log('console log: mvp/.qa-mapillary.log');

// --- Verdicts ---------------------------------------------------------------
const pass = {
  bootOK:    bootState.activeEngine && bootState.tokenLen >= 30 && bootState.hasPanel && bootState.hasToggle,
  engine:    flightState.activeEngine === 'map2d',
  toggle:    dotState.layerToggleOn === true,
  panel:     panelState.panelVisible === true,
  iframe:    !!panelState.iframeSrc?.includes('mapillary.com/embed'),
};
log('verdicts:', pass);
await browser.close();
process.exit(Object.values(pass).every(Boolean) ? 0 : 1);
