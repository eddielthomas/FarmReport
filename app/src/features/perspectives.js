// =============================================================================
// perspectives.js
// Wires #savePerspBtn, the #perspList list, and persists user-saved camera
// perspectives to localStorage. DS.perspectives are immutable presets; user
// perspectives are added to the same list with a "★" badge and a delete btn.
// =============================================================================

import { qaToast } from './quick-actions.js';

const LS_KEY = 'rwr.mvp.perspectives';
const STYLE_ID = 'rwr-persp-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #perspList .persp-item{display:flex;align-items:center;gap:8px;padding:7px 8px;
      background:var(--bg1);border:1px solid var(--bg4);border-radius:3px;margin-bottom:4px;
      cursor:pointer;transition:all .12s ease-out;font-family:var(--sans);}
    #perspList .persp-item:hover{border-color:var(--cyan);background:var(--bg2);}
    #perspList .persp-star{font-size:9px;color:var(--amber);width:12px;text-align:center;flex:0 0 auto;}
    #perspList .persp-name{flex:1;min-width:0;font-size:10px;font-weight:600;color:var(--t1);
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #perspList .persp-meta{font-family:var(--mono);font-size:8px;color:var(--t3);letter-spacing:.5px;flex:0 0 auto;}
    #perspList .persp-del{background:transparent;border:1px solid var(--bg4);color:var(--t3);
      width:18px;height:18px;border-radius:2px;font-size:10px;line-height:1;cursor:pointer;
      flex:0 0 auto;padding:0;}
    #perspList .persp-del:hover{color:var(--red);border-color:var(--red);}
    #perspList .persp-empty{padding:14px;text-align:center;color:var(--t3);font-size:10px;}
  `;
  document.head.appendChild(s);
}

/* --------- localStorage --------- */
function loadUserPersps() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } catch {
    return [];
  }
}
function saveUserPersps(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
  catch (err) { console.warn('[perspectives] save failed', err); }
}

/* --------- camera --------- */
let lastCamera = null;
function rememberCamera(cam) {
  if (cam && Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) {
    lastCamera = { lat: cam.lat, lon: cam.lon, zoom: Number(cam.zoom) || 12 };
  }
}
function getCamera(host) {
  if (host && typeof host.getCamera === 'function') {
    try {
      const c = host.getCamera();
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) return c;
    } catch { /* noop */ }
  }
  return lastCamera;
}

/* --------- escape --------- */
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* --------- mount --------- */
export function mountPerspectives({ ds, host }) {
  injectStyles();
  const list = document.getElementById('perspList');
  const saveBtn = document.getElementById('savePerspBtn');
  if (!list) {
    console.warn('[perspectives] #perspList not found');
    return () => {};
  }

  const presets = (ds?.perspectives ?? []).map((p) => ({ ...p, _user: false }));
  let userList = loadUserPersps();

  const render = () => {
    const all = [...userList.map((p) => ({ ...p, _user: true })), ...presets];
    if (all.length === 0) {
      list.innerHTML = '<div class="persp-empty">No saved views yet.<br>Click + Save Current View above.</div>';
      return;
    }
    list.innerHTML = all.map((p, i) => `
      <div class="persp-item" data-i="${i}" data-user="${p._user ? '1' : '0'}">
        <div class="persp-star">${p._user ? '★' : '·'}</div>
        <div class="persp-name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="persp-meta">${(p.lat ?? 0).toFixed(2)},${(p.lon ?? 0).toFixed(2)} z${p.zoom ?? 12}</div>
        ${p._user ? '<button class="persp-del" type="button" title="Delete">✕</button>' : ''}
      </div>
    `).join('');
  };

  const onListClick = (e) => {
    const item = e.target.closest('.persp-item');
    if (!item) return;
    const idx = Number(item.getAttribute('data-i'));
    const isUser = item.getAttribute('data-user') === '1';
    const all = [...userList.map((p) => ({ ...p, _user: true })), ...presets];
    const p = all[idx];
    if (!p) return;
    if (e.target.closest('.persp-del')) {
      // Delete from user list
      if (isUser) {
        userList = userList.filter((u) => !(u.name === p.name && u.lat === p.lat && u.lon === p.lon));
        saveUserPersps(userList);
        render();
        qaToast('View removed');
      }
      return;
    }
    if (host && typeof host.flyTo === 'function') {
      try { host.flyTo(p.lat, p.lon, p.zoom ?? 12); }
      catch (err) { console.warn('[perspectives] flyTo failed', err); }
    } else {
      window.dispatchEvent(new CustomEvent('camera:flyTo', { detail: p }));
    }
  };

  const onSave = () => {
    const cam = getCamera(host);
    if (!cam) {
      qaToast('Camera position unavailable');
      return;
    }
    const name = (window.prompt('Name this view', `View ${userList.length + 1}`) || '').trim();
    if (!name) return;
    const persp = {
      name,
      lat:  Number(cam.lat),
      lon:  Number(cam.lon),
      zoom: Number(cam.zoom) || 12,
      created: new Date().toISOString().slice(0, 10),
    };
    userList = [persp, ...userList];
    saveUserPersps(userList);
    render();
    qaToast('View saved');
  };

  const onCameraChange = (e) => rememberCamera(e?.detail);

  list.addEventListener('click', onListClick);
  saveBtn && saveBtn.addEventListener('click', onSave);
  window.addEventListener('camera:change', onCameraChange);

  render();

  return function dispose() {
    list.removeEventListener('click', onListClick);
    saveBtn && saveBtn.removeEventListener('click', onSave);
    window.removeEventListener('camera:change', onCameraChange);
  };
}

export default mountPerspectives;
