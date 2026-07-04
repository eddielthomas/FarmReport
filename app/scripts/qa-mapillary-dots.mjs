#!/usr/bin/env node
// Inspects the live engine to see if Mapillary capture-point dots actually
// render on the deck.gl scatter layer. Counts features, screenshots map.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const log = (...a) => console.log('[qa-dots]', ...a);
const BASE = 'http://127.0.0.1:5275';
const API  = 'http://127.0.0.1:5180';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`));

await page.goto(`${BASE}/access.html`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => sessionStorage.setItem('rwr_gate_ok', '1'));
const lj = await page.evaluate(async (api) => {
  const r = await fetch(`${api}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant_slug: 'demoville-a', email: 'admin@demoville-a.local' }) });
  return r.json();
}, API);
await page.evaluate(({ token, user }) => {
  localStorage.setItem('rwr.auth', JSON.stringify({ state: { token, user, tenant_slug: user.tenant_slug } }));
  localStorage.setItem('rwr.tenant', JSON.stringify({ state: { slug: user.tenant_slug, id: user.tenant_id } }));
}, lj.data);

await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.engineHost && !!window.host, null, { timeout: 30000 });

// Switch to satellite + fly to Cypress, TX (known Mapillary coverage)
await page.evaluate(() => window.host.setMode('satellite', { manual: true }));
await page.waitForTimeout(3500);
await page.evaluate(() => window.host.flyTo(29.97369, -95.68584, 15));
await page.waitForTimeout(3500);

// Toggle Mapillary on
await page.evaluate(() => document.querySelector('[data-lid="mapillary"]').click());
log('toggle clicked — waiting 12s for fetch + render');
await page.waitForTimeout(12000);

// Probe deck.gl internals to find the mapillary-coverage layer + its data length
const probe = await page.evaluate(() => {
  const out = {
    engineActive: window.engineHost?.getActive?.(),
    canvasCount: document.querySelectorAll('canvas').length,
    networkEntries: [],
    deckLayers: [],
    deckHookFound: false,
  };
  // Walk all known MapLibre containers and look for `__deck` reference.
  const containers = document.querySelectorAll('.maplibregl-map, .mapboxgl-map, #engineMount > *');
  for (const c of containers) {
    for (const key of Object.keys(c)) {
      if (key.startsWith('__reactProps')) continue;
    }
  }
  // Try the deck.gl Mapbox overlay path: maplibregl.Map has controls list
  // The deck.gl MapboxOverlay stores deck as overlay._deck.
  try {
    const inst = window.engineHost?._active ?? window.engineHost?.engines?.map2d;
    out.activeKeys = inst ? Object.keys(inst).slice(0, 30) : null;
    // common attach points
    const map = inst?.map || inst?._map;
    if (map) {
      out.hasMap = true;
      // MapboxOverlay added as a control — find it
      const controls = map._controls || map.__controls__ || [];
      out.controlCount = controls?.length ?? 0;
      for (const ctrl of (controls || [])) {
        const deck = ctrl?._deck || ctrl?.deck;
        if (deck) {
          out.deckHookFound = true;
          const layers = deck?.props?.layers ?? deck?.layerManager?.layers ?? [];
          out.deckLayers = (Array.isArray(layers) ? layers : []).map(L => ({
            id: L?.id ?? L?.props?.id ?? '?',
            visible: L?.props?.visible,
            dataLen: Array.isArray(L?.props?.data) ? L.props.data.length : (L?.props?.data?.features?.length ?? null),
          }));
        }
      }
    }
  } catch (e) {
    out.probeError = String(e?.message ?? e);
  }
  // Network: list recent Mapillary requests
  try {
    const entries = performance.getEntriesByType('resource')
      .filter(e => /graph\.mapillary\.com/.test(e.name))
      .slice(-5)
      .map(e => ({ name: e.name.slice(0, 140), status: e.responseStatus ?? '?', dur: Math.round(e.duration) }));
    out.networkEntries = entries;
  } catch (_) {}
  return out;
});

log('probe:', JSON.stringify(probe, null, 2));

// Screenshot just the viewport (map area)
await page.screenshot({ path: 'D:/Projects/RWR/mvp/.qa-dots.png', fullPage: false });
writeFileSync('D:/Projects/RWR/mvp/.qa-dots.log', consoleLines.join('\n'), 'utf8');
log('screenshot: mvp/.qa-dots.png');
log('console log: mvp/.qa-dots.log');

await browser.close();
process.exit(0);
