// =============================================================================
// engines/index.js — premium multi-engine host with cinematic transitions
// -----------------------------------------------------------------------------
// Three engines, one uniform contract:
//   - 'globe'  → globe-three.js   (Three.js sphere; in this MVP the inline
//                                  Three.js in index.html is the active globe,
//                                  so the host treats 'globe' here as
//                                  "no overlay" — see host adapter)
//   - 'map2d'  → map-2d.js        (MapLibre + Deck.gl, lazy on first use)
//   - 'hd3d'   → hd-3d.js         (Cesium, dynamic import on first use)
//
// Premium features added on top of the prior simple host:
//   * Cross-fade transitions — both engines render briefly during a swap,
//     opacity 0→1 / 1→0 over CROSSFADE_MS, then the old one is disposed.
//   * Auto-LOD — when enabled, listens to camera:change and switches engine
//     based on zoom (with hysteresis + cooldown). Manual clicks suppress
//     auto-LOD for MANUAL_OVERRIDE_MS so user intent isn't reverted.
//   * State preservation — sun + layer-visibility + camera replayed BEFORE
//     the new engine's first paint.
//   * Forwarders — setBasemap/setSceneMode/getCamera/onCameraChange so the
//     unified map-toolbar feature can drive engine-specific controls.
//
// Window CustomEvents dispatched:
//   transition:start { detail:{ from, to } }
//   transition:end   { detail:{ id } }
//   engine:ready     { detail:{ id } }
//   camera:change    { detail:{ lat, lon, zoom, bearing, pitch, engine } }
// =============================================================================

// NOTE: globe-three.js is intentionally NOT imported. The dashboard
// pivot made MapLibre+deck.gl (with MapLibre's built-in globe projection)
// the only base surface; the legacy Three.js sphere is gone for good.
// Any caller that asks for 'globe' is silently redirected to map2d.

const CROSSFADE_MS         = 600;
const MANUAL_OVERRIDE_MS   = 8000;
const AUTO_LOD_COOLDOWN_MS = 1200;
const HYSTERESIS           = 0.5;

// Zoom thresholds (with hysteresis baked in by callers)
const Z_HD3D_MIN   = 13.5;  // zoom ≥ 13.5 → hd3d

/** Lazy module cache so we only fetch each engine once. */
const lazy = { map2d: null, hd3d: null };

/**
 * Normalize a logical mode id to the underlying engine module id.
 * 'globe' is a legacy logical mode that now renders inside map2d via
 * MapLibre's globe projection — so it loads the same module as 'map2d'.
 */
function resolveEngineId(id) {
  if (id === 'globe') return 'map2d';
  return id;
}

async function loadEngine(id) {
  const engineId = resolveEngineId(id);
  if (engineId === 'map2d') {
    lazy.map2d ??= await import('./map-2d.js');
    return lazy.map2d;
  }
  if (engineId === 'hd3d') {
    lazy.hd3d ??= await import('./hd-3d.js');
    return lazy.hd3d;
  }
  throw new Error(`[engines] unknown mode: ${id}`);
}

/** Build a per-engine wrapper div so we can fade independently during swaps. */
function makeSlot(mount, id) {
  const slot = document.createElement('div');
  slot.className = 'rwr-engine-slot';
  slot.dataset.id = id;
  slot.style.cssText = [
    'position:absolute',
    'inset:0',
    'width:100%',
    'height:100%',
    'opacity:0',
    'transition:opacity ' + CROSSFADE_MS + 'ms ease-in-out',
    'will-change:opacity',
    'pointer-events:auto',
  ].join(';');
  mount.appendChild(slot);
  return slot;
}

/** Pick the correct engine for a given zoom level. */
function modeForZoom(z) {
  if (!Number.isFinite(z)) return 'map2d';
  // map2d is the default at all zooms (MapLibre handles the globe view
  // natively). Only the high-detail Cesium engine takes over up close.
  if (z >= Z_HD3D_MIN) return 'hd3d';
  return 'map2d';
}

/** Best-effort dispatch a CustomEvent on window. */
function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
}

/**
 * Create the engine host.
 * @param {{ ds: any, mount: HTMLElement }} opts
 */
