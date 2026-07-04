// =============================================================================
// viewport-tools.js
// Wires the Select / Measure / Draw AOI / Screenshot tools in the viewport bar.
// Single-tool-active state — clicking another tool deactivates the previous.
// =============================================================================

import { qaToast } from './quick-actions.js';

const STYLE_ID = 'rwr-vt-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .vt-overlay-root{position:absolute;inset:0;pointer-events:none;z-index:40;}
    .vt-measure{position:absolute;background:linear-gradient(180deg,var(--bg2),var(--bg1));
      border:1px solid var(--cyan);color:var(--t1);padding:4px 8px;border-radius:3px;
      font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.5px;
      transform:translate(8px,-50%);pointer-events:none;white-space:nowrap;
      box-shadow:0 4px 14px rgba(0,212,255,.25);}
    .vt-measure .vt-measure-sub{display:block;font-size:8px;color:var(--t3);margin-top:2px;font-weight:600;letter-spacing:1px;text-transform:uppercase;}
    .vt-pin{position:absolute;width:10px;height:10px;border-radius:50%;background:var(--cyan);
      border:2px solid var(--bg);transform:translate(-50%,-50%);box-shadow:0 0 12px var(--cyan);pointer-events:none;}
    .vt-aoi-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;}
    .vt-aoi-svg polygon{fill:rgba(0,212,255,.12);stroke:var(--cyan);stroke-width:1.5;stroke-dasharray:4 3;}
    .vt-aoi-svg .vt-aoi-vertex{fill:var(--cyan);stroke:var(--bg);stroke-width:1.5;}
    .vt-aoi-svg .vt-aoi-line{stroke:var(--cyan);stroke-width:1.5;stroke-dasharray:4 3;fill:none;}
    .vt-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:9000;
      transition:opacity .08s ease-out;}
    .vt-flash.on{opacity:.85;transition:opacity .25s ease-in;}
    .viewport.vt-cursor-cross{cursor:crosshair !important;}
    .vp-tool.vt-active{background:var(--cyan) !important;color:var(--bg) !important;}
  `;
  document.head.appendChild(s);
}

/* --------- geometry helpers --------- */
function haversineKm(a, b) {
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function fmtDistance(km) {
  if (km < 1) return `${(km * 1000).toFixed(1)} m`;
  if (km < 100) return `${km.toFixed(3)} km`;
  return `${km.toFixed(1)} km`;
}

/* --------- canvas / viewport resolution --------- */
function resolveCanvas(host) {
  if (host && typeof host.getCanvas === 'function') {
    try { const c = host.getCanvas(); if (c) return c; } catch { /* noop */ }
  }
  return document.getElementById('gc');
}
function resolveViewport() {
  return document.getElementById('viewport') || document.body;
}

/* --------- screen -> latlon --------- */
function screenToLatLon(host, x, y) {
  if (host && typeof host.screenToLatLon === 'function') {
    try {
      const r = host.screenToLatLon(x, y);
      if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) return r;
    } catch { /* noop */ }
  }
  // Fallback: estimate from viewport rect using a coarse degrees-per-pixel guess
  const cv = resolveCanvas(host);
  const rect = (cv || document.body).getBoundingClientRect();
  const cx = rect.width / 2, cy = rect.height / 2;
  let center = { lat: 30, lon: -95.7 };
  if (host && typeof host.getCamera === 'function') {
    try {
      const cam = host.getCamera();
      if (cam && Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) center = cam;
    } catch { /* noop */ }
  }
  // Rough 0.0006 deg/px at zoom 12; doesn't have to be perfect, this is a fallback
  const dPerPx = 0.0006;
  return {
    lat: center.lat - (y - cy) * dPerPx,
    lon: center.lon + (x - cx) * dPerPx,
  };
}

/* --------- overlay root (lazy on viewport) --------- */
function ensureOverlayRoot() {
  const vp = resolveViewport();
  let root = vp.querySelector(':scope > .vt-overlay-root');
  if (!root) {
    root = document.createElement('div');
    root.className = 'vt-overlay-root';
    vp.appendChild(root);
  }
  return root;
}

/* --------- single-tool state --------- */
function makeToolState() {
  let cleanupActive = null;
  let activeBtn = null;
  function deactivate() {
    if (cleanupActive) { try { cleanupActive(); } catch { /* noop */ } }
    cleanupActive = null;
    if (activeBtn) activeBtn.classList.remove('a', 'vt-active');
    activeBtn = null;
    resolveViewport().classList.remove('vt-cursor-cross');
  }
  function activate(btn, cleanup, { cursorCross = true } = {}) {
    deactivate();
    activeBtn = btn;
    if (btn) btn.classList.add('a', 'vt-active');
    if (cursorCross) resolveViewport().classList.add('vt-cursor-cross');
    cleanupActive = cleanup;
  }
  return { activate, deactivate, getActiveBtn: () => activeBtn };
}

/* --------- SELECT --------- */
function makeSelect({ host, btn }) {
  const cv = resolveCanvas(host);
  if (!cv) return () => {};
  const onClick = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ds = (typeof host.getDS === 'function') ? host.getDS() : (window.DS || null);
    let nearest = null, nd = Infinity;
    const detections = ds?.detections || [];
    for (const d of detections) {
      // Project via host if possible
      let pt = null;
      if (host && typeof host.latLonToScreen === 'function') {
        try { pt = host.latLonToScreen(d.lat, d.lon); } catch { pt = null; }
      }
      if (!pt) {
        // Fallback: use marker-layer DOM if present (markers are positioned absolutely)
        const m = document.querySelector(`.marker-layer [data-id="${d.id}"]`);
        if (m) {
          const r = m.getBoundingClientRect();
          pt = { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
        }
      }
      if (!pt) continue;
      const dx = pt.x - x, dy = pt.y - y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < nd && dist <= 30) { nd = dist; nearest = d; }
    }
    if (!nearest) return;
    if (typeof window.flyToDetection === 'function') {
      window.flyToDetection(nearest);
    } else {
      window.dispatchEvent(new CustomEvent('detection:select', { detail: nearest }));
    }
  };
  cv.addEventListener('click', onClick);
  return () => cv.removeEventListener('click', onClick);
}

/* --------- MEASURE --------- */
function makeMeasure({ host }) {
  const cv = resolveCanvas(host);
  if (!cv) return () => {};
  const root = ensureOverlayRoot();
  let pinA = null, pinB = null, label = null;
  let aLatLon = null;

  const onClick = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (!pinA) {
      pinA = document.createElement('div');
      pinA.className = 'vt-pin';
      pinA.style.left = x + 'px';
      pinA.style.top  = y + 'px';
      root.appendChild(pinA);
      aLatLon = screenToLatLon(host, x, y);
    } else {
      pinB?.remove(); label?.remove();
      pinB = document.createElement('div');
      pinB.className = 'vt-pin';
      pinB.style.left = x + 'px';
      pinB.style.top  = y + 'px';
      root.appendChild(pinB);
      const bLatLon = screenToLatLon(host, x, y);
      const km = haversineKm(aLatLon, bLatLon);
      label = document.createElement('div');
      label.className = 'vt-measure';
      label.style.left = x + 'px';
      label.style.top  = y + 'px';
      label.innerHTML = `${fmtDistance(km)}<span class="vt-measure-sub">A→B great-circle</span>`;
      root.appendChild(label);
      // Reset for the next pair
      pinA = null;
    }
  };
  const onContext = (e) => {
    e.preventDefault();
    pinA?.remove(); pinB?.remove(); label?.remove();
    pinA = pinB = label = null; aLatLon = null;
  };
  cv.addEventListener('click', onClick);
  cv.addEventListener('contextmenu', onContext);
  return () => {
    cv.removeEventListener('click', onClick);
    cv.removeEventListener('contextmenu', onContext);
    pinA?.remove(); pinB?.remove(); label?.remove();
  };
}

/* --------- DRAW AOI --------- */
function makeDraw({ host }) {
  const cv = resolveCanvas(host);
  if (!cv) return () => {};
  const root = ensureOverlayRoot();
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'vt-aoi-svg');
  root.appendChild(svg);

  const points = []; // [{x,y,lat,lon}]
  const poly = document.createElementNS(svgNS, 'polyline');
  poly.setAttribute('class', 'vt-aoi-line');
  svg.appendChild(poly);

  const redraw = () => {
    poly.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
    [...svg.querySelectorAll('.vt-aoi-vertex')].forEach((n) => n.remove());
    for (const p of points) {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('class', 'vt-aoi-vertex');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', 3.5);
      svg.appendChild(c);
    }
  };

  const close = () => {
    if (points.length < 3) {
      qaToast('AOI needs at least 3 vertices');
      return;
    }
    // Replace polyline with closed polygon for visual feedback
    const polygon = document.createElementNS(svgNS, 'polygon');
    polygon.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
    svg.appendChild(polygon);
    poly.remove();
    const coords = points.map((p) => [p.lon, p.lat]);
    window.dispatchEvent(new CustomEvent('aoi:created', { detail: { coords } }));
    qaToast(`AOI captured · ${points.length} vertices`);
  };

  const onClick = (e) => {
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ll = screenToLatLon(host, x, y);
    points.push({ x, y, lat: ll.lat, lon: ll.lon });
    redraw();
  };
  const onDbl = (e) => { e.preventDefault(); close(); };
  const onKey = (e) => { if (e.key === 'Enter') close(); };

  cv.addEventListener('click', onClick);
  cv.addEventListener('dblclick', onDbl);
  window.addEventListener('keydown', onKey);

  return () => {
    cv.removeEventListener('click', onClick);
    cv.removeEventListener('dblclick', onDbl);
    window.removeEventListener('keydown', onKey);
    svg.remove();
  };
}

/* --------- SCREENSHOT (one-shot) --------- */
function doScreenshot({ host }) {
  const cv = resolveCanvas(host);
  if (!cv) { qaToast('No active canvas to capture'); return; }
  // Flash white feedback
  const vp = resolveViewport();
  const flash = document.createElement('div');
  flash.className = 'vt-flash';
  vp.appendChild(flash);
  // Force reflow then turn on for transition
  // eslint-disable-next-line no-unused-expressions
  flash.offsetWidth;
  flash.classList.add('on');
  setTimeout(() => {
    flash.classList.remove('on');
    setTimeout(() => flash.remove(), 280);
  }, 90);

  try {
    cv.toBlob((blob) => {
      if (!blob) { qaToast('Capture failed (canvas tainted?)'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `rwr-mvp-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  } catch (err) {
    console.warn('[viewport-tools] screenshot failed', err);
    qaToast('Capture failed');
  }
}

