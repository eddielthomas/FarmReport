// =============================================================================
// harvest-refresh.js
// -----------------------------------------------------------------------------
// Wires the "Refresh Harvest" button + sliding progress bar in the Layer Stack
// panel. Talks to the MVP API at /api/harvest/refresh + SSE follow-up at
// /api/harvest/jobs/:jobId/events. NDJSON per-stage events drive both the bar
// width and the human-readable status label.
//
// Stages emitted by services/ingest-service/src/rwr_ingest/orchestrator/refresh.py:
//   1. discover  — list binaries
//   2. kmz       — Demoville KMZ → poi-attrs.json
//   3. shp       — Demoville SHP → poi-geometry.geojson
//   4. xlsx      — Demoville RI_List → inspections.json
//   5. giscloud  — pipe-network REST pull → pipes.geojson (fail-soft)
//   6. publish   — refresh-manifest.json
//
// On `harvest.complete` we call `engineHost.refreshHarvestLayers?.()` so the
// engine can re-fetch its derived JSON. The engine method is optional; if
// absent we just unlock the button and surface a toast.
// =============================================================================

const STYLE_ID = 'rwr-harvest-refresh-style';

/** Default API base — matches mvp/api/server.mjs. */
const DEFAULT_BASE = '/';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
  #harvestRefreshSection{padding:8px 10px;border-bottom:1px solid var(--border);}
  #harvestRefreshSection .sec-label{display:flex;align-items:center;gap:6px;
    font-size:7px;color:var(--t3);text-transform:uppercase;letter-spacing:1.2px;
    font-weight:700;margin-bottom:6px;}
  #harvestRefreshSection .sec-label .dot{width:5px;height:5px;border-radius:50%;
    background:var(--t3);transition:background .25s,box-shadow .25s;}
  #harvestRefreshSection.is-running .sec-label .dot{
    background:var(--cyan);box-shadow:0 0 6px rgba(0,229,255,.7);
    animation:hr-pulse 1.4s ease-in-out infinite;}
  #harvestRefreshSection.is-error .sec-label .dot{background:var(--amber);box-shadow:0 0 6px rgba(255,178,36,.7);}
  #harvestRefreshSection.is-done .sec-label .dot{background:var(--green);box-shadow:0 0 6px rgba(0,200,140,.6);}
  @keyframes hr-pulse{0%,100%{opacity:1;}50%{opacity:.45;}}

  #btnRefreshHarvest{width:100%;padding:6px 8px;border-radius:5px;
    border:1px solid var(--border);background:rgba(0,200,255,0.06);color:var(--t1);
    font-size:8px;font-weight:700;font-family:var(--sans);cursor:pointer;
    transition:border-color .2s,background .2s,color .2s;
    text-transform:uppercase;letter-spacing:.6px;
    display:flex;align-items:center;justify-content:center;gap:6px;}
  #btnRefreshHarvest:hover:not(:disabled){border-color:var(--cyan);color:var(--cyan);
    background:rgba(0,200,255,0.10);}
  #btnRefreshHarvest:disabled{opacity:.7;cursor:progress;}
  #btnRefreshHarvest .icon{font-size:10px;line-height:1;}
  #btnRefreshHarvest.is-running .icon{animation:hr-spin 1.2s linear infinite;}
  @keyframes hr-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

  #harvestProgressTrack{width:100%;height:4px;background:rgba(255,255,255,0.06);
    border-radius:2px;overflow:hidden;margin-top:6px;position:relative;}
  #harvestProgressFill{height:100%;width:0%;
    background:linear-gradient(90deg,var(--cyan),#00ff9d);
    box-shadow:0 0 8px rgba(0,229,255,.5);
    transition:width .35s ease-out;}
  #harvestProgressFill.is-error{background:linear-gradient(90deg,var(--amber),#ff7a00);
    box-shadow:0 0 8px rgba(255,178,36,.5);}
  #harvestProgressFill.is-done{background:linear-gradient(90deg,#00ff9d,var(--green));
    box-shadow:0 0 8px rgba(0,200,140,.5);}

  #harvestStatusRow{display:flex;justify-content:space-between;align-items:center;
    margin-top:5px;font-family:var(--mono);font-size:7px;color:var(--t3);
    letter-spacing:.5px;text-transform:uppercase;}
  #harvestStatusRow .stage{color:var(--t2);font-weight:700;}
  #harvestStatusRow .pct{color:var(--cyan);}
  #harvestRefreshSection.is-error #harvestStatusRow .pct{color:var(--amber);}
  #harvestRefreshSection.is-done #harvestStatusRow .pct{color:var(--green);}

  #harvestStatusMsg{margin-top:3px;font-size:7px;color:var(--t3);
    line-height:1.3;min-height:9px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  `;
  document.head.appendChild(s);
}

/* ----------------------------- markup ------------------------------------ */

/**
 * Builds the refresh button + progress bar block. Inserts after the Layer
 * Stack section so it lives at the bottom of the layer panel column.
 *
 * @param {HTMLElement} layerSection - the existing `.left-section` that
 *   contains `#layerStack`. The new block is inserted right after it.
 */
