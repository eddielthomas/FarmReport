// =============================================================================
// engines/globe-maplibre.js — MapLibre v5 globe-projection engine
// -----------------------------------------------------------------------------
// Drop-in replacement for engines/globe-three.js. Exposes the same contract:
//   * create({ mount, ds, camera }) -> { flyTo, setSun, setLayerVisible,
//                                        focus, getCamera, onCameraChange,
//                                        setBasemap, dispose }
//
// What you get over the Three.js sphere:
//   * Tiled satellite imagery (ESRI World Imagery) — HD all the way down to
//     street level, no fixed-resolution texture.
//   * Real `sky` layer with atmospheric scattering. The sun-bar drives
//     sky-atmosphere-sun (azimuth from hourUTC) and sky-atmosphere-sun-intensity
//     (from brightness%), so the "drag-the-sun" UX continues to work.
//   * Vector AOI polygons + leak/POI markers via Deck.gl overlay (same
//     buildLayers shape as map-2d, sharing severity colors).
//   * Globe → mercator transition is automatic at zoom ≥ ~6 thanks to
//     MapLibre's projection transition. Same map drives both.
//
// Notes:
//   * MapLibre's globe needs zoom >= 0; we map any incoming "Three.js zoom"
//     (0..20 ramp) into MapLibre zoom (0..18) using clampGlobeZoom + the
//     existing Z_GLOBE_MAX boundary in engines/index.js.
//   * Detection markers parented to the earth (which span 360° on a sphere)
//     are served as Deck.gl ScatterplotLayer (lon/lat) — MapLibre handles the
//     globe-projection math automatically.
//   * Pulse animation on the high-severity dots is achieved with a deck.gl
//     getRadius callback that varies with `t` from a private rAF.
// =============================================================================

import maplibregl       from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';

// ── basemap ─────────────────────────────────────────────────────────────────
// Satellite imagery for the globe view — uses the same ESRI World Imagery
// service as map-2d so the "Satellite Imagery" toggle reads consistently
// across globe ↔ 2D engine swaps (no more cream-OSM-on-globe vs photo-on-2D
// surprise). ESRI World Imagery is keyless and CORS-permissive.
const ATTR_ESRI = 'Imagery © Esri, Maxar, Earthstar Geographics';
const ATTR_OSM  = '© OpenStreetMap contributors';

const SAT_SOURCE = {
  type: 'raster',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
  attribution: ATTR_ESRI,
};
// Reference labels overlay (country/place names) — transparent, sits over
// satellite for readability on the globe at low zoom.
const REF_SOURCE = {
  type: 'raster',
  tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 18,
};
// OSM streets fallback — shown when "Satellite Imagery" toggle is OFF, so
// the globe never goes blank (matches map-2d behaviour).
const OSM_SOURCE = {
  type: 'raster',
  tiles: [
    'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
  ],
  tileSize: 256,
  maxzoom: 19,
  attribution: ATTR_OSM,
};

const SEV_RGBA = {
  high:   [255,  64,  96, 255],
  medium: [255, 176,  32, 255],
  low:    [ 77, 159, 255, 255],
};
const withAlpha = (rgba, a) => [rgba[0], rgba[1], rgba[2], a];
const ok = (d) => Number.isFinite(d?.lat) && Number.isFinite(d?.lon);

/**
 * Build the globe style. Sky/atmosphere is enabled and lit from a moveable sun.
 */
function buildGlobeStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    projection: { type: 'globe' },
    sky: {
      'sky-color':              '#0a1628',
      'sky-horizon-blend':      0.5,
      'horizon-color':          '#1a3050',
      'horizon-fog-blend':      0.6,
      'fog-color':              '#0a0e16',
      'fog-ground-blend':       0.5,
      'atmosphere-blend': [
        'interpolate', ['linear'], ['zoom'],
        0,  1.0,   // full atmosphere at globe view
        6,  0.4,   // fade out past the globe → mercator transition
        12, 0.0,
      ],
    },
    light: { anchor: 'viewport', color: 'white', intensity: 0.45 },
    sources: {
      satellite: SAT_SOURCE,
      reflabels: REF_SOURCE,
      osm:       OSM_SOURCE,
    },
    layers: [
      { id: 'bg',         type: 'background', paint: { 'background-color': '#000814' } },
      // Satellite stack (default ON).
      { id: 'satellite',  type: 'raster',     source: 'satellite', paint: { 'raster-resampling': 'linear' } },
      { id: 'reflabels',  type: 'raster',     source: 'reflabels', paint: { 'raster-opacity': 0.85 } },
      // Streets fallback (default hidden — shown when "Satellite Imagery" is OFF).
      { id: 'osm',        type: 'raster',     source: 'osm',       layout: { visibility: 'none' } },
    ],
  };
}

