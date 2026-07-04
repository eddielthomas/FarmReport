// =============================================================================
// header-controls.js  —  Team B (RWR MVP)
// -----------------------------------------------------------------------------
// Wires the three nav-btn buttons in the topnav (Alerts / Settings / User)
// into anchored popovers with backdrop dismiss.
//
// Public API:
//   mountHeaderControls({ ds })  ->  { destroy() }
//
// Custom events dispatched on document:
//   'workspace:open-request'   detail: { tab: 'settings' }
//   'detection:select'         detail: { id }
//
// SAFETY: Read-only against `ds`. Does NOT modify index.html or any data
// modules. All UI is appended to document.body / topnav.
// =============================================================================

const STYLE_ID = 'hcStyle';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.hc-backdrop{
  position:fixed; inset:0; z-index:300; background:transparent;
}
.hc-pop{
  position:fixed; z-index:301; min-width:240px; max-width:340px;
  background:rgba(8,16,32,0.96); backdrop-filter:blur(24px);
  -webkit-backdrop-filter:blur(24px);
  border:1px solid var(--borderH); border-radius:8px;
  box-shadow:0 12px 36px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04);
  font-family:var(--sans); color:var(--t1);
  animation:hcPop .15s ease;
  overflow:hidden;
}
@keyframes hcPop{ from{opacity:0;transform:translateY(-4px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }
.hc-pop-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:8px 10px; border-bottom:1px solid var(--border);
}
.hc-pop-title{ font-size:8px; font-weight:800; text-transform:uppercase; letter-spacing:1px; color:var(--cyan); }
.hc-pop-sub{ font-size:6.5px; color:var(--t3); font-family:var(--mono); }
.hc-pop-body{ max-height:340px; overflow-y:auto; padding:6px; }
.hc-pop-foot{ border-top:1px solid var(--border); padding:6px 10px; display:flex; gap:6px; justify-content:flex-end; }

.hc-evt{
  display:flex; align-items:flex-start; gap:6px; padding:5px 6px;
  border-radius:4px; cursor:pointer; transition:background .15s;
  border:1px solid transparent;
}
.hc-evt:hover{ background:rgba(60,140,255,0.05); border-color:var(--border); }
.hc-evt-dot{ width:6px; height:6px; border-radius:50%; flex-shrink:0; margin-top:4px; box-shadow:0 0 4px currentColor; }
.hc-evt-body{ flex:1; min-width:0; }
.hc-evt-title{ font-size:8px; font-weight:600; line-height:1.3; }
.hc-evt-meta{ font-size:6.5px; color:var(--t3); font-family:var(--mono); margin-top:1px; }

.hc-user-row{ display:flex; justify-content:space-between; padding:3px 6px; gap:8px; }
.hc-user-row .k{ font-size:7px; color:var(--t3); text-transform:uppercase; letter-spacing:.4px; }
.hc-user-row .v{ font-size:8px; color:var(--t1); font-family:var(--mono); font-weight:600; text-align:right; word-break:break-all; }

.hc-btn{
  padding:5px 10px; border-radius:4px; border:1px solid var(--border);
  background:transparent; color:var(--t2); font-size:7.5px; font-weight:700;
  font-family:var(--sans); cursor:pointer; transition:all .15s;
  text-transform:uppercase; letter-spacing:.5px;
}
.hc-btn:hover{ border-color:var(--cyan); color:var(--cyan); }
.hc-btn.danger:hover{ border-color:var(--red); color:var(--red); }

.hc-empty{ padding:18px 12px; text-align:center; color:var(--t3); font-size:8px; font-style:italic; }
`;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

let activePop = null;
let activeBackdrop = null;
function dismissPop() {
  if (activeBackdrop) { activeBackdrop.remove(); activeBackdrop = null; }
  if (activePop)      { activePop.remove();      activePop = null; }
  document.removeEventListener('keydown', escDismiss);
}
function escDismiss(e) { if (e.key === 'Escape') dismissPop(); }

function openPop(anchor, builder) {
  if (activePop) { dismissPop(); return; }

  const backdrop = document.createElement('div');
  backdrop.className = 'hc-backdrop';
  backdrop.addEventListener('mousedown', dismissPop);
  document.body.appendChild(backdrop);
  activeBackdrop = backdrop;

  const pop = document.createElement('div');
  pop.className = 'hc-pop';
  pop.setAttribute('role', 'dialog');
  pop.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(pop);
  activePop = pop;

  builder(pop);

  // Position under the anchor, right-aligned
  const r = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = r.right - popRect.width;
  if (left < 6) left = 6;
  if (left + popRect.width > window.innerWidth - 6) left = window.innerWidth - popRect.width - 6;
  const top = r.bottom + 6;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top  = `${Math.round(top)}px`;

  document.addEventListener('keydown', escDismiss);
}

// ---------- builders --------------------------------------------------------
function buildAlerts(pop, ds) {
  const events = (ds.events || []).slice(0, 10);
  const highCount = (ds.detections || []).filter((d) => d.severity === 'high').length;
  pop.innerHTML = `
    <div class="hc-pop-head">
      <div>
        <div class="hc-pop-title">🔔 Alerts</div>
        <div class="hc-pop-sub">${events.length} recent · ${highCount} high-severity</div>
      </div>
    </div>
    <div class="hc-pop-body">
      ${events.length ? events.map((e, i) => `
        <div class="hc-evt" tabindex="0" role="button" data-idx="${i}">
          <div class="hc-evt-dot" style="color:${esc(e.color || 'var(--cyan)')};background:${esc(e.color || 'var(--cyan)')}"></div>
          <div class="hc-evt-body">
            <div class="hc-evt-title">${esc(e.title)}</div>
            <div class="hc-evt-meta">${esc(e.time || '')}</div>
          </div>
        </div>
      `).join('') : `<div class="hc-empty">No alerts to display.</div>`}
    </div>
    <div class="hc-pop-foot">
      <button class="hc-btn" type="button" data-act="all">View all events</button>
    </div>
  `;

  pop.querySelectorAll('[data-idx]').forEach((row) => {
    const handler = () => {
      const ev = events[Number(row.dataset.idx)];
      if (!ev) return;
      // Try to match an event title back to a detection (by ID prefix)
      const m = String(ev.title).match(/(LEAK|POI)-\d+/);
      if (m) {
        const id = m[0];
        document.dispatchEvent(new CustomEvent('detection:select', { detail: { id } }));
      }
      dismissPop();
    };
    row.addEventListener('click', handler);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
  });
  pop.querySelector('[data-act="all"]').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('workspace:open-request', { detail: { tab: 'detections' } }));
    dismissPop();
  });
}

function buildUser(pop, ds) {
  const M = ds.mission || {};
  const meta = ds._meta || {};
  pop.innerHTML = `
    <div class="hc-pop-head">
      <div>
        <div class="hc-pop-title">👤 Operator</div>
        <div class="hc-pop-sub">${esc(M.commander || '—')}</div>
      </div>
    </div>
    <div class="hc-pop-body">
      <div class="hc-user-row"><span class="k">Commander</span><span class="v">${esc(M.commander || '—')}</span></div>
      <div class="hc-user-row"><span class="k">Mission ID</span><span class="v">${esc(M.id || '—')}</span></div>
      <div class="hc-user-row"><span class="k">Captured</span><span class="v">${esc(meta.capturedAt || '—')}</span></div>
      <div class="hc-user-row"><span class="k">Source</span><span class="v">${esc(meta.dataSource || meta.source || '—')}</span></div>
      <div class="hc-user-row"><span class="k">Sub-Project</span><span class="v">${esc(meta.subProject || '—')} · ${esc(meta.name || '')}</span></div>
    </div>
    <div class="hc-pop-foot">
      <button class="hc-btn danger" type="button" data-act="signout">Sign out</button>
    </div>
  `;
  pop.querySelector('[data-act="signout"]').addEventListener('click', () => {
    // Stub — orchestrator can wire this to the real auth flow.
    console.info('[header-controls] sign-out stub invoked');
    dismissPop();
  });
}

// ---------- mount -----------------------------------------------------------
export function mountHeaderControls({ ds } = {}) {
  if (!ds) {
    console.warn('[header-controls] mounted without ds');
    return { destroy() {} };
  }
  injectStyles();

  // Update the alert-count chip from real data
  const chip = document.getElementById('alertCount');
  if (chip) {
    const n = (ds.detections || []).filter((d) => d.severity === 'high').length;
    chip.textContent = String(n);
    chip.style.display = n > 0 ? '' : 'none';
  }

  // The three nav-btn buttons live in `.nav-right`. We disambiguate by title.
  const navBtns = $$('.nav-right .nav-btn');
  const byTitle = (t) => navBtns.find((b) => (b.getAttribute('title') || '').toLowerCase() === t);
  const alertsBtn  = byTitle('alerts');
  const settingsBtn = byTitle('settings');
  const userBtn    = byTitle('user');

  const handlers = [];
  const wire = (btn, fn) => {
    if (!btn) return;
    const h = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Re-clicking the same trigger toggles closed
      const wasOpen = !!activePop;
      dismissPop();
      if (!wasOpen) fn();
    };
    btn.addEventListener('click', h);
    handlers.push([btn, h]);
  };

  wire(alertsBtn,  () => openPop(alertsBtn,  (pop) => buildAlerts(pop, ds)));
  wire(userBtn,    () => openPop(userBtn,    (pop) => buildUser(pop, ds)));
  wire(settingsBtn, () => {
    // Defer to the workspace-tabs settings panel
    document.dispatchEvent(new CustomEvent('workspace:open-request', { detail: { tab: 'settings' } }));
  });

  return {
    destroy: () => {
      dismissPop();
      handlers.forEach(([b, h]) => b.removeEventListener('click', h));
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}

export default mountHeaderControls;
