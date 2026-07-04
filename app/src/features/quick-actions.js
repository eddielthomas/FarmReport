// =============================================================================
// quick-actions.js
// Wires the four "Quick Actions" buttons (DS.actions) rendered into #actions.
// Also exports `qaToast(text)` — a tiny shared transient toast helper used by
// the other feature modules.
// =============================================================================

const STYLE_ID = 'rwr-qa-style';
const TOAST_ID = 'rwr-qa-toast-host';

/* ----------------------------- styles ------------------------------------ */
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
  .qa-modal-back{position:fixed;inset:0;background:rgba(2,4,8,.62);backdrop-filter:blur(4px);
    z-index:9999;display:flex;align-items:center;justify-content:center;font-family:var(--sans);}
  .qa-modal{background:linear-gradient(180deg,var(--bg2),var(--bg1));border:1px solid var(--bg4);
    border-radius:6px;min-width:420px;max-width:760px;max-height:84vh;display:flex;flex-direction:column;
    box-shadow:0 18px 60px rgba(0,0,0,.7),0 0 0 1px rgba(0,212,255,.06);overflow:hidden;color:var(--t1);}
  .qa-modal-head{display:flex;align-items:center;gap:10px;padding:10px 14px;
    border-bottom:1px solid var(--bg4);background:var(--bg1);}
  .qa-modal-title{font-size:10px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:var(--cyan);}
  .qa-modal-spacer{flex:1;}
  .qa-modal-x{background:transparent;border:1px solid var(--bg4);color:var(--t2);padding:2px 8px;
    font-size:11px;cursor:pointer;border-radius:3px;}
  .qa-modal-x:hover{color:var(--red);border-color:var(--red);}
  .qa-modal-body{padding:14px;overflow:auto;font-size:11px;color:var(--t1);}
  .qa-modal-foot{padding:10px 14px;border-top:1px solid var(--bg4);display:flex;justify-content:flex-end;gap:8px;background:var(--bg1);}
  .qa-row{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
  .qa-row label{font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--t3);}
  .qa-input,.qa-select,.qa-textarea{background:var(--bg);border:1px solid var(--bg4);color:var(--t1);
    padding:6px 8px;font-family:var(--mono);font-size:11px;border-radius:3px;outline:none;}
  .qa-input:focus,.qa-select:focus,.qa-textarea:focus{border-color:var(--cyan);}
  .qa-textarea{min-height:64px;resize:vertical;font-family:var(--sans);}
  .qa-btn{background:var(--bg3);border:1px solid var(--bg4);color:var(--t1);padding:6px 14px;
    font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;border-radius:3px;}
  .qa-btn:hover{border-color:var(--cyan);color:var(--cyan);}
  .qa-btn-primary{background:linear-gradient(180deg,var(--cyan),var(--blue));color:var(--bg);border-color:transparent;}
  .qa-btn-primary:hover{filter:brightness(1.1);color:var(--bg);}
  .qa-kv-grid{display:grid;grid-template-columns:160px 1fr;gap:4px 12px;font-family:var(--mono);font-size:10px;}
  .qa-kv-grid dt{color:var(--t3);text-transform:uppercase;font-size:8px;letter-spacing:1px;font-weight:700;}
  .qa-kv-grid dd{color:var(--t1);margin:0;word-break:break-all;}
  .qa-leak-card{border:1px solid var(--bg4);border-radius:4px;padding:10px;margin-bottom:10px;background:var(--bg1);}
  .qa-leak-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--bg4);}
  .qa-leak-id{font-family:var(--mono);font-size:11px;font-weight:800;color:var(--red);letter-spacing:.5px;}
  .qa-leak-tag{font-size:8px;padding:2px 6px;border:1px solid var(--bg4);border-radius:2px;color:var(--t2);
    text-transform:uppercase;letter-spacing:1px;}
  .qa-toggle-raw{margin-top:8px;font-size:8px;color:var(--cyan);background:transparent;border:none;cursor:pointer;
    text-transform:uppercase;letter-spacing:1.2px;font-weight:700;padding:0;}
  .qa-raw{display:none;margin-top:6px;background:var(--bg);border:1px solid var(--bg4);padding:8px;
    font-family:var(--mono);font-size:9.5px;color:var(--t2);white-space:pre-wrap;max-height:280px;overflow:auto;border-radius:3px;}
  .qa-raw.on{display:block;}
  .qa-empty{padding:24px;text-align:center;color:var(--t3);font-size:11px;}
  .qa-empty a{color:var(--cyan);text-decoration:none;}
  .qa-empty a:hover{text-decoration:underline;}

  #${TOAST_ID}{position:fixed;right:18px;bottom:64px;display:flex;flex-direction:column;gap:6px;
    z-index:10000;pointer-events:none;font-family:var(--sans);}
  .qa-toast{background:linear-gradient(180deg,var(--bg2),var(--bg1));border:1px solid var(--cyan);
    color:var(--t1);font-size:10px;padding:8px 14px;border-radius:3px;font-weight:600;letter-spacing:.4px;
    box-shadow:0 6px 20px rgba(0,212,255,.18),0 0 0 1px rgba(0,212,255,.08);
    animation:qaToastIn .18s ease-out;max-width:340px;pointer-events:auto;}
  .qa-toast.bye{animation:qaToastOut .22s ease-in forwards;}
  @keyframes qaToastIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  @keyframes qaToastOut{to{opacity:0;transform:translateY(8px);}}
  `;
  document.head.appendChild(s);
}

/* ----------------------------- toast ------------------------------------- */
export function qaToast(text, ms = 3000) {
  injectStyles();
  let host = document.getElementById(TOAST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = TOAST_ID;
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'qa-toast';
  el.textContent = text;
  host.appendChild(el);
  const t = setTimeout(() => {
    el.classList.add('bye');
    setTimeout(() => el.remove(), 240);
  }, ms);
  return () => { clearTimeout(t); el.remove(); };
}

/* ----------------------------- modal ------------------------------------- */
function buildModal({ title, body, footer }) {
  injectStyles();
  const back = document.createElement('div');
  back.className = 'qa-modal-back';
  const modal = document.createElement('div');
  modal.className = 'qa-modal';
  modal.innerHTML = `
    <div class="qa-modal-head">
      <div class="qa-modal-title">${title}</div>
      <div class="qa-modal-spacer"></div>
      <button class="qa-modal-x" type="button">CLOSE</button>
    </div>
    <div class="qa-modal-body"></div>
    <div class="qa-modal-foot"></div>
  `;
  back.appendChild(modal);
  const bodyEl   = modal.querySelector('.qa-modal-body');
  const footEl   = modal.querySelector('.qa-modal-foot');
  if (body   instanceof Node) bodyEl.appendChild(body);
  else if (typeof body === 'string') bodyEl.innerHTML = body;
  if (footer instanceof Node) footEl.appendChild(footer);
  const close = () => back.remove();
  modal.querySelector('.qa-modal-x').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  return { back, modal, bodyEl, footEl, close };
}

/* ----------------------------- escape helpers ---------------------------- */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtDate = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const fnameDate = (d = new Date()) => d.toISOString().slice(0, 10);

/* ----------------------------- handlers ---------------------------------- */
const dispatchedCrews = [];

function actionDispatchCrew() {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="qa-row">
      <label>Crew</label>
      <select class="qa-select" id="qaCrew">
        <option value="Demoville1">Demoville1</option>
        <option value="Demoville2">Demoville2</option>
        <option value="Demoville3">Demoville3</option>
      </select>
    </div>
    <div class="qa-row">
      <label>Priority</label>
      <select class="qa-select" id="qaPriority">
        <option value="P1">P1 — immediate</option>
        <option value="P2" selected>P2 — same-day</option>
        <option value="P3">P3 — scheduled</option>
      </select>
    </div>
    <div class="qa-row">
      <label>Notes</label>
      <textarea class="qa-textarea" id="qaNotes" placeholder="Briefing for crew…"></textarea>
    </div>
  `;
  const submit = document.createElement('button');
  submit.className = 'qa-btn qa-btn-primary';
  submit.textContent = 'Dispatch';
  const cancel = document.createElement('button');
  cancel.className = 'qa-btn';
  cancel.textContent = 'Cancel';
  const foot = document.createDocumentFragment();
  foot.appendChild(cancel); foot.appendChild(submit);
  const { close } = buildModal({ title: 'Dispatch Leak Crew', body: form, footer: foot });
  cancel.addEventListener('click', close);
  submit.addEventListener('click', () => {
    const data = {
      crew:     form.querySelector('#qaCrew').value,
      priority: form.querySelector('#qaPriority').value,
      notes:    form.querySelector('#qaNotes').value.trim(),
      ts:       new Date().toISOString(),
    };
    dispatchedCrews.push(data);
    window.dispatchEvent(new CustomEvent('crew:dispatched', { detail: data }));
    qaToast('Crew dispatched ✓');
    close();
  });
}