/**
 * Map an incoming "globe zoom" (0..20 from the Three.js engine) to a MapLibre
 * zoom that shows the planet from afar at default. Lower bound 0 = whole earth.
 */
function clampGlobeZoom(z) {
  if (!Number.isFinite(z)) return 1.5;
  // Engine host uses globe up to z<5; treat anything ≤2 as "whole earth", and
  // higher values should still keep the planet readable on screen.
  return Math.max(0, Math.min(5.5, z));
}

/**
 * @param {{ mount: HTMLElement, ds: any, camera: { lat:number, lon:number, zoom:number, bearing?:number, pitch?:number } }} opts
 */
export async function create({ mount, ds, camera }) {
  // ---- mount wrapper -----------------------------------------------------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000814;';
  wrap.className = 'rwr-globe-maplibre-wrap';
  mount.appendChild(wrap);

  const initLat   = Number.isFinite(camera?.lat)  ? camera.lat  : 20;
  const initLon   = Number.isFinite(camera?.lon)  ? camera.lon  : 0;
  const initZoom  = clampGlobeZoom(camera?.zoom);
  const initBear  = Number.isFinite(camera?.bearing) ? camera.bearing : 0;
  const initPitch = Number.isFinite(camera?.pitch)   ? camera.pitch   : 0;

  // ---- map ----------------------------------------------------------------
  const map = new maplibregl.Map({
    container: wrap,
    style:     buildGlobeStyle(),
    center:    [initLon, initLat],
    zoom:      initZoom,
    bearing:   initBear,
    pitch:     initPitch,
    pitchWithRotate: true,
    dragRotate:      true,
    attributionControl: false,
    fadeDuration:    180,
    maxPitch:        85,
  });

  const nav   = new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true });
  const scale = new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' });
  const attr  = new maplibregl.AttributionControl({ compact: true });
  map.addControl(nav,   'top-right');
  map.addControl(scale, 'bottom-left');
  map.addControl(attr,  'bottom-right');

  // ---- deck.gl overlay (AOI polys + leak/POI markers) ---------------------
  let popup = null;

  // rAF-driven pulse phase for animated marker glow. 0..1 each ~1.4s cycle.
  let pulsePhase = 0;
  let pulseRaf   = 0;
  const startPulse = () => {
    const t0 = performance.now();
    const tick = (t) => {
      pulsePhase = (((t - t0) / 1400) % 1);
      // Trigger a deck.gl redraw by re-setting layers (cheap; deck diffs).
      try { overlay.setProps({ layers: buildLayers() }); } catch (_) {}
      pulseRaf = requestAnimationFrame(tick);
    };
    pulseRaf = requestAnimationFrame(tick);
  };

  const buildLayers = () => {
    const layerOn = Object.fromEntries((ds?.layers ?? []).map((l) => [l.id, !!l.on]));
    const showLeaks = layerOn.leaks !== false;
    const showPois  = layerOn.pois  !== false;
    const showAoi   = layerOn.aoi   !== false;

    const dets = ds?.detections ?? [];

    // Pulse 0..1 → eased glow factor 0..1 (sin envelope).
    const pulse = 0.5 - 0.5 * Math.cos(pulsePhase * Math.PI * 2);

    const polyFeatures = dets
      .filter((d) => d.geom && d.geom.type === 'MultiPolygon')
      .map((d) => ({ type: 'Feature', properties: { id: d.id, severity: d.severity, name: d.name }, geometry: d.geom }));

    const polyLayer = new GeoJsonLayer({
      id: 'poi-polys',
      data: { type: 'FeatureCollection', features: polyFeatures },
      visible: showAoi && polyFeatures.length > 0,
      pickable: true,
      stroked: true,
      filled:  true,
      lineWidthUnits: 'pixels',
      getFillColor: (f) => withAlpha(SEV_RGBA[f.properties.severity] ?? SEV_RGBA.low, 60),
      getLineColor: (f) => SEV_RGBA[f.properties.severity] ?? SEV_RGBA.low,
      getLineWidth: 2.5,
    });

    const leakPts = dets.filter((d) => ok(d) && d.id?.startsWith?.('LEAK-'));

    // Outer glow halo — pulsing, semi-transparent, bigger on high-severity.
    const leakGlow = new ScatterplotLayer({
      id: 'leaks-glow',
      data: leakPts,
      visible: showLeaks,
      pickable: false,
      stroked: false,
      filled:  true,
      radiusUnits: 'pixels',
      getPosition: (d) => [d.lon, d.lat],
      getRadius:   (d) => 22 + (d.severity === 'high' ? 14 : 6) * pulse,
      radiusMinPixels: 18,
      radiusMaxPixels: 48,
      getFillColor: (d) => withAlpha(SEV_RGBA[d.severity] ?? SEV_RGBA.high, 80 + Math.floor(60 * pulse)),
      updateTriggers: { getRadius: pulsePhase, getFillColor: pulsePhase },
    });

    // Solid core dot — large, bright, white outline so it pops on any basemap.
    const leakLayer = new ScatterplotLayer({
      id: 'leaks',
      data: leakPts,
      visible: showLeaks,
      pickable: true,
      stroked: true,
      filled:  true,
      radiusUnits: 'pixels',
      getPosition: (d) => [d.lon, d.lat],
      getRadius:   14,
      radiusMinPixels: 10,
      radiusMaxPixels: 36,
      getFillColor: (d) => SEV_RGBA[d.severity] ?? SEV_RGBA.high,
      getLineColor: [255, 255, 255, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 2.5,
    });

    const poiPts = dets.filter((d) => ok(d) && d.id?.startsWith?.('POI-'));
    const poiLayer = new ScatterplotLayer({
      id: 'poi-centroids',
      data: poiPts,
      visible: showPois,
      pickable: true,
      stroked: true,
      filled:  true,
      radiusUnits: 'pixels',
      getPosition: (d) => [d.lon, d.lat],
      getRadius:   12,
      radiusMinPixels: 8,
      radiusMaxPixels: 28,
      getFillColor: (d) => withAlpha(SEV_RGBA[d.severity] ?? SEV_RGBA.low, 230),
      getLineColor: [255, 255, 255, 220],
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
    });

    return [polyLayer, leakGlow, leakLayer, poiLayer];
  };

  const overlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
    onClick: (info) => {
      const o = info?.object;
      if (!ok(o)) return;
      openPopup(o.lat, o.lon, `<b>${o.id}</b><br/>${o.name ?? ''}`);
      try {
        window.dispatchEvent(new CustomEvent('detection:select', { detail: { detection: o } }));
      } catch (_) {}
    },
  });

  const refreshOverlay = () => overlay.setProps({ layers: buildLayers() });

  await new Promise((res) => {
    if (map.isStyleLoaded()) return res();
    map.once('load', res);
  });
  map.addControl(overlay);
  refreshOverlay();
  startPulse();

  // ---- popup --------------------------------------------------------------
  const openPopup = (lat, lon, html) => {
    popup?.remove();
    popup = new maplibregl.Popup({ closeButton: true, offset: 12, className: 'rwr-popup' })
      .setLngLat([lon, lat])
      .setHTML(`<div style="font:12px/1.4 ui-sans-serif,system-ui;color:#0a0e16">${html ?? ''}</div>`)
      .addTo(map);
  };

  // ---- camera-change bus --------------------------------------------------
  const camSubs = new Set();
  const fireCamera = () => {
    const c = map.getCenter();
    const detail = {
      lat: c.lat,
      lon: c.lng,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
    for (const fn of camSubs) {
      try { fn(detail); } catch (_) {}
    }
  };
  map.on('moveend',   fireCamera);
  map.on('zoomend',   fireCamera);
  map.on('rotateend', fireCamera);
  map.on('pitchend',  fireCamera);

  // Continuous view bus — rAF-throttled, fires every camera frame during a
  // gesture (camSubs only fires on *end events). DOM overlays subscribe here
  // so they track the world mid-pan instead of sticking to the screen.
  const viewSubs = new Set();
  let viewRafPending = false;
  const fireView = () => {
    if (viewRafPending || viewSubs.size === 0) return;
    viewRafPending = true;
    requestAnimationFrame(() => {
      viewRafPending = false;
      for (const fn of viewSubs) { try { fn(); } catch (_) {} }
    });
  };
  map.on('move', fireView);

  // ---- engine API ---------------------------------------------------------

  function flyTo(lat, lon, zoom) {
    const z = clampGlobeZoom(Number.isFinite(zoom) ? zoom : map.getZoom());
    map.flyTo({
      center:  [lon, lat],
      zoom:    z,
      pitch:   z > 4 ? 25 : 0,
      bearing: map.getBearing(),
      speed:   1.4,
      curve:   1.42,
      essential: true,
    });
  }

  /**
   * Sun control. Hour 0..24 → azimuth 0..360°. Brightness → sky intensity +
   * a CSS filter on the wrapper so AOI/markers lift in step with the planet.
   */
  function setSun({ hourUTC = 12, brightness = 100 } = {}) {
    const az = ((hourUTC / 24) * 360) % 360;
    const b  = Math.max(0, Math.min(100, brightness)) / 100;
    const intensity = 0.4 + 14.6 * b; // 0.4 .. 15

    try {
      // MapLibre v5 sky atmosphere — set per-property paint values.
      // (The sky is part of style.sky in v5; setSky merges new keys.)
      if (typeof map.setSky === 'function') {
        map.setSky({
          'atmosphere-blend': [
            'interpolate', ['linear'], ['zoom'],
            0,  Math.max(0.2, b),
            6,  Math.max(0.0, b * 0.3),
            12, 0,
          ],
        });
      }
      // Light direction tracks the sun azimuth so 3D layers (extrusions)
      // light correctly when we add them later.
      map.setLight({ anchor: 'viewport', position: [1.5, az, 70], intensity: 0.4 + 0.6 * b, color: 'white' });
    } catch (_) {}

    // Globe is brightened/dimmed via CSS filter — covers the sky+raster
    // composite uniformly without fighting the style spec.
    const css = 0.35 + 0.85 * b;
    wrap.style.filter = `brightness(${css.toFixed(2)})`;
  }

  function setLayerVisible(id, on) {
    const setVis = (lid, vis) => {
      try { if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis); } catch (_) {}
    };
    // "Satellite Imagery" toggle picks the basemap on the globe:
    //   ON  → ESRI World Imagery + reference labels (osm hidden)
    //   OFF → OSM streets fallback (so the globe never goes blank)
    if (id === 'sat') {
      if (on) {
        setVis('satellite', 'visible');
        setVis('reflabels', 'visible');
        setVis('osm',       'none');
      } else {
        setVis('satellite', 'none');
        setVis('reflabels', 'none');
        setVis('osm',       'visible');
      }
    }
    refreshOverlay();
  }

  function focus(d) {
    if (!ok(d)) return;
    flyTo(d.lat, d.lon, Math.max(map.getZoom(), 4.5));
    openPopup(d.lat, d.lon, `<b>${d.id}</b><br/>${d.name ?? ''}`);
  }

  function getCamera() {
    const c = map.getCenter();
    return {
      lat: c.lat, lon: c.lng,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
  }

  /**
   * Returns the visible viewport as { west, south, east, north } and a
   * GeoJSON Polygon AOI rectangle. Used by Project Explorer for AOI capture.
   */
  function getBounds() {
    try {
      const b = map.getBounds();
      const west  = b.getWest(),  south = b.getSouth();
      const east  = b.getEast(),  north = b.getNorth();
      return {
        west, south, east, north,
        polygon: {
          type: 'Polygon',
          coordinates: [[
            [west, south], [east, south],
            [east, north], [west, north],
            [west, south],
          ]],
        },
      };
    } catch (_) { return null; }
  }

  function onCameraChange(cb) {
    if (typeof cb !== 'function') return () => {};
    camSubs.add(cb);
    return () => camSubs.delete(cb);
  }

  function onViewRender(cb) {
    if (typeof cb !== 'function') return () => {};
    viewSubs.add(cb);
    return () => viewSubs.delete(cb);
  }

  // Geographic → container-pixel projection for DOM overlays. Returns null
  // for invalid input (or points behind the globe horizon MapLibre can't
  // project) so callers hide the element rather than misplace it.
  function project(p) {
    const lat = p?.lat, lon = p?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
      const pt = map.project([lon, lat]);
      return (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) ? { x: pt.x, y: pt.y } : null;
    } catch (_) { return null; }
  }

  function setBasemap(_id) {
    // Reserved for future. Globe currently uses ESRI satellite. Wiring kept so
    // the engine-host's pass-through doesn't error.
  }

  function getNativeControls() { return { nav, scale, attr }; }

  function dispose() {
    try { cancelAnimationFrame(pulseRaf); } catch (_) {}
    try { popup?.remove(); } catch (_) {}
    try { map.off('moveend',   fireCamera); } catch (_) {}
    try { map.off('zoomend',   fireCamera); } catch (_) {}
    try { map.off('rotateend', fireCamera); } catch (_) {}
    try { map.off('pitchend',  fireCamera); } catch (_) {}
    try { map.off('move',      fireView); } catch (_) {}
    viewSubs.clear();
    try { map.removeControl(overlay); } catch (_) {}
    try { overlay.finalize?.(); } catch (_) {}
    try { map.remove(); } catch (_) {}
    camSubs.clear();
    wrap.remove();
  }

  return {
    flyTo, setSun, setLayerVisible, focus,
    getCamera, getBounds, onCameraChange, onViewRender, project,
    setBasemap, getNativeControls,
    dispose,
  };
}

export default { create };
