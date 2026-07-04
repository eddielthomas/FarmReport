// =============================================================================
// workspace-tabs.js  —  Team B (RWR MVP)
// -----------------------------------------------------------------------------
// Wires the 6 top-nav tabs to functional slide-over panels:
//   overview · detections · analytics · assets · reports · settings
//
// Public API:
//   mountWorkspaceTabs({ ds, host })   -> { open(tabId), close(), destroy() }
//
// Custom events (dispatched on document):
//   'workspace:open'    detail: { tab }
//   'workspace:close'
//   'settings:change'   detail: <settings object>
//
// SAFETY: Read-only against `ds`. Does NOT touch index.html, detections.js,
// build-ds.js, vite.config.js, or package.json.
// =============================================================================

const PANEL_PREFIX = 'wsPanel_';
const STYLE_ID     = 'wsTabsStyle';
const STORAGE_KEY  = 'rwr.mvp.settings';

// ---------- helpers ---------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const downloadBlob = (filename, mime, data) => {
  const blob = new Blob([data], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
};

const loadSettings = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
};
const saveSettings = (obj) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  document.dispatchEvent(new CustomEvent('settings:change', { detail: obj }));
};

// ---------- styles ----------------------------------------------------------
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.ws-panel{
  position:fixed; top:36px; right:0; width:420px; height:calc(100vh - 56px);
  background:linear-gradient(180deg,rgba(8,16,32,0.96),rgba(5,9,16,0.98));
  backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px);
  border-left:1px solid var(--borderH);
  box-shadow:-8px 0 32px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.03);
  transform:translateX(100%); transition:transform .2s cubic-bezier(.4,0,.2,1);
  z-index:200; display:flex; flex-direction:column; overflow:hidden;
  font-family:var(--sans); color:var(--t1);
}
.ws-panel.open{ transform:translateX(0); }
.ws-panel-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px; border-bottom:1px solid var(--border); flex-shrink:0;
}
.ws-panel-title{
  font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:1.2px;
  color:var(--cyan);
}
.ws-panel-sub{
  font-size:7px; color:var(--t3); font-family:var(--mono); margin-top:2px;
}
.ws-panel-close{
  width:22px; height:22px; border-radius:4px; border:1px solid var(--border);
  background:transparent; color:var(--t2); font-size:11px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; transition:all .15s;
}
.ws-panel-close:hover{ color:var(--red); border-color:var(--red); }
.ws-panel-body{ flex:1; overflow-y:auto; padding:12px 14px; }
.ws-panel-section{ margin-bottom:14px; }
.ws-panel-section h4{
  font-size:7px; font-weight:800; text-transform:uppercase; letter-spacing:1px;
  color:var(--t3); margin-bottom:6px; display:flex; align-items:center; gap:6px;
}
.ws-panel-section h4::after{ content:''; flex:1; height:1px; background:var(--border); }

.ws-chips{ display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; }
.ws-chip{
  padding:3px 8px; border-radius:10px; font-size:7px; font-weight:700;
  text-transform:uppercase; letter-spacing:.5px; cursor:pointer;
  border:1px solid var(--border); background:transparent; color:var(--t3);
  transition:all .15s;
}
.ws-chip:hover{ border-color:var(--borderH); color:var(--t2); }
.ws-chip.active{ background:rgba(0,200,255,0.06); border-color:var(--cyan); color:var(--cyan); }
.ws-chip.high.active{ background:rgba(255,64,96,0.08); border-color:var(--red); color:var(--red); }
.ws-chip.medium.active{ background:rgba(255,176,32,0.08); border-color:var(--amber); color:var(--amber); }
.ws-chip.low.active{ background:rgba(77,159,255,0.08); border-color:var(--blue); color:var(--blue); }

.ws-toolbar{ display:flex; gap:6px; margin-bottom:8px; align-items:center; }
.ws-toolbar .search-input{ flex:1; }
.ws-select{
  padding:5px 8px; border-radius:5px; border:1px solid var(--border);
  background:rgba(0,0,0,0.3); color:var(--t1); font-family:var(--sans);
  font-size:8px; outline:none; cursor:pointer;
}
.ws-select:focus{ border-color:var(--cyan); }