function renderLeakCard(d) {
  const card = document.createElement('div');
  card.className = 'qa-leak-card';
  const detail = d._detail || {};
  const row = detail.row || {};
  const flat = {
    'Detection ID':    d.id,
    'Name':            d.name,
    'Location':        d.location,
    'Lat / Lon':       `${d.lat?.toFixed?.(5) ?? '—'}, ${d.lon?.toFixed?.(5) ?? '—'}`,
    'Time':            d.time,
    'Score':           d.score,
    'Confidence':      `${d.confidence}%`,
    'Status':          d.status,
    'Pipe material':   d.evidence?.spectral,
    'Visibility':      d.evidence?.thermal,
    'Crew':            d.evidence?.ndvi,
    'OGC FID':         d.evidence?.sar,
    'Repaired':        row.repaired ? 'Yes' : 'No',
    'Verification':    row.verification_result,
    'Leak type':       row.leak_type,
    'Comments':        row.comments || d._comments,
    'Finding ID':      d._finding,
  };
  let dl = '<dl class="qa-kv-grid">';
  for (const [k, v] of Object.entries(flat)) {
    if (v == null || v === '') continue;
    dl += `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  }
  dl += '</dl>';
  card.innerHTML = `
    <div class="qa-leak-head">
      <div class="qa-leak-id">${esc(d.id)}</div>
      <div class="qa-leak-tag">${esc(d.status || '—')}</div>
      <div class="qa-leak-tag">${esc(d.severity || '—')}</div>
    </div>
    ${dl}
    <button class="qa-toggle-raw" type="button">View raw JSON</button>
    <pre class="qa-raw">${esc(JSON.stringify(detail, null, 2))}</pre>
  `;
  card.querySelector('.qa-toggle-raw').addEventListener('click', (e) => {
    const pre = card.querySelector('.qa-raw');
    pre.classList.toggle('on');
    e.currentTarget.textContent = pre.classList.contains('on') ? 'Hide raw JSON' : 'View raw JSON';
  });
  return card;
}

function actionOpenLeakSheet(ds) {
  const leaks = (ds.detections || []).filter((d) => typeof d.id === 'string' && d.id.startsWith('LEAK-'));
  const body = document.createElement('div');
  if (leaks.length === 0) {
    const link = ds?._meta?.links?.web_application;
    body.innerHTML = `
      <div class="qa-empty">
        No verified leaks in this Data Release.<br>
        ${link ? `Browse them in <a href="${esc(link)}" target="_blank" rel="noopener">GIS Cloud ↗</a>.` : ''}
      </div>`;
  } else {
    leaks.forEach((d) => body.appendChild(renderLeakCard(d)));
  }
  buildModal({ title: `Leak Sheet — ${leaks.length} verified`, body });
}

function actionOpenGisCloud(ds) {
  const url = ds?._meta?.links?.web_application;
  if (!url) {
    qaToast('GIS Cloud link unavailable');
    return;
  }
  window.open(url, '_blank', 'noopener');
  qaToast('Opening GIS Cloud ↗');
}

function buildReportHtml(ds) {
  const m   = ds.mission     || {};
  const hc  = ds._heroCounts || {};
  const am  = ds._assetMetrics;
  const det = (ds.detections || []).slice(0, 10);
  const ts  = new Date();
  const css = `
    body{font-family:'Inter',Arial,sans-serif;background:#0a1020;color:#e4eaf4;padding:32px;line-height:1.5;}
    h1{color:#00d4ff;font-size:22px;letter-spacing:2px;text-transform:uppercase;margin:0 0 4px;}
    h2{color:#00d4ff;font-size:13px;letter-spacing:1.6px;text-transform:uppercase;
       border-bottom:1px solid #1f2a44;padding-bottom:6px;margin:28px 0 12px;}
    .sub{color:#8094b4;font-size:12px;margin-bottom:24px;}
    table{width:100%;border-collapse:collapse;font-size:11px;}
    th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1f2a44;}
    th{color:#8094b4;text-transform:uppercase;letter-spacing:1px;font-size:9px;font-weight:700;}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
    .kpi{background:#0e1628;border:1px solid #1f2a44;border-radius:4px;padding:10px;}
    .kpi-l{font-size:9px;color:#8094b4;text-transform:uppercase;letter-spacing:1px;}
    .kpi-v{font-size:18px;color:#00d4ff;font-weight:700;font-family:'JetBrains Mono',monospace;margin-top:2px;}
    .foot{margin-top:36px;color:#4a6080;font-size:10px;text-align:center;}
    ul{padding-left:18px;} li{margin-bottom:4px;}
    .pill{display:inline-block;padding:2px 6px;border:1px solid #1f2a44;border-radius:2px;
          font-size:9px;color:#8094b4;text-transform:uppercase;letter-spacing:1px;margin-right:4px;}
    .red{color:#ff4060;} .amber{color:#ffb020;} .green{color:#00e68a;}
  `;
  const rows = det.map((d) => `
    <tr>
      <td><b>${esc(d.id)}</b></td>
      <td>${esc(d.severity)}</td>
      <td>${esc(d.score)}</td>
      <td>${esc(d.location)}</td>
      <td>${esc(d.time)}</td>
    </tr>`).join('');
  const sysIntelGrid = (ds.sysIntel || []).map((k) => `
    <div class="kpi"><div class="kpi-l">${esc(k.title)}</div><div class="kpi-v">${esc(k.val)}</div></div>
  `).join('');
  const assetBlock = am ? `
    <table>
      <tr><th>Asset</th><th>Value (${esc(am.unit)})</th></tr>
      <tr><td>Pipe</td><td>${esc(am.pipe)}</td></tr>
      <tr><td>Hydrant</td><td>${esc(am.hydrant)}</td></tr>
      <tr><td>Valve</td><td>${esc(am.valve)}</td></tr>
      <tr><td>Service</td><td>${esc(am.service)}</td></tr>
      <tr><td>Meter</td><td>${esc(am.meter)}</td></tr>
      <tr><td>Customer fitting</td><td>${esc(am.customerFitting)}</td></tr>
      <tr><td>Curbstop</td><td>${esc(am.curbstop)}</td></tr>
      <tr><td>Customer side</td><td>${esc(am.customerSide)}</td></tr>
    </table>
  ` : `<p class="sub">No asset metrics available.</p>`;
  const findings = (ds.findings || []).map((f) =>
    `<li>${esc(typeof f === 'string' ? f : f.text || JSON.stringify(f))}</li>`).join('');
  const aiRecs = (ds.aiRecs || []).map((r) =>
    `<li><b>${esc(r.title)}</b> — ${esc(r.text)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>RWR DR2 Report — ${esc(m.id || '')}</title>
<style>${css}</style></head><body>
  <h1>${esc(m.name || 'RWR Mission Report')}</h1>
  <div class="sub">${esc(m.sub || '')} · <span class="pill">${esc(m.status || '')}</span><span class="pill">${esc(m.priority || '')}</span></div>

  <h2>Mission Brief</h2>
  <p>${esc(m.objective || '')}</p>
  <table>
    <tr><th>Mission ID</th><td>${esc(m.id)}</td><th>Commander</th><td>${esc(m.commander)}</td></tr>
    <tr><th>Start</th><td>${esc(m.start)}</td><th>Quality</th><td>${esc(m.quality)}</td></tr>
    <tr><th>Coverage</th><td colspan="3">${esc(m.coverage)}</td></tr>
  </table>

  <h2>Hero Counts</h2>
  <div class="grid">
    <div class="kpi"><div class="kpi-l">Active Leaks</div><div class="kpi-v red">${esc(hc.active ?? '—')}</div></div>
    <div class="kpi"><div class="kpi-l">Repaired</div><div class="kpi-v green">${esc(hc.repaired ?? '—')}</div></div>
    <div class="kpi"><div class="kpi-l">Suspected</div><div class="kpi-v amber">${esc(hc.suspected ?? '—')}</div></div>
  </div>

  <h2>Top 10 Detections</h2>
  <table>
    <tr><th>ID</th><th>Severity</th><th>Score</th><th>Location</th><th>Time</th></tr>
    ${rows}
  </table>

  <h2>System Intelligence</h2>
  <div class="grid">${sysIntelGrid}</div>

  <h2>Asset Metrics</h2>
  ${assetBlock}

  <h2>Key Findings</h2>
  <ul>${findings}</ul>

  <h2>AI Recommendations</h2>
  <ul>${aiRecs}</ul>

  <div class="foot">Generated ${esc(fmtDate(ts))} · Resilient Watershed Recon</div>
</body></html>`;
}

function actionGenerateReport(ds) {
  const html = buildReportHtml(ds);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `RWR-DR2-Report-${fnameDate()}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  qaToast('Report generated ✓');
}

/* ----------------------------- mount ------------------------------------- */
const ACTION_HANDLERS = {
  'Dispatch Leak Crew': (ds) => actionDispatchCrew(ds),
  'Open Leak Sheet':    (ds) => actionOpenLeakSheet(ds),
  'Open in GIS Cloud':  (ds) => actionOpenGisCloud(ds),
  'Generate DR Report': (ds) => actionGenerateReport(ds),
};

export function mountQuickActions({ ds }) {
  injectStyles();
  const host = document.getElementById('actions');
  if (!host) {
    console.warn('[quick-actions] #actions container not found');
    return () => {};
  }

  const onClick = (e) => {
    const btn = e.target.closest(
      '[data-action], button, .action, .qa-action, .quick-action, .action-item'
    );
    if (!btn || !host.contains(btn)) return;
    // 1) data-action attribute wins
    const attr = btn.getAttribute('data-action');
    if (attr && ACTION_HANDLERS[attr]) { ACTION_HANDLERS[attr](ds); return; }
    // 2) match by visible text against DS.actions[*].name
    const txt = (btn.textContent || '').trim();
    const action = (ds.actions || []).find((a) => txt.includes(a.name));
    if (action && ACTION_HANDLERS[action.name]) {
      ACTION_HANDLERS[action.name](ds);
    }
  };

  // Make the rendered .action-item rows look + behave like buttons.
  host.querySelectorAll('.action-item').forEach((el) => {
    el.style.cursor = 'pointer';
    const name = (el.querySelector('.action-name')?.textContent || '').trim();
    if (name) el.setAttribute('data-action', name);
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
    });
  });

  host.addEventListener('click', onClick);

  // F1–F4 keyboard shortcuts (matching the keys shown next to each action).
  const keyMap = {
    F1: 'Dispatch Leak Crew',
    F2: 'Open Leak Sheet',
    F3: 'Open in GIS Cloud',
    F4: 'Generate DR Report',
  };
  const onKey = (ev) => {
    const fn = keyMap[ev.key];
    if (!fn) return;
    // Don't hijack F-keys while the operator is typing in an input/textarea.
    const t = ev.target;
    if (t && (t.matches?.('input, textarea, select, [contenteditable="true"]'))) return;
    ev.preventDefault();
    ACTION_HANDLERS[fn]?.(ds);
  };
  window.addEventListener('keydown', onKey);

  return function dispose() {
    host.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKey);
  };
}

export default mountQuickActions;
