// =============================================================================
// features/sun-bar.js — top horizontal sun-control strip
// -----------------------------------------------------------------------------
// 28-px tall bar mounted into a host container. Built from vanilla DOM so it
// works alongside the existing index.html shell without touching it.
//
// Strip layout (left → right):
//   [☀ icon] [time slider with sun chip thumb] [time text "HH:MMZ"]
//   [brightness slider] [brightness %] [date input]
//
// Every change triggers `host.setSun({ hourUTC, brightness, dateISO })`.
//
// Style is scoped via the `.sb-sun-…` prefix and injected once per process.
// =============================================================================

let stylesInjected = false;
const STYLE_ID = 'rwr-sun-bar-style';

function injectStyles() {
  if (stylesInjected || document.getElementById(STYLE_ID)) {
    stylesInjected = true; return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .sb-sun-bar {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      height: 28px;
      padding: 0 12px;
      font: 11px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #d8e3f1;
      background: linear-gradient(
        90deg,
        rgba(8,12,22,0.92)   0%,
        rgba(38,28,12,0.85)  18%,
        rgba(255,176,32,0.18) 35%,
        rgba(255,224,140,0.22) 50%,
        rgba(255,138,64,0.18) 65%,
        rgba(38,28,12,0.85)  82%,
        rgba(8,12,22,0.92)  100%
      );
      backdrop-filter: blur(6px);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      user-select: none;
      z-index: 50;
    }
    .sb-sun-icon { font-size: 14px; line-height: 1; filter: drop-shadow(0 0 4px rgba(255,200,80,0.7)); }
    .sb-sun-time-wrap, .sb-sun-bright-wrap { display: flex; align-items: center; gap: 6px; }
    .sb-sun-time-wrap   { flex: 1 1 auto; min-width: 160px; }
    .sb-sun-bright-wrap { flex: 0 0 auto; min-width: 130px; }
    .sb-sun-slider {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 4px; border-radius: 2px;
      background: rgba(255,255,255,0.18);
      outline: none; margin: 0;
    }
    .sb-sun-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #fff7d6 0%, #ffd166 55%, #ff8a40 100%);
      border: 1px solid rgba(0,0,0,0.4);
      box-shadow: 0 0 6px rgba(255,200,80,0.9);
      cursor: pointer;
    }
    .sb-sun-slider::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #fff7d6 0%, #ffd166 55%, #ff8a40 100%);
      border: 1px solid rgba(0,0,0,0.4);
      box-shadow: 0 0 6px rgba(255,200,80,0.9);
      cursor: pointer;
    }
    .sb-sun-bright-slider::-webkit-slider-thumb {
      background: radial-gradient(circle at 35% 35%, #fff 0%, #cfe6ff 55%, #4d9fff 100%);
      box-shadow: 0 0 5px rgba(120,180,255,0.8);
    }
    .sb-sun-bright-slider::-moz-range-thumb {
      background: radial-gradient(circle at 35% 35%, #fff 0%, #cfe6ff 55%, #4d9fff 100%);
      box-shadow: 0 0 5px rgba(120,180,255,0.8);
    }
    .sb-sun-readout {
      font-variant-numeric: tabular-nums;
      min-width: 56px;
      color: #f1e7c8;
      letter-spacing: 0.02em;
    }
    .sb-sun-bright-readout {
      min-width: 36px; text-align: right; color: #cfe6ff;
    }
    .sb-sun-date {
      background: rgba(0,0,0,0.35);
      color: #d8e3f1;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 3px;
      padding: 2px 6px;
      font: inherit;
      color-scheme: dark;
    }
    .sb-sun-label { color: rgba(216,227,241,0.65); letter-spacing: 0.06em; text-transform: uppercase; }
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

/** Format a continuous fractional hour (e.g. 13.25) as "HH:MMZ". */
function fmtHour(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}Z`;
}

/**
 * Mount the sun bar.
 * @param {{
 *   container: HTMLElement,
 *   host: { setSun: (args:{hourUTC:number, brightness:number, dateISO:string}) => void },
 *   defaultHourUTC?: number,
 *   defaultBrightness?: number,
 *   dateISO?: string,
 * }} opts
 * @returns {{ root: HTMLElement, set: (next:Partial<{hourUTC:number, brightness:number, dateISO:string}>)=>void, dispose: ()=>void }}
 */
export function mountSunBar({
  container,
  host,
  defaultHourUTC    = 12,
  defaultBrightness = 100,
  dateISO           = '2026-04-30',
}) {
  if (!container) throw new Error('[sun-bar] container is required');
  injectStyles();

  let hourUTC    = defaultHourUTC;
  let brightness = defaultBrightness;
  let dateStr    = dateISO;

  // ---- DOM ----------------------------------------------------------------
  const root = document.createElement('div');
  root.className = 'sb-sun-bar';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Sun control');

  const icon = document.createElement('span');
  icon.className = 'sb-sun-icon';
  icon.textContent = '☀';

  // time slider
  const timeWrap = document.createElement('label');
  timeWrap.className = 'sb-sun-time-wrap';
  const timeLbl = document.createElement('span');
  timeLbl.className = 'sb-sun-label';
  timeLbl.textContent = 'TIME';
  const timeSlider = document.createElement('input');
  timeSlider.type  = 'range';
  timeSlider.min   = '0';
  timeSlider.max   = '24';
  timeSlider.step  = '0.05';
  timeSlider.value = String(hourUTC);
  timeSlider.className = 'sb-sun-slider sb-sun-time-slider';
  timeSlider.setAttribute('aria-label', 'Time of day in UTC hours');
  const timeReadout = document.createElement('span');
  timeReadout.className = 'sb-sun-readout';
  timeReadout.textContent = fmtHour(hourUTC) + ' UTC';
  timeWrap.append(timeLbl, timeSlider, timeReadout);

  // brightness slider
  const brightWrap = document.createElement('label');
  brightWrap.className = 'sb-sun-bright-wrap';
  const brightLbl = document.createElement('span');
  brightLbl.className = 'sb-sun-label';
  brightLbl.textContent = 'BRIGHT';
  const brightSlider = document.createElement('input');
  brightSlider.type  = 'range';
  brightSlider.min   = '0';
  brightSlider.max   = '100';
  brightSlider.step  = '1';
  brightSlider.value = String(brightness);
  brightSlider.className = 'sb-sun-slider sb-sun-bright-slider';
  brightSlider.setAttribute('aria-label', 'Sun brightness percentage');
  const brightReadout = document.createElement('span');
  brightReadout.className = 'sb-sun-bright-readout';
  brightReadout.textContent = `${brightness}%`;
  brightWrap.append(brightLbl, brightSlider, brightReadout);

  // date input
  const dateInput = document.createElement('input');
  dateInput.type  = 'date';
  dateInput.value = dateStr;
  dateInput.className = 'sb-sun-date';
  dateInput.setAttribute('aria-label', 'Sun date (UTC)');

  root.append(icon, timeWrap, brightWrap, dateInput);
  container.appendChild(root);

  // ---- wiring -------------------------------------------------------------
  const emit = () => {
    try { host?.setSun?.({ hourUTC, brightness, dateISO: dateStr }); }
    catch (e) { console.warn('[sun-bar] host.setSun threw', e); }
  };

  const onTime = () => {
    hourUTC = Number(timeSlider.value) || 0;
    timeReadout.textContent = fmtHour(hourUTC) + ' UTC';
    emit();
  };
  const onBright = () => {
    brightness = Number(brightSlider.value) || 0;
    brightReadout.textContent = `${brightness}%`;
    emit();
  };
  const onDate = () => {
    dateStr = dateInput.value || dateStr;
    emit();
  };

  timeSlider.addEventListener('input',   onTime);
  brightSlider.addEventListener('input', onBright);
  dateInput.addEventListener('change',   onDate);

  // Push initial state once so engines don't sit in a stale default.
  emit();

  // ---- imperative API -----------------------------------------------------
  const set = (next = {}) => {
    if (Number.isFinite(next.hourUTC))    { hourUTC    = next.hourUTC;    timeSlider.value   = String(hourUTC);    timeReadout.textContent  = fmtHour(hourUTC) + ' UTC'; }
    if (Number.isFinite(next.brightness)) { brightness = next.brightness; brightSlider.value = String(brightness); brightReadout.textContent = `${brightness}%`; }
    if (typeof next.dateISO === 'string') { dateStr    = next.dateISO;    dateInput.value    = dateStr; }
    emit();
  };

  const dispose = () => {
    timeSlider.removeEventListener('input',   onTime);
    brightSlider.removeEventListener('input', onBright);
    dateInput.removeEventListener('change',   onDate);
    root.remove();
  };

  return { root, set, dispose };
}

export default mountSunBar;