.ws-row{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:5px 6px; border-radius:4px; border:1px solid transparent;
  transition:all .15s; font-size:8px;
}
.ws-row:hover{ background:rgba(60,140,255,0.04); border-color:var(--border); }
.ws-row .k{ color:var(--t3); font-size:7.5px; text-transform:uppercase; letter-spacing:.4px; }
.ws-row .v{ color:var(--t1); font-weight:600; font-family:var(--mono); font-size:7.5px; text-align:right; }
.ws-row .v a{ color:var(--cyan); text-decoration:none; }
.ws-row .v a:hover{ text-decoration:underline; }

.ws-status{
  display:inline-flex; padding:1px 6px; border-radius:3px; font-size:6px;
  font-weight:800; letter-spacing:.4px; text-transform:uppercase;
  border:1px solid var(--border); color:var(--t2); background:rgba(0,0,0,0.2);
  margin-left:4px;
}
.ws-status.green{ color:var(--green); border-color:rgba(0,230,138,0.3); }
.ws-status.amber{ color:var(--amber); border-color:rgba(255,176,32,0.3); }
.ws-status.red{ color:var(--red); border-color:rgba(255,64,96,0.3); }
.ws-status.blue{ color:var(--blue); border-color:rgba(77,159,255,0.3); }

.ws-kpi-grid{ display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.ws-kpi{
  border:1px solid var(--border); border-radius:5px; padding:6px 8px;
  background:rgba(0,0,0,0.2);
}
.ws-kpi .lbl{ font-size:6.5px; color:var(--t3); text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
.ws-kpi .val{ font-size:11px; font-weight:700; font-family:var(--mono); color:var(--t1); }

.ws-bar-row{ display:flex; align-items:center; gap:6px; margin-bottom:3px; }
.ws-bar-lbl{ width:64px; font-size:7px; color:var(--t3); text-transform:uppercase; letter-spacing:.4px; flex-shrink:0; }
.ws-bar-track{ flex:1; height:6px; border-radius:3px; background:var(--bg3); overflow:hidden; }
.ws-bar-fill{ height:100%; border-radius:3px; }
.ws-bar-val{ width:36px; text-align:right; font-size:7px; font-family:var(--mono); color:var(--t2); }

.ws-btn{
  display:flex; align-items:center; gap:8px; width:100%;
  padding:8px 10px; border-radius:5px; border:1px solid var(--border);
  background:rgba(0,0,0,0.25); color:var(--t1); font-family:var(--sans);
  font-size:8.5px; font-weight:600; cursor:pointer; transition:all .15s;
  margin-bottom:4px; text-align:left;
}
.ws-btn:hover{ border-color:var(--cyan); color:var(--cyan); background:rgba(0,200,255,0.04); }
.ws-btn .ico{ font-size:11px; }
.ws-btn .meta{ margin-left:auto; font-family:var(--mono); font-size:7px; color:var(--t3); }

.ws-form-row{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 0; border-bottom:1px solid var(--border); }
.ws-form-row:last-child{ border-bottom:none; }
.ws-form-row label{ font-size:8px; color:var(--t2); flex:1; }
.ws-form-row .hint{ font-size:6.5px; color:var(--t4); display:block; margin-top:1px; font-family:var(--mono); }

.ws-toggle{
  width:32px; height:16px; border-radius:8px; background:var(--bg3);
  border:1px solid var(--border); position:relative; cursor:pointer;
  transition:all .25s; flex-shrink:0;
}
.ws-toggle.on{ background:var(--blue); border-color:var(--blue); }
.ws-toggle::after{
  content:''; position:absolute; width:12px; height:12px; border-radius:50%;
  background:#fff; top:1px; left:1px; transition:transform .25s cubic-bezier(.4,0,.2,1);
}
.ws-toggle.on::after{ transform:translateX(16px); }

.ws-input{
  padding:4px 6px; border-radius:4px; border:1px solid var(--border);
  background:rgba(0,0,0,0.3); color:var(--t1); font-family:var(--mono);
  font-size:8px; width:80px; outline:none;
}
.ws-input:focus{ border-color:var(--cyan); }

.ws-empty{
  padding:24px 12px; text-align:center; color:var(--t3); font-size:8px; font-style:italic;
}

@media (max-width:900px){
  .ws-panel{ width:100vw; }
}
`;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

// ---------- panel chrome ----------------------------------------------------
function createPanel(id, title, sub = '') {
  const existing = document.getElementById(PANEL_PREFIX + id);
  if (existing) return existing;
  const el = document.createElement('aside');
  el.id = PANEL_PREFIX + id;
  el.className = 'ws-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <header class="ws-panel-head">
      <div>
        <div class="ws-panel-title">${esc(title)}</div>
        ${sub ? `<div class="ws-panel-sub">${esc(sub)}</div>` : ''}
      </div>
      <button class="ws-panel-close" type="button" aria-label="Close panel" data-ws-close>×</button>
    </header>
    <div class="ws-panel-body" data-ws-body></div>
  `;
  document.body.appendChild(el);
  el.querySelector('[data-ws-close]').addEventListener('click', () => {
    closeAllPanels();
    setActiveTab('overview');
  });
  return el;
}

function closeAllPanels() {
  $$('.ws-panel.open').forEach((p) => {
    p.classList.remove('open');
    p.setAttribute('aria-hidden', 'true');
  });
  document.dispatchEvent(new CustomEvent('workspace:close'));
}

function openPanel(id) {
  closeAllPanels();
  const el = document.getElementById(PANEL_PREFIX + id);
  if (!el) return;
  // Allow transition by deferring class addition one frame
  requestAnimationFrame(() => {
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    const focusable = el.querySelector('input, select, button:not(.ws-panel-close)');
    if (focusable) try { focusable.focus(); } catch {}
  });
}

function setActiveTab(tabId) {
  $$('.nav-tab').forEach((t) => {
    t.classList.toggle('a', t.getAttribute('data-tab') === tabId);
  });
}

// ---------- DETECTIONS panel ------------------------------------------------
function renderDetections(panel, ds, host) {
  const body = panel.querySelector('[data-ws-body]');
  const state = { sev: 'all', q: '', sort: 'severity' };

  const sevWeight = (s) => ({ high: 3, medium: 2, low: 1 }[s] || 0);

  const render = () => {
    const q = state.q.trim().toLowerCase();
    let rows = (ds.detections || []).filter((d) => {
      if (state.sev !== 'all' && d.severity !== state.sev) return false;
      if (q && !(`${d.id} ${d.name} ${d.location} ${d.type}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (state.sort === 'severity') rows.sort((a, b) => sevWeight(b.severity) - sevWeight(a.severity) || (b.score || 0) - (a.score || 0));
    else if (state.sort === 'score') rows.sort((a, b) => (b.score || 0) - (a.score || 0));
    else if (state.sort === 'time')  rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));

    const list = rows.slice(0, 500); // cap for DOM perf

    body.innerHTML = `
      <div class="ws-toolbar">
        <input class="search-input" placeholder="Search detections (id, type, location)" data-q value="${esc(state.q)}">
        <select class="ws-select" data-sort>
          <option value="severity"${state.sort==='severity'?' selected':''}>Sort: Severity</option>
          <option value="score"${state.sort==='score'?' selected':''}>Sort: Score</option>
          <option value="time"${state.sort==='time'?' selected':''}>Sort: Time</option>
        </select>
      </div>
      <div class="ws-chips" data-chips>
        ${['all','high','medium','low'].map((s) =>
          `<button class="ws-chip ${s} ${state.sev===s?'active':''}" data-sev="${s}" type="button">${s}</button>`
        ).join('')}
      </div>
      <div style="font-size:7px;color:var(--t3);margin-bottom:6px;font-family:var(--mono)">
        ${list.length} of ${(ds.detections||[]).length} detections
      </div>
      <div data-list>
        ${list.length ? list.map((d) => `
          <div class="det-feed-item sev-${d.severity}" data-id="${esc(d.id)}" tabindex="0" role="button" aria-label="${esc(d.name)}">
            <div class="det-icon">${d.severity==='high'?'âš ':d.severity==='medium'?'◆':'•'}</div>
            <div class="det-info">
              <div class="det-info-type ${d.severity}">${esc(d.type || '')}</div>
              <div class="det-info-name">${esc(d.name || d.id)}</div>
              <div class="det-info-meta">${esc((d.location||'').slice(0,40))} · ${esc(d.time||'')}</div>
            </div>
            <div style="font-family:var(--mono);font-size:9px;font-weight:700;color:var(--cyan)">${d.score|0}</div>
          </div>`).join('')
          : `<div class="ws-empty">No detections match the current filters.</div>`}
      </div>
    `;

    body.querySelector('[data-q]').addEventListener('input', (e) => {
      state.q = e.target.value; render();
      // Restore focus
      const inp = body.querySelector('[data-q]');
      if (inp) { inp.focus(); inp.setSelectionRange(state.q.length, state.q.length); }
    });
    body.querySelector('[data-sort]').addEventListener('change', (e) => {
      state.sort = e.target.value; render();
    });
    body.querySelectorAll('[data-sev]').forEach((c) =>
      c.addEventListener('click', () => { state.sev = c.dataset.sev; render(); })
    );
    body.querySelectorAll('.det-feed-item').forEach((row) => {
      const handler = () => {
        const det = (ds.detections || []).find((d) => d.id === row.dataset.id);
        if (!det) return;
        try { host?.flyTo?.({ lat: det.lat, lon: det.lon, zoom: 14 }); } catch {}
        try { host?.selectDetection?.(det.id); } catch {}
        document.dispatchEvent(new CustomEvent('detection:select', { detail: { id: det.id } }));
      };
      row.addEventListener('click', handler);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    });
  };
  render();
}

// ---------- ANALYTICS panel -------------------------------------------------
function renderAnalytics(panel, ds) {
  const body = panel.querySelector('[data-ws-body]');
  const det  = ds.detections || [];
  const sev  = { high: 0, medium: 0, low: 0 };
  det.forEach((d) => { if (sev[d.severity] != null) sev[d.severity]++; });
  const sevMax = Math.max(1, sev.high, sev.medium, sev.low);

  const tl = ds.timelineData || [];
  const tlMonths = ['Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan'];
  const tlSeries = tl[0] || []; // verified leaks per month
  const tlMax    = Math.max(1, ...tlSeries);

  const sysIntel = ds.sysIntel || [];
  const am       = ds._assetMetrics || null;

  // top-5 leaks-per-license rows
  const perLicenseGraph = ds._meta?.charts?.chartsData?.performanceByLicenseGraph?.graphData
    ?? null;
  // also try `ds._meta` direct
  let perLicense = perLicenseGraph;
  if (!perLicense && Array.isArray(ds._meta?.performanceByLicenseGraph)) {
    perLicense = ds._meta.performanceByLicenseGraph;
  }
  if (!Array.isArray(perLicense)) perLicense = [];
  const topLicense = perLicense
    .slice()
    .sort((a, b) => Number(b.leaksFoundPerKm || 0) - Number(a.leaksFoundPerKm || 0))
    .slice(0, 5);

  // Inline SVG timeline (responsive width)
  const svgW = 380, svgH = 80, pad = 18;
  const innerW = svgW - pad * 2, innerH = svgH - pad * 2;
  const barW   = Math.max(6, (innerW / Math.max(1, tlSeries.length)) - 4);
  const tlBars = tlSeries.map((v, i) => {
    const h = (v / tlMax) * innerH;
    const x = pad + i * (barW + 4);
    const y = svgH - pad - h;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="var(--cyan)" opacity="0.7" rx="1"/>
            <text x="${x + barW/2}" y="${svgH - 4}" text-anchor="middle" font-size="6" fill="var(--t3)" font-family="var(--mono)">${tlMonths[i] || ''}</text>`;
  }).join('');

  body.innerHTML = `
    <div class="ws-panel-section">
      <h4>12-Month Detection Timeline</h4>
      <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" preserveAspectRatio="none" role="img" aria-label="Monthly detection timeline">
        <line x1="${pad}" y1="${svgH-pad}" x2="${svgW-pad}" y2="${svgH-pad}" stroke="var(--border)"/>
        ${tlBars}
      </svg>
    </div>

    <div class="ws-panel-section">
      <h4>System KPIs</h4>
      <div class="ws-kpi-grid">
        ${sysIntel.slice(0, 8).map((k) => `
          <div class="ws-kpi">
            <div class="lbl">${esc(k.title)}</div>
            <div class="val" style="color:${esc(k.color || 'var(--t1)')}">${esc(k.val)}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${am ? `
      <div class="ws-panel-section">
        <h4>Asset Inventory (${esc(am.unit)})</h4>
        <div class="ws-kpi-grid">
          ${[
            ['Pipe', am.pipe], ['Hydrants', am.hydrant], ['Valves', am.valve],
            ['Service', am.service], ['Meters', am.meter], ['Cust. Fittings', am.customerFitting],
            ['Curbstops', am.curbstop], ['Cust. Side', am.customerSide],
          ].map(([l, v]) => `
            <div class="ws-kpi"><div class="lbl">${esc(l)}</div><div class="val">${esc(v)}</div></div>
          `).join('')}
        </div>
      </div>` : ''}

    <div class="ws-panel-section">
      <h4>Severity Histogram</h4>
      ${['high','medium','low'].map((s) => {
        const v = sev[s];
        const pct = (v / sevMax) * 100;
        const color = s === 'high' ? 'var(--red)' : s === 'medium' ? 'var(--amber)' : 'var(--blue)';
        return `
          <div class="ws-bar-row">
            <div class="ws-bar-lbl">${s}</div>
            <div class="ws-bar-track"><div class="ws-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <div class="ws-bar-val">${v}</div>
          </div>`;
      }).join('')}
    </div>

    ${topLicense.length ? `
      <div class="ws-panel-section">
        <h4>Top Licenses · Leaks per km</h4>
        ${topLicense.map((l) => {
          const v = Number(l.leaksFoundPerKm || 0);
          const max = Math.max(1, ...topLicense.map((x) => Number(x.leaksFoundPerKm || 0)));
          return `
            <div class="ws-bar-row">
              <div class="ws-bar-lbl" title="${esc(l.name)}">${esc(String(l.name).slice(0,8))}</div>
              <div class="ws-bar-track"><div class="ws-bar-fill" style="width:${(v/max)*100}%;background:var(--cyan)"></div></div>
              <div class="ws-bar-val">${v}</div>
            </div>`;
        }).join('')}
      </div>` : ''}
  `;
}

// ---------- ASSETS panel ----------------------------------------------------
function renderAssets(panel, ds) {
  const body  = panel.querySelector('[data-ws-body]');
  const links = ds._meta?.links || {};
  const assets = ds.assets || [];
  const sp = ds._meta?.sharepoint;
  const deliverables = sp?.files || sp?.deliverables || [];

  const linkRow = (label, url) => url
    ? `<div class="ws-row"><span class="k">${esc(label)}</span><span class="v"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open ↗</a></span></div>`
    : '';

  const statusClass = (s) => {
    if (!s) return '';
    const k = String(s).toLowerCase();
    if (k.includes('active') || k.includes('live') || k.includes('confirmed') || k.includes('avail')) return 'green';
    if (k.includes('pub') || k.includes('staged')) return 'blue';
    if (k.includes('bundle')) return 'amber';
    return '';
  };

  body.innerHTML = `
    <div class="ws-panel-section">
      <h4>Mission Assets</h4>
      ${assets.map((a) => `
        <div class="ws-row">
          <span class="k">${esc(a.label)}</span>
          <span class="v">${esc(a.value)} ${a.status ? `<span class="ws-status ${statusClass(a.status)}">${esc(a.status)}</span>` : ''}</span>
        </div>
      `).join('')}
    </div>

    <div class="ws-panel-section">
      <h4>External Links</h4>
      ${linkRow('Web Application', links.web_application)}
      ${linkRow('WMS Endpoint',    links.wms)}
      ${linkRow('GIS Files',        links.gis_files)}
      ${linkRow('Leak Sheets',      links.leaksheets_dataform)}
      ${!Object.keys(links).length ? `<div class="ws-empty">No external links published.</div>` : ''}
    </div>

    ${deliverables.length ? `
      <div class="ws-panel-section">
        <h4>SharePoint Deliverables (${deliverables.length})</h4>
        ${deliverables.map((f) => `
          <div class="ws-row">
            <span class="k" title="${esc(f.name)}">${esc(String(f.name).slice(0, 40))}</span>
            <span class="v">${esc(f.kind || '—')} · ${Number(f.bytes || 0).toLocaleString()} B</span>
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

// ---------- REPORTS panel ---------------------------------------------------
function buildSummaryHTML(ds) {
  const M = ds.mission || {};
  const hc = ds._heroCounts || {};
  const top = (ds.detections || [])
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10);
  const findings = (ds.findings || []).slice(0, 12);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(M.id || 'DR2')} — Summary</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 20px;color:#111;background:#fff;line-height:1.5}
  h1{font-size:22px;margin-bottom:4px} h2{font-size:14px;margin:18px 0 6px;color:#0a4} h3{font-size:12px;margin:12px 0 4px}
  .meta{color:#555;font-size:12px;margin-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 14px}
  .kpi{border:1px solid #ddd;border-radius:6px;padding:8px}
  .kpi .l{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.5px}
  .kpi .v{font-size:18px;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #e5e5e5;padding:4px 6px;text-align:left}
  th{background:#f6f6f6}
  ul{margin:0 0 8px 18px;padding:0}
  li{margin:2px 0;font-size:12px}
</style></head>
<body>
<h1>${esc(M.name || 'Mission')}</h1>
<div class="meta">${esc(M.sub || '')} · Mission ${esc(M.id || '')} · Commander ${esc(M.commander || '—')} · Generated ${new Date().toISOString()}</div>

<h2>Hero Counts</h2>
<div class="grid">
  <div class="kpi"><div class="l">Active Leaks</div><div class="v">${hc.active ?? '—'}</div></div>
  <div class="kpi"><div class="l">Repaired</div><div class="v">${hc.repaired ?? '—'}</div></div>
  <div class="kpi"><div class="l">Suspected POIs</div><div class="v">${hc.suspected ?? '—'}</div></div>
</div>

<h2>Key Findings</h2>
<ul>${findings.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>

<h2>Top Detections (by score)</h2>
<table>
  <thead><tr><th>ID</th><th>Type</th><th>Severity</th><th>Score</th><th>Location</th><th>Time</th></tr></thead>
  <tbody>${top.map((d) => `
    <tr><td>${esc(d.id)}</td><td>${esc(d.type)}</td><td>${esc(d.severity)}</td><td>${d.score|0}</td><td>${esc(d.location)}</td><td>${esc(d.time)}</td></tr>
  `).join('')}</tbody>
</table>
</body></html>`;
}

function detectionsToCSV(detections) {
  const header = ['id','type','severity','lat','lon','score','location','time'];
  const escCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const d of detections) {
    lines.push([d.id, d.type, d.severity, d.lat, d.lon, d.score, d.location, d.time].map(escCell).join(','));
  }
  return lines.join('\n');
}

function detectionsToGeoJSON(detections) {
  const features = detections
    .filter((d) => d.geom)
    .map((d) => ({
      type: 'Feature',
      properties: {
        id: d.id, name: d.name, type: d.type, severity: d.severity,
        score: d.score, location: d.location, time: d.time,
      },
      geometry: d.geom,
    }));
  return { type: 'FeatureCollection', features };
}

function renderReports(panel, ds) {
  const body = panel.querySelector('[data-ws-body]');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const det = ds.detections || [];

  body.innerHTML = `
    <div class="ws-panel-section">
      <h4>Generate Reports</h4>
      <button class="ws-btn" type="button" data-act="html"><span class="ico">ðŸ“„</span>DR2 Summary (HTML)<span class="meta">.html</span></button>
      <button class="ws-btn" type="button" data-act="json"><span class="ico">{ }</span>Detections (JSON)<span class="meta">${det.length} rows</span></button>
      <button class="ws-btn" type="button" data-act="csv"><span class="ico">▦</span>Detections (CSV)<span class="meta">${det.length} rows</span></button>
      <button class="ws-btn" type="button" data-act="geojson"><span class="ico">⬢</span>POI Geometry (GeoJSON)<span class="meta">${det.filter((d)=>d.geom).length} feats</span></button>
    </div>
    <div class="ws-panel-section">
      <h4>Status</h4>
      <div class="ws-row"><span class="k">Detections</span><span class="v">${det.length}</span></div>
      <div class="ws-row"><span class="k">With geometry</span><span class="v">${det.filter((d)=>d.geom).length}</span></div>
      <div class="ws-row"><span class="k">Mission</span><span class="v">${esc(ds.mission?.id || '—')}</span></div>
      <div class="ws-row"><span class="k">Captured</span><span class="v">${esc(ds._meta?.capturedAt || '—')}</span></div>
    </div>
  `;

  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      try {
        if (act === 'html') {
          downloadBlob(`rwr-summary-${stamp}.html`, 'text/html;charset=utf-8', buildSummaryHTML(ds));
        } else if (act === 'json') {
          downloadBlob(`rwr-detections-${stamp}.json`, 'application/json', JSON.stringify(det, null, 2));
        } else if (act === 'csv') {
          downloadBlob(`rwr-detections-${stamp}.csv`, 'text/csv;charset=utf-8', detectionsToCSV(det));
        } else if (act === 'geojson') {
          downloadBlob(`rwr-poi-geometry-${stamp}.geojson`, 'application/geo+json',
            JSON.stringify(detectionsToGeoJSON(det), null, 2));
        }
      } catch (e) {
        console.error('[reports] export failed:', e);
        alert('Export failed: ' + (e?.message || String(e)));
      }
    });
  });
}

// ---------- SETTINGS panel --------------------------------------------------
function renderSettings(panel, ds, host) {
  const body = panel.querySelector('[data-ws-body]');
  const env  = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const sourceEnv = env.VITE_DATA_SOURCE || 'bundled';

  const defaults = {
    source:    sourceEnv,                   // 'bundled' | 'api' (informational)
    units:     'metric',                    // 'metric' | 'imperial'
    refreshSec: 30,
    theme:      'dark',                     // 'dark' | 'light' | 'auto'
  };
  const settings = { ...defaults, ...loadSettings() };

  const draw = () => {
    body.innerHTML = `
      <div class="ws-panel-section">
        <h4>Data Source</h4>
        <div class="ws-form-row">
          <label>Use live API
            <span class="hint">data source = ${esc(sourceEnv)} (build-time)</span>
          </label>
          <button class="ws-toggle ${settings.source === 'api' ? 'on' : ''}" data-toggle="source" type="button" aria-pressed="${settings.source === 'api'}"></button>
        </div>
      </div>

      <div class="ws-panel-section">
        <h4>Display</h4>
        <div class="ws-form-row">
          <label>Units (metric / imperial)</label>
          <button class="ws-toggle ${settings.units === 'imperial' ? 'on' : ''}" data-toggle="units" type="button" aria-pressed="${settings.units === 'imperial'}"></button>
        </div>
        <div class="ws-form-row">
          <label>Refresh interval (sec)</label>
          <input class="ws-input" type="number" min="5" max="3600" step="5" value="${settings.refreshSec}" data-input="refreshSec">
        </div>
        <div class="ws-form-row">
          <label>Theme</label>
          <select class="ws-select" data-input="theme">
            <option value="dark"${settings.theme==='dark'?' selected':''}>Dark</option>
            <option value="light"${settings.theme==='light'?' selected':''}>Light</option>
            <option value="auto"${settings.theme==='auto'?' selected':''}>Auto</option>
          </select>
        </div>
      </div>

      <div class="ws-panel-section">
        <h4>Viewport</h4>
        <button class="ws-btn" type="button" data-act="reset"><span class="ico">âŸ²</span>Reset View<span class="meta">home</span></button>
      </div>

      <div class="ws-panel-section">
        <h4>Storage</h4>
        <div class="ws-row"><span class="k">localStorage key</span><span class="v">${STORAGE_KEY}</span></div>
        <button class="ws-btn" type="button" data-act="clear"><span class="ico">ðŸ—‘</span>Clear saved settings<span class="meta">reset</span></button>
      </div>
    `;

    body.querySelectorAll('[data-toggle]').forEach((t) => {
      t.addEventListener('click', () => {
        const key = t.dataset.toggle;
        if (key === 'source') settings.source = settings.source === 'api' ? 'bundled' : 'api';
        if (key === 'units')  settings.units  = settings.units  === 'imperial' ? 'metric' : 'imperial';
        saveSettings(settings); draw();
      });
    });
    body.querySelectorAll('[data-input]').forEach((i) => {
      i.addEventListener('change', () => {
        const k = i.dataset.input;
        settings[k] = i.type === 'number' ? Number(i.value) : i.value;
        saveSettings(settings);
      });
    });
    body.querySelector('[data-act="reset"]').addEventListener('click', () => {
      const v = ds._viewport || {};
      try { host?.flyTo?.({ lat: v.lat, lon: v.lon, zoom: v.zoom || 12 }); } catch {}
      try { host?.resetView?.(); } catch {}
    });
    body.querySelector('[data-act="clear"]').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      Object.assign(settings, defaults);
      saveSettings(settings); draw();
    });
  };
  draw();
}

// ---------- mount -----------------------------------------------------------
export function mountWorkspaceTabs({ ds, host } = {}) {
  if (!ds) {
    console.warn('[workspace-tabs] mounted without ds');
    return { open() {}, close() {}, destroy() {} };
  }
  injectStyles();

  // Build all panels (lazy render — content drawn on first open)
  const panelDefs = [
    { id: 'detections', title: 'Detections', sub: `${(ds.detections||[]).length} total` },
    { id: 'analytics',  title: 'Analytics',  sub: 'KPIs · timeline · histogram' },
    { id: 'assets',     title: 'Assets',     sub: 'links · deliverables' },
    { id: 'reports',    title: 'Reports',    sub: 'export · download' },
    { id: 'settings',   title: 'Settings',   sub: 'preferences · viewport' },
  ];
  const rendered = new Set();
  const renderers = {
    detections: (p) => renderDetections(p, ds, host),
    analytics:  (p) => renderAnalytics(p, ds),
    assets:     (p) => renderAssets(p, ds),
    reports:    (p) => renderReports(p, ds),
    settings:   (p) => renderSettings(p, ds, host),
  };
  panelDefs.forEach((d) => createPanel(d.id, d.title, d.sub));

  const openTab = (tabId) => {
    setActiveTab(tabId);
    if (tabId === 'overview') {
      closeAllPanels();
      return;
    }
    // Close any lock-row slide panel that the dashboard exposes
    try { window.closeSlide?.(); } catch {}
    const panel = document.getElementById(PANEL_PREFIX + tabId);
    if (!panel) return;
    if (!rendered.has(tabId)) {
      renderers[tabId]?.(panel);
      rendered.add(tabId);
    } else if (tabId === 'detections') {
      // Always re-render detections so latest DS is reflected
      renderers.detections(panel);
    }
    openPanel(tabId);
    document.dispatchEvent(new CustomEvent('workspace:open', { detail: { tab: tabId } }));
  };

  // Wire nav-tab clicks
  const tabs = $$('.nav-tab[data-tab]');
  const tabHandler = (ev) => {
    const t = ev.currentTarget;
    const id = t.getAttribute('data-tab');
    if (id) openTab(id);
  };
  tabs.forEach((t) => t.addEventListener('click', tabHandler));

  // Listen for cross-component requests (e.g. from header-controls)
  const externalOpen = (ev) => {
    const id = ev?.detail?.tab;
    if (id) openTab(id);
  };
  document.addEventListener('workspace:open-request', externalOpen);

  // Esc closes any panel
  const esc = (ev) => {
    if (ev.key === 'Escape' && document.querySelector('.ws-panel.open')) {
      closeAllPanels();
      setActiveTab('overview');
    }
  };
  document.addEventListener('keydown', esc);

  return {
    open: openTab,
    close: () => { closeAllPanels(); setActiveTab('overview'); },
    destroy: () => {
      tabs.forEach((t) => t.removeEventListener('click', tabHandler));
      document.removeEventListener('workspace:open-request', externalOpen);
      document.removeEventListener('keydown', esc);
      panelDefs.forEach((d) => document.getElementById(PANEL_PREFIX + d.id)?.remove());
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}

export default mountWorkspaceTabs;