export function createEngineHost({ ds, mount }) {
  if (!mount) throw new Error('[engines] mount element is required');

  /** @type {string|null} */          let activeId    = null;
  /** @type {any|null}    */          let active      = null;
  /** @type {HTMLElement|null} */     let activeSlot  = null;
  /** @type {Set<()=>void>}  */       const cameraSubs = new Set();
  /** @type {()=>void|null}  */       let unsubscribeCamera = null;
  /** @type {Set<()=>void>}  */       const viewSubs = new Set();
  /** @type {()=>void|null}  */       let unsubscribeView = null;

  // Camera bootstrapped from DS viewport.
  let camera = {
    lat:    ds?._viewport?.lat  ?? 30.0,
    lon:    ds?._viewport?.lon  ?? -95.7,
    zoom:   ds?._viewport?.zoom ?? 12,
    bearing: 0,
    pitch:   0,
  };

  let sun = { hourUTC: 12, brightness: 100, dateISO: '2026-04-30' };

  // Auto-LOD state. Disabled by default: the dashboard pivot made
  // MapLibre+deck.gl (with MapLibre's built-in globe projection) the
  // default surface, so we no longer want the host to auto-swap to the
  // legacy globe-three engine at low zooms. Users still get Tactical/
  // Thermal via explicit setMode() calls.
  let autoLOD = false;
  let autoLODSuppressedUntil = 0;
  let lastAutoSwitchAt = 0;

  // Transition state
  let transitioning = false;

  // ---- helpers ------------------------------------------------------------

  const captureCamera = () => {
    try {
      const c = active?.getCamera?.();
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
        camera = {
          lat:     c.lat,
          lon:     c.lon,
          zoom:    Number.isFinite(c.zoom)    ? c.zoom    : camera.zoom,
          bearing: Number.isFinite(c.bearing) ? c.bearing : 0,
          pitch:   Number.isFinite(c.pitch)   ? c.pitch   : 0,
        };
      }
    } catch (e) { console.warn('[engines] getCamera failed', e); }
  };

  const onCamera = (c) => {
    camera = {
      lat:     Number.isFinite(c?.lat)     ? c.lat     : camera.lat,
      lon:     Number.isFinite(c?.lon)     ? c.lon     : camera.lon,
      zoom:    Number.isFinite(c?.zoom)    ? c.zoom    : camera.zoom,
      bearing: Number.isFinite(c?.bearing) ? c.bearing : (camera.bearing ?? 0),
      pitch:   Number.isFinite(c?.pitch)   ? c.pitch   : (camera.pitch   ?? 0),
    };
    const detail = { ...camera, engine: activeId };
    emit('camera:change', detail);
    for (const fn of cameraSubs) {
      try { fn(detail); } catch (_) {}
    }
    maybeAutoLOD(camera.zoom);
  };

  const maybeAutoLOD = (z) => {
    if (!autoLOD || transitioning) return;
    const now = performance.now();
    if (now < autoLODSuppressedUntil) return;
    if (now - lastAutoSwitchAt < AUTO_LOD_COOLDOWN_MS) return;

    let target = activeId;
    // Apply hysteresis: only cross when fully past the boundary.
    // The legacy globe-three engine is disabled — map2d covers all zooms
    // up to Z_HD3D_MIN, then hd3d (Cesium) takes over for close-in views.
    if (activeId === 'map2d' && z >= Z_HD3D_MIN + HYSTERESIS) target = 'hd3d';
    else if (activeId === 'hd3d'  && z <  Z_HD3D_MIN  - HYSTERESIS) target = 'map2d';

    if (target && target !== activeId) {
      lastAutoSwitchAt = now;
      setMode(target, { auto: true }).catch((e) =>
        console.warn('[engines] auto-LOD switch failed', e),
      );
    }
  };

  const detachCameraListener = () => {
    try { unsubscribeCamera?.(); } catch (_) {}
    unsubscribeCamera = null;
    try { unsubscribeView?.(); } catch (_) {}
    unsubscribeView = null;
  };

  // Continuous per-frame view notifications (engine 'move'/postRender) for
  // DOM overlays. Forwarded through a host-level sub set so subscribers
  // survive engine swaps.
  const onView = () => {
    for (const fn of viewSubs) { try { fn(); } catch (_) {} }
  };

  const attachCameraListener = (engine) => {
    detachCameraListener();
    if (typeof engine?.onCameraChange === 'function') {
      try { unsubscribeCamera = engine.onCameraChange(onCamera) || null; } catch (_) {}
    }
    if (typeof engine?.onViewRender === 'function') {
      try { unsubscribeView = engine.onViewRender(onView) || null; } catch (_) {}
    }
  };

  // Tear down a slot/engine pair.
  const disposeEngine = (engine, slot) => {
    try { engine?.dispose?.(); } catch (e) { console.warn('[engines] dispose failed', e); }
    try { slot?.remove(); } catch (_) {}
  };

  // ---- public API ---------------------------------------------------------

  /**
   * Switch view mode with cinematic cross-fade.
   * @param {'globe'|'map2d'|'hd3d'} id
   * @param {{ manual?: boolean, auto?: boolean, silent?: boolean }} [opts]
   */
  async function setMode(id, opts = {}) {
    if (id === activeId) return;

    // Short-circuit when the requested logical mode resolves to the same
    // underlying engine module that's already mounted (e.g. switching
    // between 'globe' and 'map2d' — both render through MapLibre). Just
    // reconfigure the live engine instead of disposing + remounting.
    if (active && resolveEngineId(id) === resolveEngineId(activeId)) {
      const fromId   = activeId;
      const wantGlobe = (id === 'globe');
      try { active.setProjection?.(wantGlobe ? 'globe' : 'mercator'); } catch (_) {}
      // Globe view = streets basemap (no satellite imagery flooding the
      // curved earth). Switching back to satellite/risk modes restores
      // the satellite basemap unless the user explicitly turned it off.
      try {
        if (wantGlobe) active.setBasemap?.('streets');
        else if (id === 'map2d') active.setBasemap?.('satellite');
      } catch (_) {}
      activeId = id;
      if (opts.manual) {
        autoLODSuppressedUntil = performance.now() + MANUAL_OVERRIDE_MS;
      }
      if (!opts.silent) {
        emit('transition:start', { detail: { from: fromId, to: id } });
        emit('engine:ready',     { detail: { id } });
        emit('transition:end',   { detail: { id } });
      }
      return;
    }

    if (transitioning) {
      // Coalesce: queue the latest request, drop intermediate.
      pendingMode = id;
      pendingOpts = opts;
      return;
    }
    transitioning = true;

    if (opts.manual) {
      autoLODSuppressedUntil = performance.now() + MANUAL_OVERRIDE_MS;
    }

    const fromId    = activeId;
    const fromInst  = active;
    const fromSlot  = activeSlot;

    captureCamera();
    // Snapshot the SOURCE camera before any await. External callers may
    // call host.flyTo() synchronously after host.setMode() (e.g. the
    // detection-click flyToDetection() helper). Those calls mutate the
    // shared `camera` object to the destination — but for a smooth
    // animated approach we want the new engine to MOUNT at the source
    // camera (so the user sees a fly-from animation), then animate to the
    // destination via the queued pendingFlyTo replay below.
    const startCamera = { ...camera };

    // Globe mode = MapLibre globe-projection at a low zoom so the user
    // sees the curved earth on boot (not zoomed straight into the AOI).
    // We override the zoom here so startCamera lands the new map at a
    // proper "earth view" even if DS._viewport defaulted to zoom=12.
    const isGlobeMode = (id === 'globe');
    if (isGlobeMode) {
      startCamera.zoom    = 2.4;
      startCamera.pitch   = 0;
      startCamera.bearing = 0;
    }
    if (!opts.silent) emit('transition:start', { detail: { from: fromId, to: id } });

    let mod, inst, slot;
    try {
      mod = await loadEngine(id);
      slot = makeSlot(mount, id);
      // Force layout pass so the opacity transition will actually fire.
      slot.getBoundingClientRect();

      inst = await mod.create({
        mount: slot,
        ds,
        camera: startCamera,
        projection: isGlobeMode ? 'globe' : undefined,
        // Globe mode boots without satellite imagery so the curved earth
        // shows clean country/coast outlines instead of a wall of imagery.
        basemap: isGlobeMode ? 'streets' : undefined,
      });

      // Replay state into the new engine BEFORE first paint surfaces (best-
      // effort — engines may not honour all of these).
      try { inst.setSun?.(sun); } catch (_) {}
      if (Array.isArray(ds?.layers)) {
        for (const l of ds.layers) {
          try { inst.setLayerVisible?.(l.id, !!l.on); } catch (_) {}
        }
      }
      // Park the engine at the SOURCE camera so the cross-fade starts at
      // the user's previous viewpoint. Pass duration:0 so the parking is
      // instant — engines that animate flyTo (globe-three) would otherwise
      // tween here and visibly overshoot the destination.
      try { inst.flyTo?.(startCamera.lat, startCamera.lon, startCamera.zoom, { duration: 0 }); } catch (_) {}
    } catch (e) {
      console.error('[engines] failed to load mode', id, e);
      transitioning = false;
      if (!opts.silent) emit('transition:end', { detail: { id: activeId } });
      return;
    }

    // Begin cross-fade.
    requestAnimationFrame(() => {
      slot.style.opacity = '1';
      if (fromSlot) fromSlot.style.opacity = '0';
    });

    // Promote new engine immediately so events route correctly.
    activeId   = id;
    active     = inst;
    activeSlot = slot;
    attachCameraListener(inst);

    if (!opts.silent) emit('engine:ready', { detail: { id } });

    // Kick off the queued flyTo IMMEDIATELY — concurrently with the
    // cross-fade. The new engine mounted at the SOURCE camera, so the
    // user sees one continuous motion: the new view fades in WHILE the
    // camera animates from source → destination, instead of a two-step
    // "snap to start, then fly". Skip if a mode swap is also queued
    // (the next setMode cycle will run the flyTo on the right engine).
    if (!pendingMode && pendingFlyTo && active === inst) {
      const p = pendingFlyTo;
      pendingFlyTo = null;
      try { inst.flyTo?.(p.lat, p.lon, p.zoom); } catch (_) {}
    }

    // After the fade, dispose the old engine and drain any queued mode
    // swap. Mode swaps that arrived during this transition take priority
    // over a leftover pendingFlyTo (the next setMode runs flyTo replay).
    setTimeout(() => {
      if (fromInst && fromInst !== inst) disposeEngine(fromInst, fromSlot);
      transitioning = false;
      if (!opts.silent) emit('transition:end', { detail: { id } });

      if (pendingMode && pendingMode !== activeId) {
        const nextId = pendingMode; const nextOpts = pendingOpts;
        pendingMode = null; pendingOpts = null;
        setMode(nextId, nextOpts).catch((err) =>
          console.warn('[engines] pending mode failed', err),
        );
      }
    }, CROSSFADE_MS + 50);
  }

  // Coalesce mode requests during a transition.
  let pendingMode = null;
  let pendingOpts = null;
  // A flyTo() call that arrived while no engine was active (or while a
  // setMode is mid-transition) — replayed once the new engine is ready so
  // the user sees a smooth animated approach, not a snap to destination.
  /** @type {{ lat:number, lon:number, zoom:number }|null} */
  let pendingFlyTo = null;

  function getActive() { return activeId; }

  function flyTo(lat, lon, zoom) {
    const z = Number.isFinite(zoom) ? zoom : camera.zoom;
    camera = { ...camera, lat, lon, zoom: z };
    if (active && !transitioning) {
      // Forward the engine's return value so callers can `await` it
      // (used by the dashboard's 2-stage flyToDetection: rotate the
      // globe first, then engine-swap + zoom in).
      try { return active.flyTo?.(lat, lon, z); } catch (_) { return undefined; }
    } else {
      // No active engine yet (or a mode swap is in progress). Stash the
      // request — setMode() replays it once the new engine is mounted so
      // the user sees a smooth animated approach instead of a snap.
      pendingFlyTo = { lat, lon, zoom: z };
    }
  }

  // Smooth single-step zoom for the right-rail toolbar +/- buttons.
  // Forwards to the active engine when it exposes cinematicZoom (currently
  // map-2d). Falls back to flyTo so the buttons keep working on engines
  // that don't implement the dedicated path (Cesium HD-3D, globe).
  function cinematicZoom(delta, opts) {
    if (active && !transitioning && typeof active.cinematicZoom === 'function') {
      try { return active.cinematicZoom(delta, opts); } catch (_) { /* fall through */ }
    }
    const dz = Number(delta) || 0;
    const z = Math.max(0, Math.min(22, camera.zoom + dz));
    return flyTo(camera.lat, camera.lon, z);
  }

  function setSun(next) {
    sun = { ...sun, ...next };
    try { active?.setSun?.(sun); } catch (_) {}
  }

  function setLayerVisible(id, on) {
    const layer = ds?.layers?.find?.((l) => l.id === id);
    if (layer) layer.on = !!on;
    try { active?.setLayerVisible?.(id, !!on); } catch (_) {}
  }

  function setBasemap(id) {
    try { active?.setBasemap?.(id); } catch (e) { console.warn('[engines] setBasemap failed', e); }
  }

  function setSceneMode(mode) {
    try { active?.setSceneMode?.(mode); } catch (e) { console.warn('[engines] setSceneMode failed', e); }
  }

  // ---- premium MapLibre forwarders (terrain + 3D buildings) ---------------
  // These are MapLibre-only features. On engines that don't implement them
  // (globe-three / hd-3d Cesium) the forwarder silently no-ops, so callers
  // can wire a single UI control regardless of the active engine.
  function setTerrain(on) {
    try { active?.setTerrain?.(!!on); } catch (e) { console.warn('[engines] setTerrain failed', e); }
  }
  function getTerrain() {
    try { return !!active?.getTerrain?.(); } catch (_) { return false; }
  }
  function setBuildings3D(on) {
    try { active?.setBuildings3D?.(!!on); } catch (e) { console.warn('[engines] setBuildings3D failed', e); }
  }
  function getBuildings3D() {
    try { return !!active?.getBuildings3D?.(); } catch (_) { return false; }
  }
  // [S16] Forward the active engine's style-ready bus (MapLibre `styledata` +
  // `idle`). Returns an unsubscribe. Engines without the hook (globe-three /
  // hd-3d) return a no-op unsubscribe so callers wire unconditionally.
  function onStyleReady(cb) {
    try { return active?.onStyleReady?.(cb) ?? (() => {}); }
    catch (_) { return () => {}; }
  }
  function setProjection(p) {
    try { active?.setProjection?.(p); } catch (e) { console.warn('[engines] setProjection failed', e); }
  }
  function getProjection() {
    try { return active?.getProjection?.() ?? 'mercator'; } catch (_) { return 'mercator'; }
  }
  function setPitch(p) {
    try { active?.setPitch?.(p); } catch (e) { console.warn('[engines] setPitch failed', e); }
  }
  function getPitch() {
    try { return active?.getPitch?.() ?? 0; } catch (_) { return 0; }
  }
  function setBearing(b) {
    try { active?.setBearing?.(b); } catch (e) { console.warn('[engines] setBearing failed', e); }
  }
  function getBearing() {
    try { return active?.getBearing?.() ?? 0; } catch (_) { return 0; }
  }

  function focus(detection) {
    if (!detection) return;
    if (Number.isFinite(detection.lat) && Number.isFinite(detection.lon)) {
      camera = {
        ...camera,
        lat: detection.lat,
        lon: detection.lon,
        zoom: Math.max(camera.zoom, 14),
      };
    }
    try { active?.focus?.(detection); } catch (_) {}
  }

  function getCamera() {
    captureCamera();
    return { ...camera };
  }

  function onCameraChange(cb) {
    if (typeof cb !== 'function') return () => {};
    cameraSubs.add(cb);
    return () => cameraSubs.delete(cb);
  }

  function onViewRender(cb) {
    if (typeof cb !== 'function') return () => {};
    viewSubs.add(cb);
    return () => viewSubs.delete(cb);
  }

  // Geographic → screen-pixel projection delegated to the active engine.
  // Returns null when no engine is mounted (inline globe) or the engine
  // can't project the point — callers must hide their element rather than
  // fall back to a wrong position.
  function project(p) {
    try { return active?.project?.(p) ?? null; } catch (_) { return null; }
  }

  function setAutoLOD(on) { autoLOD = !!on; }
  function getAutoLOD()  { return autoLOD; }

  // ---- harvest refresh ----------------------------------------------------
  // Called by the harvest-refresh feature after the orchestrator's `publish`
  // stage completes. Re-fetches the harvest JSON / GeoJSON files served by
  // the MVP API server and mutates the existing `ds` reference in place so
  // engines (which read `ds.pipes` etc. fresh on every layer rebuild) pick
  // up the new data. Engines that expose `refreshLayers()` are then asked to
  // rebuild their deck.gl overlay.
  //
  // We intentionally only touch the harvest-derived fields the layers read
  // directly (pipes, poiAttrs, poiGeometry). Re-running buildDS() would
  // mutate `ds.detections`, `ds._meta`, `ds._viewport.bounds` etc. and is
  // out of scope for the in-flight task — a follow-up will rebuild DS via
  // build-ds.js once the orchestrator emits richer outputs.
  //
  // @param {{ apiBase?: string, subProjectId?: string|number }} [opts]
  // @returns {Promise<{ pipes: number, poiAttrs: number, poiGeometry: number }>}
  async function refreshHarvestLayers(opts = {}) {
    const apiBase = (opts.apiBase ?? 'http://localhost:5180').replace(/\/+$/, '');
    const subId   = String(opts.subProjectId ?? 676251);

    const fetchJson = async (path) => {
      const r = await fetch(`${apiBase}${path}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
      return r.json();
    };

    // Fan out — failures on individual surfaces are tolerated (the
    // orchestrator may have failed a single stage without aborting publish).
    const [pipesResult, poiAttrsResult, poiGeometryResult] = await Promise.allSettled([
      fetchJson(`/api/sub-projects/${subId}/pipes`),
      fetchJson(`/api/sub-projects/${subId}/poi-attrs`),
      fetchJson(`/api/sub-projects/${subId}/geometry`),
    ]);

    const counts = { pipes: 0, poiAttrs: 0, poiGeometry: 0 };

    if (ds && pipesResult.status === 'fulfilled' && pipesResult.value) {
      ds.pipes = pipesResult.value;
      counts.pipes = Array.isArray(pipesResult.value.features)
        ? pipesResult.value.features.length : 0;
    } else if (pipesResult.status === 'rejected') {
      console.warn('[engines] refreshHarvestLayers: pipes fetch failed', pipesResult.reason);
    }

    if (ds && poiAttrsResult.status === 'fulfilled' && poiAttrsResult.value) {
      ds.poiAttrs = poiAttrsResult.value;
      counts.poiAttrs = Object.keys(poiAttrsResult.value).length;
    } else if (poiAttrsResult.status === 'rejected') {
      console.warn('[engines] refreshHarvestLayers: poi-attrs fetch failed', poiAttrsResult.reason);
    }

    if (ds && poiGeometryResult.status === 'fulfilled' && poiGeometryResult.value) {
      ds.poiGeometry = poiGeometryResult.value;
      counts.poiGeometry = Array.isArray(poiGeometryResult.value.features)
        ? poiGeometryResult.value.features.length : 0;
    } else if (poiGeometryResult.status === 'rejected') {
      console.warn('[engines] refreshHarvestLayers: geometry fetch failed', poiGeometryResult.reason);
    }

    // Ask the active engine to rebuild its overlay so the new data is on
    // screen. Engines that don't implement refreshLayers (globe-three) are
    // a no-op here — they don't render harvest layers anyway.
    try { active?.refreshLayers?.(); } catch (e) {
      console.warn('[engines] refreshLayers on active engine failed', e);
    }

    emit('harvest:refreshed', { detail: { ...counts } });
    return counts;
  }

  // Force the active engine to rebuild its deck.gl overlay from the (possibly
  // mutated) `ds` reference — used when the dashboard swaps the whole dataset
  // (e.g. switching projects to a different AOI's leaks). Unlike
  // refreshHarvestLayers() this re-fetches nothing; the caller has already
  // mutated `ds` in place.
  function refreshLayers() {
    try { active?.refreshLayers?.(); } catch (e) {
      console.warn('[engines] refreshLayers failed', e);
    }
  }

  function dispose() {
    captureCamera();
    detachCameraListener();
    if (active) disposeEngine(active, activeSlot);
    active     = null;
    activeId   = null;
    activeSlot = null;
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  // NOTE: We do NOT auto-boot here. The host adapter in index.html owns
  // initial mode selection (Globe = inline Three.js, no engine mounted).
  // This avoids a race where the engine host would mount its own globe
  // into a hidden div, only to be disposed milliseconds later.

  return {
    setMode,
    getActive,
    flyTo,
    cinematicZoom,
    setSun,
    setLayerVisible,
    setBasemap,
    setSceneMode,
    setTerrain,
    getTerrain,
    setBuildings3D,
    getBuildings3D,
    onStyleReady,
    setProjection,
    getProjection,
    setPitch,
    getPitch,
    setBearing,
    getBearing,
    focus,
    getCamera,
    onCameraChange,
    onViewRender,
    project,
    setAutoLOD,
    getAutoLOD,
    refreshHarvestLayers,
    refreshLayers,
    dispose,
    // For host introspection / autoLOD orchestration.
    modeForZoom,
  };
}

export default createEngineHost;