function mountSection(layerSection) {
  if (document.getElementById('harvestRefreshSection')) {
    return document.getElementById('harvestRefreshSection');
  }
  const section = document.createElement('div');
  section.id = 'harvestRefreshSection';
  section.className = 'left-section';
  section.innerHTML = `
    <div class="sec-label"><span class="dot"></span><span>Harvest Pipeline</span></div>
    <button id="btnRefreshHarvest" type="button" title="Re-run the full harvest pipeline">
      <span class="icon">⟳</span><span class="label">Refresh Harvest</span>
    </button>
    <div id="harvestProgressTrack"><div id="harvestProgressFill"></div></div>
    <div id="harvestStatusRow">
      <span class="stage" id="harvestStageLabel">Idle</span>
      <span class="pct" id="harvestPctLabel">—</span>
    </div>
    <div id="harvestStatusMsg" id="harvestMsg"></div>
  `;
  layerSection.parentNode.insertBefore(section, layerSection.nextSibling);
  return section;
}

/* ----------------------------- pretty stage names ------------------------ */

const STAGE_LABELS = {
  discover: 'Discovering binaries',
  kmz:      'Parsing KMZ',
  shp:      'Parsing shapefile',
  xlsx:     'Parsing inspections',
  giscloud: 'GIS Cloud sync',
  publish:  'Publishing manifest',
};

/* ----------------------------- main wire-up ------------------------------ */

/**
 * Mount the Refresh Harvest control under the Layer Stack section.
 *
 * @param {object} opts
 * @param {string} [opts.layerSectionSelector='.left-section'] — a CSS selector
 *   identifying the Layer Stack container. The first match that contains
 *   `#layerStack` wins.
 * @param {string} [opts.apiBase='/'] — base URL for /api/harvest/* endpoints.
 *   Pass an absolute URL when the dashboard is served by Vite on a different
 *   port than the API server.
 * @param {object} [opts.engineHost] — optional engineHost reference; if it
 *   exposes `refreshHarvestLayers()` we call it after a successful run.
 * @param {(text: string) => void} [opts.toast] — optional toast helper.
 */