/* --------- mount --------- */
export function mountViewportTools({ host }) {
  injectStyles();
  ensureOverlayRoot();
  const state = makeToolState();
  const btnSelect  = document.getElementById('toolSelect');
  const btnMeasure = document.getElementById('toolMeasure');
  const btnDraw    = document.getElementById('toolDraw');
  const btnCapture = document.getElementById('toolCapture');

  const selectHandler = () => {
    if (state.getActiveBtn() === btnSelect) { state.deactivate(); return; }
    state.activate(btnSelect, makeSelect({ host, btn: btnSelect }), { cursorCross: false });
  };
  const measureHandler = () => {
    if (state.getActiveBtn() === btnMeasure) { state.deactivate(); return; }
    state.activate(btnMeasure, makeMeasure({ host }));
    qaToast('Measure: click A then B · right-click clears');
  };
  const drawHandler = () => {
    if (state.getActiveBtn() === btnDraw) { state.deactivate(); return; }
    state.activate(btnDraw, makeDraw({ host }));
    qaToast('Draw AOI: click vertices · double-click or Enter to close');
  };
  const captureHandler = () => doScreenshot({ host });

  btnSelect  && btnSelect .addEventListener('click', selectHandler);
  btnMeasure && btnMeasure.addEventListener('click', measureHandler);
  btnDraw    && btnDraw   .addEventListener('click', drawHandler);
  btnCapture && btnCapture.addEventListener('click', captureHandler);

  // Default active = Select (preserves the .a class already in markup)
  if (btnSelect && btnSelect.classList.contains('a')) {
    state.activate(btnSelect, makeSelect({ host, btn: btnSelect }), { cursorCross: false });
  }

  return function dispose() {
    state.deactivate();
    btnSelect  && btnSelect .removeEventListener('click', selectHandler);
    btnMeasure && btnMeasure.removeEventListener('click', measureHandler);
    btnDraw    && btnDraw   .removeEventListener('click', drawHandler);
    btnCapture && btnCapture.removeEventListener('click', captureHandler);
  };
}

export default mountViewportTools;
