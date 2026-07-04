// =============================================================================
// engines/hd-3d.js — premium Cesium HD-3D engine (lazy-loaded)
// -----------------------------------------------------------------------------
// No Cesium Ion (defaultAccessToken cleared). Uses ESRI World Imagery as the
// primary basemap with a transparent ESRI reference labels overlay. Free
// alternates: OSM streets, OFM dark.
//
// Atmosphere, fog, and HDR exposure are tuned for the cinematic feel.
//
// Engine contract + extras:
//   * setBasemap(id)     — 'satellite' | 'streets' | 'dark'
//   * setSceneMode(mode) — '3d' | '2d' | 'columbus'
//   * onCameraChange(cb) — Cesium camera.changed bus (5% threshold)
//   * getCamera()        — { lat, lon, zoom, bearing, pitch }
// =============================================================================

import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Viewer,
  Ion,
  Cartesian2,
  Cartesian3,
  Math as CesiumMath,
  ArcGisMapServerImageryProvider,
  UrlTemplateImageryProvider,
  Color,
  JulianDate,
  ClockRange,
  EasingFunction,
  SceneMode,
  SceneTransforms,
} from 'cesium';

// Disable Ion entirely — keeps the viewer from trying to fetch Ion assets.
Ion.defaultAccessToken = '';

const SAT_URL    = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const REF_URL    = 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer';
const OSM_TPL    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DARK_TPL   = 'https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png';

const SEV_HEX = { high: '#ff4060', medium: '#ffb020', low: '#4d9fff' };
const sevColor      = (s) => Color.fromCssColorString(SEV_HEX[s] ?? SEV_HEX.low);
const sevColorAlpha = (s, a) => sevColor(s).withAlpha(a);

/** Approximate altitude (m) for a slippy-map zoom level. */
const altitudeFromZoom = (z) => {
  const zz = Math.max(0, Math.min(20, z ?? 12));
  // Calibrated so z=0 ≈ 10000km, z=12 ≈ 1500m, z=18 ≈ 25m
  return Math.max(120, 40_000_000 / Math.pow(2, zz));
};

const zoomFromAltitude = (m) => {
  const z = Math.log2(40_000_000 / Math.max(50, m));
  return Math.max(0, Math.min(20, z));
};

/** GeoJSON MultiPolygon → array of Cesium PolygonHierarchy objects. */
const multiPolyToHierarchies = (mp) => {
  if (!mp || mp.type !== 'MultiPolygon') return [];
  return mp.coordinates.map((polygon) => {
    const [outer, ...holes] = polygon;
    return {
      positions: Cartesian3.fromDegreesArray(outer.flatMap(([lon, lat]) => [lon, lat])),
      holes: holes.map((ring) => ({
        positions: Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat])),
      })),
    };
  });
};

// ---- imagery providers ------------------------------------------------------

async function makeBasemapProvider(id) {
  if (id === 'satellite') {
    try {
      // Cesium 1.123: ArcGisMapServerImageryProvider.fromUrl is a static factory
      // that returns a Promise<provider>.
      return await ArcGisMapServerImageryProvider.fromUrl(SAT_URL, { enablePickFeatures: false });
    } catch (e) {
      console.warn('[hd-3d] ArcGIS satellite load failed, falling back to OSM', e);
      return new UrlTemplateImageryProvider({ url: OSM_TPL, maximumLevel: 19 });
    }
  }
  if (id === 'streets') {
    return new UrlTemplateImageryProvider({ url: OSM_TPL, maximumLevel: 19 });
  }
  if (id === 'dark') {
    return new UrlTemplateImageryProvider({ url: DARK_TPL, maximumLevel: 19 });
  }
  return new UrlTemplateImageryProvider({ url: OSM_TPL, maximumLevel: 19 });
}

// =============================================================================
// engine factory
// =============================================================================

/**
 * @param {{ mount: HTMLElement, ds: any, camera: { lat:number, lon:number, zoom:number, bearing?:number, pitch?:number } }} opts
 */
