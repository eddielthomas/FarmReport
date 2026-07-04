// =============================================================================
// scrubber.js
// Wires the bottom time scrubber: pointer/touch dragging, percent->time mapping
// against DS.events / DS._dataReleases, and emits 'time:change' for engines.
// =============================================================================

function parseTime(s) {
  if (!s) return null;
  if (s instanceof Date) return s.getTime();
  if (typeof s === 'number') return s;
  // Accept ISO and "YYYY-MM-DD HH:MM:SSZ"-ish
  const v = Date.parse(String(s).replace(' ', 'T'));
  return Number.isFinite(v) ? v : null;
}

function buildRange(ds) {
  const stamps = [];

  // Prefer DS._dataReleases when populated (more authoritative).
  const dr = ds?._dataReleases;
  if (Array.isArray(dr)) {
    for (const r of dr) {
      const t = parseTime(r?.date || r?.publishedAt || r?.created || r?.start || r?.value);
      if (t) stamps.push(t);
    }
  }

  // Fall back / merge with event timestamps. DS.events.time is "HH:MMZ" only
  // in many cases — pair with DS.mission.start date when needed.
  const baseDate = ds?.mission?.start ? parseTime(ds.mission.start) : null;
  for (const ev of ds?.events ?? []) {
    if (!ev || !ev.time) continue;
    if (/^\d{2}:\d{2}/.test(ev.time)) {
      if (!baseDate) continue;
      const [hh, mm] = ev.time.replace('Z','').split(':').map(Number);
      const d = new Date(baseDate);
      d.setUTCHours(hh || 0, mm || 0, 0, 0);
      stamps.push(d.getTime());
    } else {
      const t = parseTime(ev.time);
      if (t) stamps.push(t);
    }
  }

  // Detection times
  for (const d of ds?.detections ?? []) {
    const t = parseTime(d?.time);
    if (t) stamps.push(t);
  }

  if (stamps.length === 0) {
    // Final fallback — last 7 days
    const now = Date.now();
    return { min: now - 7 * 24 * 3600 * 1000, max: now };
  }
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  if (min === max) return { min: min - 24 * 3600 * 1000, max: max };
  return { min, max };
}

function fmtIso(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
function toIso(ms) {
  return new Date(ms).toISOString();
}

export function mountScrubber({ ds, host }) {
  const track  = document.getElementById('scrubberTrack');
  const fill   = document.getElementById('scrubberFill');
  const handle = document.getElementById('scrubberHandle');
  const time   = document.getElementById('scrubberTime');
  if (!track || !fill || !handle) {
    console.warn('[scrubber] DOM elements missing — skipping');
    return () => {};
  }

  const range = buildRange(ds);
  let percent = 100;
  let dragging = false;

  const apply = (pct, emit = true) => {
    percent = Math.max(0, Math.min(100, pct));
    const ms  = range.min + ((range.max - range.min) * percent) / 100;
    fill.style.width = percent + '%';
    handle.style.left = percent + '%';
    if (time) time.textContent = fmtIso(ms);
    if (emit) {
      window.dispatchEvent(new CustomEvent('time:change', {
        detail: { iso: toIso(ms), ms, percent },
      }));
    }
  };

  const updateFromClientX = (clientX) => {
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left;
    apply((x / rect.width) * 100);
  };

  /* ---- pointer events ---- */
  const onPointerDown = (e) => {
    dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch { /* noop */ }
    updateFromClientX(e.clientX);
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  };
  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { track.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  /* ---- touch fallback (older browsers) ---- */
  const onTouchStart = (e) => {
    if (!e.touches?.length) return;
    dragging = true;
    updateFromClientX(e.touches[0].clientX);
    e.preventDefault();
  };
  const onTouchMove = (e) => {
    if (!dragging || !e.touches?.length) return;
    updateFromClientX(e.touches[0].clientX);
  };
  const onTouchEnd = () => { dragging = false; };

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup',   onPointerUp);
  track.addEventListener('pointercancel', onPointerUp);
  // handle is inside the track but bind explicitly for safety
  handle.addEventListener('pointerdown', onPointerDown);

  track.addEventListener('touchstart', onTouchStart, { passive: false });
  track.addEventListener('touchmove',  onTouchMove,  { passive: false });
  track.addEventListener('touchend',   onTouchEnd);

  // Default at 100% (latest), don't emit on mount (engines hydrate first)
  apply(100, false);

  return function dispose() {
    track.removeEventListener('pointerdown', onPointerDown);
    track.removeEventListener('pointermove', onPointerMove);
    track.removeEventListener('pointerup',   onPointerUp);
    track.removeEventListener('pointercancel', onPointerUp);
    handle.removeEventListener('pointerdown', onPointerDown);
    track.removeEventListener('touchstart', onTouchStart);
    track.removeEventListener('touchmove',  onTouchMove);
    track.removeEventListener('touchend',   onTouchEnd);
  };
}

export default mountScrubber;