export function mountHarvestRefresh({
  layerSectionSelector = '.left-section',
  apiBase = DEFAULT_BASE,
  engineHost = null,
  toast = null,
} = {}) {
  injectStyles();

  // Find the Layer Stack section: the first .left-section that owns #layerStack.
  const candidates = document.querySelectorAll(layerSectionSelector);
  let layerSection = null;
  for (const el of candidates) {
    if (el.querySelector('#layerStack')) { layerSection = el; break; }
  }
  if (!layerSection) {
    console.warn('[harvest-refresh] no .left-section with #layerStack found — skipping mount');
    return null;
  }

  const section = mountSection(layerSection);
  const btn   = section.querySelector('#btnRefreshHarvest');
  const fill  = section.querySelector('#harvestProgressFill');
  const stage = section.querySelector('#harvestStageLabel');
  const pct   = section.querySelector('#harvestPctLabel');
  const msg   = section.querySelector('#harvestStatusMsg');

  let busy = false;
  let currentStream = null;

  const setState = (state) => {
    section.classList.remove('is-running', 'is-error', 'is-done');
    fill.classList.remove('is-error', 'is-done');
    if (state) {
      section.classList.add(`is-${state}`);
      if (state === 'error' || state === 'done') fill.classList.add(`is-${state}`);
    }
    btn.classList.toggle('is-running', state === 'running');
    btn.disabled = state === 'running';
    btn.querySelector('.label').textContent =
      state === 'running' ? 'Refreshing…' :
      state === 'error'   ? 'Refresh Harvest' :
                            'Refresh Harvest';
  };

  const reset = () => {
    setState(null);
    fill.style.width = '0%';
    stage.textContent = 'Idle';
    pct.textContent = '—';
    msg.textContent = '';
  };

  const onProgress = (data) => {
    if (typeof data?.pct === 'number') {
      fill.style.width = `${Math.max(0, Math.min(100, data.pct))}%`;
      pct.textContent = `${data.pct}%`;
    }
    if (data?.stage) {
      stage.textContent = STAGE_LABELS[data.stage] ?? data.stage;
    }
    if (data?.message) msg.textContent = data.message;
    if (data?.status === 'error') {
      // Mid-stage error — keep going, but flag the section so the operator
      // sees the amber tint without blocking the rest of the run.
      section.classList.add('is-error');
      fill.classList.add('is-error');
    }
  };

  const onComplete = (data) => {
    setState('done');
    fill.style.width = '100%';
    pct.textContent = '100%';
    stage.textContent = 'Complete';
    const dur = Math.max(0, Math.round((data?.duration_ms ?? 0) / 100) / 10);
    const summary = data?.summary ?? {};
    const counts = Object.entries(summary)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ');
    msg.textContent = `Done in ${dur}s${counts ? ' — ' + counts : ''}`;
    busy = false;

    // Best-effort: ask the engine to re-fetch its derived layers. We pass
    // the same apiBase the feature was mounted with so the engine host
    // hits the right port (the dashboard runs on Vite/5181, the API on
    // 5180 — apiBase here is already that 5180 origin).
    try {
      const p = engineHost?.refreshHarvestLayers?.({ apiBase });
      if (p && typeof p.then === 'function') {
        p.catch((err) => console.warn('[harvest-refresh] engine refresh failed', err));
      }
    } catch (_) { /* ignore */ }
    try { toast?.(`Harvest refreshed (${dur}s)`); } catch (_) { /* ignore */ }
  };

  const onError = (data) => {
    setState('error');
    fill.style.width = '100%';
    pct.textContent = 'ERR';
    stage.textContent = 'Error';
    msg.textContent = data?.message ?? 'orchestrator failed';
    busy = false;
    try { toast?.(`Harvest failed: ${data?.message ?? 'unknown'}`); } catch (_) { /* ignore */ }
  };

  const closeStream = () => {
    if (currentStream) {
      try { currentStream.close(); } catch (_) { /* ignore */ }
      currentStream = null;
    }
  };

  async function trigger() {
    if (busy) return;
    busy = true;
    setState('running');
    fill.style.width = '0%';
    pct.textContent = '0%';
    stage.textContent = 'Spawning';
    msg.textContent = '';

    let jobId;
    const refreshUrl = `${apiBase.replace(/\/+$/, '')}/api/harvest/refresh`;
    try {
      const resp = await fetch(refreshUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!resp.ok) throw new Error(`POST ${refreshUrl} → ${resp.status}`);
      const body = await resp.json();
      jobId = body?.jobId;
      if (!jobId) throw new Error('no jobId in response');
    } catch (err) {
      // Network errors come through as TypeError: Failed to fetch — surface
      // the actual URL we tried so the operator can tell whether the API
      // server is down vs CORS vs wrong base.
      const detail = String(err?.message ?? err);
      const hint = detail.includes('Failed to fetch')
        ? `cannot reach ${refreshUrl} — is the API on :5180 running?`
        : detail;
      console.error('[harvest-refresh]', detail, refreshUrl);
      onError({ message: hint });
      return;
    }

    closeStream();
    const url = `${apiBase.replace(/\/+$/, '')}/api/harvest/jobs/${encodeURIComponent(jobId)}/events`;
    const es = new EventSource(url);
    currentStream = es;

    es.addEventListener('harvest.progress', (ev) => {
      try { onProgress(JSON.parse(ev.data)); } catch (_) { /* ignore */ }
    });
    es.addEventListener('harvest.complete', (ev) => {
      try { onComplete(JSON.parse(ev.data)); } catch (_) { onComplete(null); }
      closeStream();
    });
    es.addEventListener('harvest.error', (ev) => {
      try { onError(JSON.parse(ev.data)); } catch (_) { onError(null); }
      closeStream();
    });
    es.onerror = () => {
      // Browser fires onerror on normal close too; only treat as failure
      // while we still consider ourselves busy.
      if (busy) {
        onError({ message: 'connection lost — server stopped streaming' });
        closeStream();
      }
    };
  }

  btn.addEventListener('click', () => { void trigger(); });
  reset();

  return { trigger, reset };
}
