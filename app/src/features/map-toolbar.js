/**
 * map-toolbar.js
 *
 * Premium glass-morphism floating right rail. Single integrated control
 * surface for ALL map manipulation: zoom, compass, View [2D|3D|Globe],
 * Style [Satellite|Streets|Terrain|Thermal|Risk], Layers, Locate,
 * Fullscreen. Replaces the old top vp-modes / vp-mapctl pill rows and
 * the maplibre native control stack.
 *
 * @module features/map-toolbar
 */

const STYLE_ID = 'rwr-map-toolbar-styles';

/**
 * Inject the module's stylesheet exactly once.
 * @returns {void}
 */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rwr-mt-root{
      position:absolute; inset:0;
      pointer-events:none;
      z-index:30;
      font-family: var(--sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    .rwr-mt-bar{
      position:absolute;
      right:14px; top:50%;
      transform: translateY(-50%);
      width:38px;
      display:flex; flex-direction:column;
      align-items:stretch;
      gap:0;
      padding:4px;
      pointer-events:auto;
      background: linear-gradient(180deg, rgba(10,18,34,0.86), rgba(6,12,24,0.86));
      border:1px solid rgba(120,160,220,0.22);
      border-radius:8px;
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      box-shadow:
        0 8px 28px rgba(0,0,0,0.55),
        inset 0 0 0 1px rgba(255,255,255,0.025),
        inset 0 1px 0 rgba(255,255,255,0.04);
      color: var(--t1, #d8e8ff);
    }
    .rwr-mt-btn{
      position:relative;
      width:30px; height:30px;
      display:flex; align-items:center; justify-content:center;
      border-radius:5px;
      background:transparent;
      border:none;
      color: var(--t1, #d8e8ff);
      cursor:pointer;
      transition: background 200ms ease, color 200ms ease, box-shadow 200ms ease, transform 160ms ease;
      font-size: 14px;
      line-height:1;
      padding:0;
      outline:none;
    }
    .rwr-mt-btn:focus-visible{
      box-shadow: inset 0 0 0 1px rgba(0,200,255,0.6), 0 0 12px rgba(0,200,255,0.25);
    }
    .rwr-mt-btn:hover:not(:disabled){
      color: var(--cyan, #00c8ff);
      background: rgba(0,200,255,0.07);
      box-shadow: inset 0 0 0 1px rgba(0,200,255,0.30), 0 0 12px rgba(0,200,255,0.10);
    }
    .rwr-mt-btn:active:not(:disabled){
      transform: scale(0.92);
    }
    .rwr-mt-btn:disabled{
      opacity:0.32;
      cursor:not-allowed;
    }
    .rwr-mt-btn.is-active{
      color: var(--cyan, #00c8ff);
      background: rgba(0,200,255,0.12);
      box-shadow:
        inset 0 0 0 1px rgba(0,200,255,0.55),
        0 0 16px rgba(0,200,255,0.28);
    }
    .rwr-mt-sep{
      height:1px; margin:4px 3px;
      background: linear-gradient(90deg, transparent, rgba(120,160,220,0.30), transparent);
    }
    .rwr-mt-icon{
      width:16px; height:16px;
      display:inline-block;
      transition: transform 200ms ease;
    }
    .rwr-mt-readout{
      width:30px; min-height:24px;
      display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      padding:3px 0;
      font-family: var(--mono, "SFMono-Regular", Menlo, Consolas, monospace);
      color: var(--t2, #97a8c8);
      font-size:9px;
      line-height:1.2;
      letter-spacing:0.4px;
      text-align:center;
      cursor:pointer;
      border-radius:4px;
      transition: color 200ms ease, background 200ms ease;
    }
    .rwr-mt-readout:hover{
      color: var(--cyan, #00c8ff);
      background: rgba(0,200,255,0.06);
    }
    .rwr-mt-readout.is-flash{
      color: var(--cyan, #00c8ff);
      background: rgba(0,200,255,0.20);
    }
    .rwr-mt-readout .rwr-mt-r-label{
      font-size:6.5px;
      text-transform:uppercase;
      letter-spacing:0.6px;
      color: var(--t3, #5a6a90);
    }
    .rwr-mt-readout .rwr-mt-r-val{
      font-size:9px;
    }
    .rwr-mt-tip{
      position:absolute;
      right:calc(100% + 10px);
      top:50%;
      transform: translateY(-50%) translateX(4px);
      pointer-events:none;
      white-space:nowrap;
      padding:5px 9px;
      background: rgba(8,16,32,0.94);
      border:1px solid rgba(120,160,220,0.28);
      border-radius:5px;
      color: var(--t1, #d8e8ff);
      font-size:9.5px;
      letter-spacing:0.5px;
      text-transform:uppercase;
      opacity:0;
      transition: opacity 160ms ease, transform 160ms ease;
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
      box-shadow: 0 4px 14px rgba(0,0,0,0.4);
      z-index:2;
    }
    .rwr-mt-btn:hover .rwr-mt-tip,
    .rwr-mt-readout:hover .rwr-mt-tip{
      opacity:1;
      transform: translateY(-50%) translateX(0);
    }
    .rwr-mt-pop{
      position:absolute;
      right:calc(100% + 10px);
      top:50%;
      transform: translateY(-50%);
      min-width:148px;
      padding:5px;
      background: linear-gradient(180deg, rgba(10,18,34,0.94), rgba(6,12,24,0.94));
      border:1px solid rgba(120,160,220,0.28);
      border-radius:7px;
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      box-shadow: 0 8px 28px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.025);
      display:none;
      z-index:3;
    }
    .rwr-mt-pop.is-open{ display:block; }
    .rwr-mt-pop-title{
      padding:5px 10px 6px;
      font-size:8px;
      letter-spacing:1.2px;
      text-transform:uppercase;
      color: var(--t3, #5a6a90);
      font-family: var(--mono, monospace);
      border-bottom:1px solid rgba(120,160,220,0.12);
      margin-bottom:3px;
    }
    .rwr-mt-pop-item{
      display:flex; align-items:center; justify-content:space-between;
      padding:7px 10px;
      font-size:10.5px;
      letter-spacing:0.4px;
      color: var(--t1, #d8e8ff);
      cursor:pointer;
      border-radius:4px;
      transition: background 160ms ease, color 160ms ease;
    }
    .rwr-mt-pop-item:hover{
      background: rgba(0,200,255,0.08);
      color: var(--cyan, #00c8ff);
    }
    .rwr-mt-pop-item.is-active{
      background: rgba(0,200,255,0.10);
      color: var(--cyan, #00c8ff);
    }
    .rwr-mt-pop-item .rwr-mt-check{
      color: var(--cyan, #00c8ff);
      opacity:0;
      font-size:11px;
    }
    .rwr-mt-pop-item.is-active .rwr-mt-check{ opacity:1; }
    /* The bar is an always-dark glass floating control (its background is
       hardcoded dark in both surfaces). Under light surface the design tokens
       (--t1/--t2/--t3) flip to dark text, which would render the icons
       near-black on the dark bar — invisible. Re-assert light icon/text colors
       in light mode so the controls stay legible in both surfaces. */
    [data-surface='light'] .rwr-mt-bar,
    [data-surface='light'] .rwr-mt-btn,
    [data-surface='light'] .rwr-mt-pop-item,
    [data-surface='light'] .rwr-mt-tip{ color:#d8e8ff; }
    [data-surface='light'] .rwr-mt-readout{ color:#97a8c8; }
    [data-surface='light'] .rwr-mt-readout .rwr-mt-r-label,
    [data-surface='light'] .rwr-mt-pop-title{ color:#5a6a90; }
    @media (prefers-reduced-motion: reduce){
      .rwr-mt-btn, .rwr-mt-icon, .rwr-mt-tip, .rwr-mt-pop, .rwr-mt-readout{
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Build a simple SVG icon element from inline path data.
 * @param {string} svg Inner SVG markup
 * @returns {HTMLSpanElement}
 */
function svgIcon(svg) {
  const wrap = document.createElement('span');
  wrap.className = 'rwr-mt-icon';
  wrap.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
  return wrap;
}

const ICONS = {
  plus:       `<path d="M8 3v10M3 8h10"/>`,
  minus:      `<path d="M3 8h10"/>`,
  compass:    `<circle cx="8" cy="8" r="6"/><path d="M10.5 5.5L8.8 8.8 5.5 10.5 7.2 7.2z" fill="currentColor" stroke="none"/>`,
  view:       `<path d="M2 11l6-7 6 7"/><path d="M2 11l6 3 6-3"/>`,
  style:      `<path d="M2 5l4-2 4 2 4-2v8l-4 2-4-2-4 2zM6 3v10M10 5v10"/>`,
  layers:     `<path d="M8 2l6 3-6 3-6-3 6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/>`,
  locate:     `<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>`,
  fullscreen: `<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>`,
};

/**
 * Debounce helper.
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
function debounce(fn, wait) {
  let t = 0;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Format a coordinate for the readout.
 * @param {number} v
 * @returns {string}
 */
function fmtCoord(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '--';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v).toFixed(2);
  return `${sign}${abs}`;
}

/**
 * Mount the floating map toolbar (right rail).
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container Element the toolbar root attaches to (typically the viewport)
 * @param {Object} opts.host Unified host adapter (must expose flyTo, getDS, setMode)
 * @param {Object} opts.engineHost Engine host (setMode, getActive, setBasemap, setTerrain, setBuildings3D, setPitch, getCamera)
 * @returns {{ destroy: () => void }}
 */
export function mountMapToolbar({ container, host, engineHost }) {
  if (!container) throw new Error('mountMapToolbar: container is required');
  if (!host) throw new Error('mountMapToolbar: host is required');
  if (!engineHost) throw new Error('mountMapToolbar: engineHost is required');

  injectStyles();

  // ---- root + bar ---------------------------------------------------------
  const root = document.createElement('div');
  root.className = 'rwr-mt-root';
  root.setAttribute('aria-label', 'Map controls overlay');

  const bar = document.createElement('div');
  bar.className = 'rwr-mt-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', 'Map navigation');
  root.appendChild(bar);

  // ---- shared state -------------------------------------------------------
  const state = {
    cam: safeCamera(),
    bearing: 0,
    pitch: 0,
    activeEngine: safeActiveEngine(),
    basemap: 'satellite',
    view: '3d',           // '2d' | '3d' | 'globe'
    style: 'satellite',   // 'satellite' | 'streets' | 'terrain' | 'thermal' | 'risk'
    terrain: false,
    fullscreen: false,
  };

  function safeCamera() {
    try { return engineHost.getCamera ? (engineHost.getCamera() || {}) : {}; }
    catch (_) { return {}; }
  }
  function safeActiveEngine() {
    try { return engineHost.getActive ? engineHost.getActive() : 'globe'; }
    catch (_) { return 'globe'; }
  }

  // ---- helpers ------------------------------------------------------------
  function makeBtn(key, label, aria) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rwr-mt-btn';
    b.setAttribute('aria-label', aria || label);
    b.title = label;
    b.appendChild(svgIcon(ICONS[key] || ''));
    const tip = document.createElement('span');
    tip.className = 'rwr-mt-tip';
    tip.textContent = label;
    b.appendChild(tip);
    return b;
  }

  function makeSep() {
    const s = document.createElement('div');
    s.className = 'rwr-mt-sep';
    return s;
  }

  function currentZoom() {
    const z = (state.cam && typeof state.cam.zoom === 'number') ? state.cam.zoom : 4;
    return z;
  }
  function currentLat() {
    const v = state.cam && typeof state.cam.lat === 'number' ? state.cam.lat : 0;
    return v;
  }
  function currentLon() {
    const v = state.cam && typeof state.cam.lon === 'number' ? state.cam.lon : 0;
    return v;
  }

  function flyDelta(dz) {
    const z = Math.max(0, Math.min(22, currentZoom() + dz));
    try { host.flyTo(currentLat(), currentLon(), z); }
    catch (_) { /* engine may not be ready */ }
  }

  // Cinematic zoom: prefer the engine-native easeTo path when available
  // (smooth cubic-bezier, walks intermediate tile levels, no parabolic
  // swoop). Falls back to flyDelta when the engine doesn't expose it
  // (e.g. the Cesium HD-3D engine) so the buttons keep working.
  function zoomStep(dz) {
    try {
      if (typeof host.cinematicZoom === 'function') {
        host.cinematicZoom(dz);
        return;
      }
    } catch (_) {}
    flyDelta(dz);
  }

  // ---- buttons ------------------------------------------------------------
  const btnZoomIn  = makeBtn('plus',       'Zoom in',          'Zoom in');
  const btnZoomOut = makeBtn('minus',      'Zoom out',         'Zoom out');
  const btnCompass = makeBtn('compass',    'Reset bearing',    'Reset bearing to north');
  const btnView    = makeBtn('view',       'View — 2D / 3D / Globe', 'Choose camera view');
  const btnStyle   = makeBtn('style',      'Map style',        'Choose map style');
  const btnLayers  = makeBtn('layers',     'Toggle layers panel', 'Show or hide the layer stack');
  const btnLocate  = makeBtn('locate',     'Locate me',        'Center on my location');
  const btnFS      = makeBtn('fullscreen', 'Fullscreen',       'Enter or exit fullscreen');

  bar.appendChild(btnZoomIn);
  bar.appendChild(btnZoomOut);
  bar.appendChild(makeSep());
  bar.appendChild(btnCompass);
  bar.appendChild(btnView);
  bar.appendChild(btnStyle);
  bar.appendChild(makeSep());
  bar.appendChild(btnLayers);
  bar.appendChild(btnLocate);
  bar.appendChild(btnFS);
  bar.appendChild(makeSep());

  // ---- readouts -----------------------------------------------------------
  const zoomReadout = document.createElement('div');
  zoomReadout.className = 'rwr-mt-readout';
  zoomReadout.setAttribute('role', 'status');
  zoomReadout.setAttribute('aria-label', 'Current zoom level');
  zoomReadout.innerHTML = `
    <div class="rwr-mt-r-label">Z</div>
    <div class="rwr-mt-r-val" data-z>--</div>
    <span class="rwr-mt-tip">Zoom level</span>
  `;
  bar.appendChild(zoomReadout);

  const coordReadout = document.createElement('div');
  coordReadout.className = 'rwr-mt-readout';
  coordReadout.setAttribute('role', 'button');
  coordReadout.setAttribute('tabindex', '0');
  coordReadout.setAttribute('aria-label', 'Copy coordinates to clipboard');
  coordReadout.innerHTML = `
    <div class="rwr-mt-r-label">LAT</div>
    <div class="rwr-mt-r-val" data-lat>--</div>
    <div class="rwr-mt-r-label" style="margin-top:2px">LON</div>
    <div class="rwr-mt-r-val" data-lon>--</div>
    <span class="rwr-mt-tip">Click to copy lat,lon</span>
  `;
  bar.appendChild(coordReadout);

  // ---- popovers (View + Style) -------------------------------------------
  /**
   * Build a labeled popover anchored to a button.
   * @param {string} title Section header text
   * @param {Array<{id:string,label:string,sub?:string}>} items Choice list
   * @param {(id:string)=>void} onPick Callback when an item is clicked
   * @returns {{root: HTMLElement, items: HTMLElement[], setActive:(id:string)=>void, open:()=>void, close:()=>void, isOpen:()=>boolean}}
   */
  function makePopover(title, items, onPick) {
    const pop = document.createElement('div');
    pop.className = 'rwr-mt-pop';
    pop.setAttribute('role', 'menu');
    const header = document.createElement('div');
    header.className = 'rwr-mt-pop-title';
    header.textContent = title;
    pop.appendChild(header);
    const els = [];
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'rwr-mt-pop-item';
      row.setAttribute('role', 'menuitemradio');
      row.dataset.id = it.id;
      row.innerHTML = `<span>${it.label}</span><span class="rwr-mt-check" aria-hidden="true">&#10003;</span>`;
      row.addEventListener('click', () => {
        try { onPick(it.id); } catch (_) {}
      });
      pop.appendChild(row);
      els.push(row);
    }
    function setActive(id) {
      for (const r of els) {
        const on = r.dataset.id === id;
        r.classList.toggle('is-active', on);
        r.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    }
    function isOpen() { return pop.classList.contains('is-open'); }
    function open()   { pop.classList.add('is-open'); }
    function close()  { pop.classList.remove('is-open'); }
    return { root: pop, items: els, setActive, open, close, isOpen };
  }

  const VIEW_ITEMS = [
    { id: '2d',    label: '2D — top-down' },
    { id: '3d',    label: '3D — angled' },
    { id: 'globe', label: 'Globe — orbital' },
  ];
  const STYLE_ITEMS = [
    { id: 'satellite', label: 'Satellite' },
    { id: 'streets',   label: 'Streets' },
    { id: 'terrain',   label: 'Terrain' },
    { id: 'thermal',   label: 'Thermal' },
    { id: 'risk',      label: 'Risk Map' },
  ];

  function applyView(id) {
    state.view = id;
    const curMode = (() => { try { return host.getMode?.(); } catch (_) { return null; } })();
    if (id === 'globe') {
      try { host.setMode?.('globe', { manual: true }); } catch (_) {}
    } else if (id === '2d') {
      // Only break out of globe mode — preserve risk / thermal / satellite
      // / streets so picking a top-down view doesn't silently kill the
      // user's active Risk Map or Thermal overlay.
      if (curMode === 'globe') {
        try { host.setMode?.('satellite', { manual: true }); } catch (_) {}
      }
      try { engineHost.setPitch?.(0); } catch (_) {}
    } else { // '3d'
      if (curMode === 'globe') {
        try { host.setMode?.('satellite', { manual: true }); } catch (_) {}
      }
      try { engineHost.setPitch?.(60); } catch (_) {}
    }
    viewPop.setActive(id);
  }

  function applyStyle(id) {
    state.style = id;
    if (id === 'thermal') {
      try { host.setMode?.('thermal', { manual: true }); } catch (_) {}
    } else if (id === 'risk') {
      try { host.setMode?.('risk', { manual: true }); } catch (_) {}
    } else if (id === 'terrain') {
      // terrain = satellite basemap + terrain hillshade ON
      try { engineHost.setBasemap?.('satellite'); } catch (_) {}
      try { engineHost.setTerrain?.(true); } catch (_) {}
      state.terrain = true;
      state.basemap = 'satellite';
    } else { // satellite | streets
      try { engineHost.setBasemap?.(id); } catch (_) {}
      try { engineHost.setTerrain?.(false); } catch (_) {}
      state.terrain = false;
      state.basemap = id;
    }
    stylePop.setActive(id);
  }

  const viewPop  = makePopover('View',  VIEW_ITEMS,  (id) => { applyView(id);  closePopovers(); });
  const stylePop = makePopover('Style', STYLE_ITEMS, (id) => { applyStyle(id); closePopovers(); });
  btnView.style.position  = 'relative';
  btnStyle.style.position = 'relative';
  btnView.appendChild(viewPop.root);
  btnStyle.appendChild(stylePop.root);
  viewPop.setActive(state.view);
  stylePop.setActive(state.style);

  function closePopovers() {
    viewPop.close();
    stylePop.close();
    btnView.setAttribute('aria-expanded', 'false');
    btnStyle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }
  function onDocMouseDown(e) {
    if (!btnView.contains(e.target) && !btnStyle.contains(e.target)) closePopovers();
  }
  function onDocKeyDown(e) {
    if (e.key === 'Escape') closePopovers();
  }
  function togglePop(which) {
    const target = which === 'view' ? viewPop : stylePop;
    const other  = which === 'view' ? stylePop : viewPop;
    const targetBtn = which === 'view' ? btnView : btnStyle;
    const otherBtn  = which === 'view' ? btnStyle : btnView;
    if (target.isOpen()) {
      target.close();
      targetBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      return;
    }
    other.close();
    otherBtn.setAttribute('aria-expanded', 'false');
    target.open();
    targetBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
  }
  btnView.setAttribute('aria-haspopup', 'menu');
  btnView.setAttribute('aria-expanded', 'false');
  btnStyle.setAttribute('aria-haspopup', 'menu');
  btnStyle.setAttribute('aria-expanded', 'false');

  // ---- click handlers -----------------------------------------------------
  btnZoomIn.addEventListener('click', () => zoomStep(+1));
  btnZoomOut.addEventListener('click', () => zoomStep(-1));

  btnCompass.addEventListener('click', () => {
    try {
      host.flyTo(currentLat(), currentLon(), currentZoom());
      window.dispatchEvent(new CustomEvent('camera:change', {
        detail: { lat: currentLat(), lon: currentLon(), zoom: currentZoom(), bearing: 0, pitch: state.pitch, engine: state.activeEngine },
      }));
    } catch (_) { /* noop */ }
  });

  btnView.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop('view');
  });
  btnStyle.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop('style');
  });

  btnLayers.addEventListener('click', () => {
    // Dispatch a toggle event the dashboard can listen for to show/hide the
    // Layer Stack section in the left panel. Idempotent + decoupled.
    try {
      window.dispatchEvent(new CustomEvent('rwr:layers-toggle'));
    } catch (_) {}
    btnLayers.classList.toggle('is-active');
  });

  btnLocate.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    btnLocate.classList.add('is-active');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        try { host.flyTo(lat, lon, Math.max(currentZoom(), 14)); } catch (_) {}
        setTimeout(() => btnLocate.classList.remove('is-active'), 800);
      },
      () => { btnLocate.classList.remove('is-active'); },
      { enableHighAccuracy: true, timeout: 6000 },
    );
  });

  btnFS.addEventListener('click', () => {
    const el = container || document.documentElement;
    const isFs = !!document.fullscreenElement;
    try {
      if (isFs) {
        document.exitFullscreen?.();
      } else {
        el.requestFullscreen?.();
      }
    } catch (_) { /* noop */ }
  });
  document.addEventListener('fullscreenchange', () => {
    state.fullscreen = !!document.fullscreenElement;
    btnFS.classList.toggle('is-active', state.fullscreen);
  });

  // coords copy-to-clipboard
  function copyCoords() {
    const txt = `${currentLat().toFixed(5)}, ${currentLon().toFixed(5)}`;
    const flash = () => {
      coordReadout.classList.add('is-flash');
      setTimeout(() => coordReadout.classList.remove('is-flash'), 450);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(flash, flash);
    } else {
      flash();
    }
  }
  coordReadout.addEventListener('click', copyCoords);
  coordReadout.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyCoords(); }
  });

  // ---- DOM refs for live updates -----------------------------------------
  const compassIconSvg = btnCompass.querySelector('svg');
  const zEl = zoomReadout.querySelector('[data-z]');
  const latEl = coordReadout.querySelector('[data-lat]');
  const lonEl = coordReadout.querySelector('[data-lon]');

  function applyCameraToUI() {
    if (zEl) zEl.textContent = (typeof currentZoom() === 'number') ? currentZoom().toFixed(1) : '--';
    if (latEl) latEl.textContent = fmtCoord(currentLat());
    if (lonEl) lonEl.textContent = fmtCoord(currentLon());
    if (compassIconSvg) {
      compassIconSvg.style.transform = `rotate(${-state.bearing}deg)`;
    }
    // Sync the View segment based on observed pitch + active engine.
    const eng = state.activeEngine;
    let vid = state.view;
    if (eng === 'globe') vid = 'globe';
    else if (state.pitch && state.pitch > 1) vid = '3d';
    else vid = '2d';
    if (vid !== state.view) {
      state.view = vid;
      viewPop.setActive(state.view);
    }
    btnView.classList.toggle('is-active', state.view !== 'satellite');
  }

  // ---- event subscriptions ------------------------------------------------
  const onCamera = debounce((ev) => {
    const d = (ev && ev.detail) || {};
    if (typeof d.lat === 'number') state.cam.lat = d.lat;
    if (typeof d.lon === 'number') state.cam.lon = d.lon;
    if (typeof d.zoom === 'number') state.cam.zoom = d.zoom;
    if (typeof d.bearing === 'number') state.bearing = d.bearing;
    if (typeof d.pitch === 'number') state.pitch = d.pitch;
    if (typeof d.engine === 'string') state.activeEngine = d.engine;
    applyCameraToUI();
  }, 100);

  const onEngineReady = (ev) => {
    const id = ev && ev.detail && ev.detail.id;
    if (id) state.activeEngine = id;
    state.cam = safeCamera();
    applyCameraToUI();
  };

  window.addEventListener('camera:change', onCamera);
  window.addEventListener('engine:ready', onEngineReady);

  // initial paint
  applyCameraToUI();

  // ---- mount + return -----------------------------------------------------
  container.appendChild(root);

  return {
    destroy() {
      window.removeEventListener('camera:change', onCamera);
      window.removeEventListener('engine:ready', onEngineReady);
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

export default mountMapToolbar;