export async function create({ mount, ds, camera }) {
  // Cesium owns its own DOM, so give it a dedicated child div.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000814;';
  host.className = 'rwr-cesium-host';
  mount.appendChild(host);

  // Initial provider — start on satellite. Awaited before the Viewer is built
  // so the first frame already shows imagery (no flash of black).
  const initialProvider = await makeBasemapProvider('satellite');

  const viewer = new Viewer(host, {
    imageryProvider:                  initialProvider,
    animation:                        false,
    baseLayerPicker:                  false,
    geocoder:                         false,
    homeButton:                       false,
    sceneModePicker:                  false,
    selectionIndicator:               false,
    timeline:                         false,
    navigationHelpButton:             false,
    navigationInstructionsInitiallyVisible: false,
    infoBox:                          false,
    fullscreenButton:                 false,
    scene3DOnly:                      false,
  });

  // Atmosphere / fog / lighting — premium cinematic feel.
  const scene = viewer.scene;
  try { scene.skyAtmosphere.show          = true;  } catch (_) {}
  try { scene.globe.showGroundAtmosphere   = true; } catch (_) {}
  try { scene.fog.enabled                  = true; } catch (_) {}
  try { scene.fog.density                  = 0.0001; } catch (_) {}
  try { scene.globe.enableLighting         = true; } catch (_) {}
  try { scene.globe.depthTestAgainstTerrain = true; } catch (_) {}
  // High-DPI for sharp output.
  try { viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2); } catch (_) {}

  // Hide credit container chrome (we keep attribution via our toolbar).
  try { viewer.cesiumWidget.creditContainer.style.display = 'none'; } catch (_) {}

  // Add the reference labels overlay on top of satellite (semi-transparent).
  let refLabelsLayer = null;
  try {
    const refProvider = await ArcGisMapServerImageryProvider.fromUrl(REF_URL, { enablePickFeatures: false });
    refLabelsLayer = viewer.imageryLayers.addImageryProvider(refProvider);
    refLabelsLayer.alpha = 0.85;
  } catch (e) {
    console.warn('[hd-3d] ref labels failed', e);
  }

  // ---- entities, indexed by layer bucket ----------------------------------
  const layerEntities = { leaks: [], pois: [], aoi: [] };

  const dets = ds?.detections ?? [];

  for (const d of dets) {
    const hierarchies = multiPolyToHierarchies(d.geom);
    for (const h of hierarchies) {
      const e = viewer.entities.add({
        polygon: {
          hierarchy:    h,
          material:     sevColorAlpha(d.severity, 0.18),
          outline:      true,
          outlineColor: sevColor(d.severity),
          height:       0,
          extrudedHeight: 0,
        },
      });
      layerEntities.aoi.push(e);
    }
  }

  for (const d of dets) {
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const isLeak = d.id?.startsWith?.('LEAK-');
    const e = viewer.entities.add({
      id:       d.id,
      name:     d.name ?? d.id,
      position: Cartesian3.fromDegrees(d.lon, d.lat, 5),
      point: {
        pixelSize:    isLeak ? 12 : 8,
        color:        isLeak ? Color.RED : sevColor(d.severity),
        outlineColor: Color.WHITE,
        outlineWidth: 1.5,
        heightReference: 0,
      },
    });
    (isLeak ? layerEntities.leaks : layerEntities.pois).push(e);
  }

  // Click-to-select bubbling.
  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    const e = picked?.id;
    if (!e) return;
    const det = dets.find((d) => d.id === e.id);
    if (det) {
      try {
        window.dispatchEvent(new CustomEvent('detection:select', { detail: { detection: det } }));
      } catch (_) {}
    }
  }, 1 /* LEFT_CLICK */);

  // ---- initial camera -----------------------------------------------------
  const initLat   = camera?.lat   ?? ds?._viewport?.lat   ?? 30.0;
  const initLon   = camera?.lon   ?? ds?._viewport?.lon   ?? -95.7;
  const initZoom  = camera?.zoom  ?? ds?._viewport?.zoom  ?? 14;
  const initPitch = Number.isFinite(camera?.pitch) ? camera.pitch : -45;
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(initLon, initLat, altitudeFromZoom(initZoom)),
    orientation: {
      heading: 0,
      pitch:   CesiumMath.toRadians(initPitch),
      roll:    0,
    },
    duration: 0,
  });

  // ---- camera-change bus --------------------------------------------------
  /** @type {Set<(c:any)=>void>} */
  const camSubs = new Set();
  try { viewer.camera.percentageChanged = 0.05; } catch (_) {}
  const fireCamera = () => {
    const c = viewer.camera.positionCartographic;
    if (!c) return;
    const detail = {
      lat:     CesiumMath.toDegrees(c.latitude),
      lon:     CesiumMath.toDegrees(c.longitude),
      zoom:    zoomFromAltitude(c.height),
      bearing: CesiumMath.toDegrees(viewer.camera.heading),
      pitch:   CesiumMath.toDegrees(viewer.camera.pitch),
    };
    for (const fn of camSubs) {
      try { fn(detail); } catch (_) {}
    }
  };
  const camChangedRemover = viewer.camera.changed.addEventListener(fireCamera);

  // Continuous view bus — fires on every rendered frame in which the camera
  // actually moved (postRender + change detection), unlike camera.changed
  // which is percentage-thresholded and coarse. DOM overlays (field HUD
  // dots) subscribe here so they track the globe mid-gesture.
  const viewSubs = new Set();
  let lastViewKey = '';
  const fireView = () => {
    if (viewSubs.size === 0) return;
    const cp = viewer.camera.position;
    const key = `${cp.x.toFixed(1)},${cp.y.toFixed(1)},${cp.z.toFixed(1)},` +
                `${viewer.camera.heading.toFixed(4)},${viewer.camera.pitch.toFixed(4)}`;
    if (key === lastViewKey) return;
    lastViewKey = key;
    for (const fn of viewSubs) { try { fn(); } catch (_) {} }
  };
  const viewRenderRemover = viewer.scene.postRender.addEventListener(fireView);

  // ---- engine API ---------------------------------------------------------

  function flyTo(lat, lon, zoom) {
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(lon, lat, altitudeFromZoom(zoom)),
      orientation: {
        heading: viewer.camera.heading,
        pitch:   CesiumMath.toRadians(-45),
        roll:    0,
      },
      duration: 1.5,
      easingFunction: EasingFunction.QUARTIC_IN_OUT,
    });
  }

  function setSun({ hourUTC = 12, brightness = 100, dateISO = '2026-04-30' } = {}) {
    try {
      const hh = String(Math.floor(hourUTC)).padStart(2, '0');
      const mm = String(Math.floor((hourUTC % 1) * 60)).padStart(2, '0');
      const iso = `${dateISO}T${hh}:${mm}:00Z`;
      const t = JulianDate.fromIso8601(iso);
      viewer.clock.currentTime = t;
      viewer.clock.startTime   = t;
      viewer.clock.stopTime    = JulianDate.addHours(t, 24, new JulianDate());
      viewer.clock.clockRange  = ClockRange.LOOP_STOP;
    } catch (_) {}

    viewer.scene.globe.enableLighting = true;
    const b = Math.max(0, Math.min(150, brightness)) / 100;
    try { viewer.scene.skyAtmosphere.brightnessShift = (b - 1) * 0.5; } catch (_) {}
    try {
      if ('exposure' in viewer.scene.postProcessStages) {
        viewer.scene.postProcessStages.exposure = b;
      }
    } catch (_) {}
  }

  function setLayerVisible(id, on) {
    const list = layerEntities[id];
    if (!list) return;
    for (const e of list) e.show = !!on;
  }

  /** Swap the underlying base imagery provider (keeps reference labels). */
  async function setBasemap(id) {
    try {
      const provider = await makeBasemapProvider(id);
      // Layer 0 is always the base; replace it.
      const layers = viewer.imageryLayers;
      const old = layers.get(0);
      const fresh = layers.addImageryProvider(provider, 0);
      if (old && old !== fresh) layers.remove(old, true);
      // Hide ref labels for streets/dark (they have their own labels).
      if (refLabelsLayer) refLabelsLayer.show = (id === 'satellite');
    } catch (e) {
      console.warn('[hd-3d] setBasemap failed', e);
    }
  }

  function setSceneMode(mode) {
    try {
      if (mode === '2d')        viewer.scene.morphTo2D(2.0);
      else if (mode === 'columbus') viewer.scene.morphToColumbusView(2.0);
      else                       viewer.scene.morphTo3D(2.0);
    } catch (e) { console.warn('[hd-3d] setSceneMode failed', e); }
  }

  // Tilt the Cesium camera in place. The dashboard FLAT/3D buttons funnel
  // through engineHost.setPitch(), so honoring it here keeps the buttons
  // working when the auto-LOD has swapped to the Cesium engine. We rotate
  // around the current camera target rather than just nudging pitch so the
  // viewer stays focused on the same ground point across the tilt.
  function setPitch(deg) {
    try {
      const target = pickGroundTarget();
      const altitude = viewer.camera.positionCartographic?.height ?? 1500;
      const lonLat = target ?? {
        lon: CesiumMath.toDegrees(viewer.camera.positionCartographic.longitude),
        lat: CesiumMath.toDegrees(viewer.camera.positionCartographic.latitude),
      };
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(lonLat.lon, lonLat.lat, altitude),
        orientation: {
          heading: viewer.camera.heading,
          pitch:   CesiumMath.toRadians(-Math.abs(deg)),
          roll:    0,
        },
        duration: 0.6,
        easingFunction: EasingFunction.QUARTIC_IN_OUT,
      });
    } catch (e) { console.warn('[hd-3d] setPitch failed', e); }
  }

  function pickGroundTarget() {
    try {
      const cw = viewer.scene.canvas.clientWidth;
      const ch = viewer.scene.canvas.clientHeight;
      const ray = viewer.camera.getPickRay(new Cartesian2(cw / 2, ch / 2));
      const cart = ray && viewer.scene.globe.pick(ray, viewer.scene);
      if (!cart) return null;
      const c = viewer.scene.globe.ellipsoid.cartesianToCartographic(cart);
      return { lon: CesiumMath.toDegrees(c.longitude), lat: CesiumMath.toDegrees(c.latitude) };
    } catch (_) { return null; }
  }

  function focus(d) {
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return;
    flyTo(d.lat, d.lon, 16);
  }

  function getCamera() {
    const c = viewer.camera.positionCartographic;
    if (!c) return { lat: initLat, lon: initLon, zoom: initZoom, bearing: 0, pitch: 0 };
    return {
      lat:     CesiumMath.toDegrees(c.latitude),
      lon:     CesiumMath.toDegrees(c.longitude),
      zoom:    zoomFromAltitude(c.height),
      bearing: CesiumMath.toDegrees(viewer.camera.heading),
      pitch:   CesiumMath.toDegrees(viewer.camera.pitch),
    };
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

  // Geographic → canvas-pixel projection for DOM overlays. Returns null when
  // the point can't be projected (behind the globe, off-screen) so callers
  // hide the element rather than misplace it.
  function project(p) {
    const lat = p?.lat, lon = p?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
      const win = SceneTransforms.worldToWindowCoordinates(
        viewer.scene, Cartesian3.fromDegrees(lon, lat));
      return (win && Number.isFinite(win.x) && Number.isFinite(win.y))
        ? { x: win.x, y: win.y } : null;
    } catch (_) { return null; }
  }

  function dispose() {
    try { viewRenderRemover?.(); } catch (_) {}
    viewSubs.clear();
    try { camChangedRemover?.(); } catch (_) {}
    try { viewer.entities.removeAll(); } catch (_) {}
    try { viewer.destroy(); } catch (_) {}
    camSubs.clear();
    host.remove();
  }

  return {
    flyTo, setSun, setLayerVisible, focus,
    getCamera, onCameraChange, onViewRender, project,
    setBasemap, setSceneMode,
    setPitch,
    dispose,
  };
}

export default { create };
