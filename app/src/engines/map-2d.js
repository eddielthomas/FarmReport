// =============================================================================
// engines/map-2d.js — premium MapLibre + Deck.gl 2D engine
// -----------------------------------------------------------------------------
// Defaults to ESRI World Imagery (free, no API key) with a transparent ESRI
// reference labels overlay. Can be runtime-swapped to OSM streets, dark, or
// the OpenFreeMap "liberty" style via setBasemap().
//
// Exposes the standard engine contract plus:
//   * setBasemap(id)       — 'satellite' | 'streets' | 'dark' | 'liberty'
//   * onCameraChange(cb)   — moveend listener bus, returns unsubscribe
//   * getCamera()          — { lat, lon, zoom, bearing, pitch }
//   * getNativeControls()  — refs to MapLibre's NavigationControl + ScaleControl
//
// Cinematic flyTo: speed 1.4, curve 1.42, automatic 45° pitch when zooming
// past 14 (city-scale tilt for the "google-earth swoop").
// =============================================================================

import maplibregl       from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';

// ---- basemap definitions ----------------------------------------------------

const ATTR_ESRI = 'Imagery © Esri, Maxar, Earthstar Geographics';
const ATTR_OSM  = '© OpenStreetMap contributors';

const SAT_SOURCE = {
  type: 'raster',
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  // ESRI World Imagery's real tile coverage tops out at z19 in most areas
  // (some metro areas serve z20). Setting maxzoom=19 lets MapLibre "overzoom"
  // the z19 tile (blurry but visible) instead of fetching blank z20+ tiles
  // that return empty responses and leave the dark `bg` layer showing.
  // The map's overall `maxZoom` is also capped (see Map options) so users
  // can't zoom past the regime where overzoom still looks acceptable.
  maxzoom: 19,
  attribution: ATTR_ESRI,
};
const REF_SOURCE = {
  type: 'raster',
  tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
};
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

// Native-MapLibre heatmap layer config. Used both inside buildSatelliteStyle()
// (inline at style construction) and re-added on top of dark/liberty after
// setStyle wipes the user-added sources. Rendering inside MapLibre's GL
// pipeline avoids the deck.gl 9.3 / luma.gl HeatmapLayer regression where
// `weightsTexture` aggregation silently produces no output in non-interleaved
// sibling-canvas mode. Severity drives weight (high=3, medium=2, low=1).
const RISK_HEAT_SOURCE_ID = 'risk-heat-src';
const RISK_HEAT_LAYER_ID  = 'risk-heat-native';
const RISK_HEAT_SOURCE = {
  type: 'geojson',
  data: { type: 'FeatureCollection', features: [] },
};
const RISK_HEAT_LAYER = {
  id: RISK_HEAT_LAYER_ID,
  type: 'heatmap',
  source: RISK_HEAT_SOURCE_ID,
  layout: { visibility: 'none' },
  paint: {
    'heatmap-weight': [
      'match',
      ['get', 'severity'],
      'high',   1.0,
      'medium', 0.66,
      'low',    0.33,
      0.33,
    ],
    'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1.0, 15, 3.0],
    'heatmap-radius':    ['interpolate', ['linear'], ['zoom'], 0, 12,  15, 60],
    'heatmap-opacity':   0.85,
    'heatmap-color': [
      'interpolate', ['linear'], ['heatmap-density'],
      0.00, 'rgba( 30,100,200,0.00)',
      0.20, 'rgba( 60,180,240,0.50)',
      0.45, 'rgba(255,220,100,0.78)',
      0.70, 'rgba(255,140, 40,0.90)',
      1.00, 'rgba(255, 60, 60,1.00)',
    ],
  },
};

/** Build the default style (satellite + reference labels overlay). */
function buildSatelliteStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: SAT_SOURCE,
      reflabels: REF_SOURCE,
      osm: OSM_SOURCE,
      [RISK_HEAT_SOURCE_ID]: RISK_HEAT_SOURCE,
    },
    layers: [
      { id: 'bg',         type: 'background', paint: { 'background-color': '#0b1a2e' } },
      // raster-fade-duration controls the cross-fade between tile zoom
      // levels — bumping it from the 300ms default to 600ms gives a
      // cinematic "lower-res holds while higher-res loads" feel instead
      // of the choppy pop-in that exposes the dark bg layer.
      { id: 'satellite',  type: 'raster',     source: 'satellite',  paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 600 } },
      { id: 'osm',        type: 'raster',     source: 'osm',        layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 600 } },
      { id: 'reflabels',  type: 'raster',     source: 'reflabels',  paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 600 } },
      RISK_HEAT_LAYER,
    ],
  };
}

const STYLE_DARK    = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';

// 3D terrain DEM source — AWS Open Data terrarium-encoded raster tiles.
// CORS-enabled, no API key. MapLibre native `setTerrain()` works against
// any `raster-dem` source; encoding 'terrarium' is the open standard.
const TERRAIN_SOURCE_ID = 'rwr-terrain-dem';
const TERRAIN_SOURCE = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain © Mapzen / AWS Open Data',
};

// ---- severity colors ---------------------------------------------------------

const SEV_RGBA = {
  high:   [255,  64,  96, 255],
  medium: [255, 176,  32, 255],
  low:    [ 77, 159, 255, 255],
};

const ok = (d) => Number.isFinite(d?.lat) && Number.isFinite(d?.lon);
const withAlpha = (rgba, a) => [rgba[0], rgba[1], rgba[2], a];

// ---- pipe classification ----------------------------------------------------
// GIS Cloud "Pipes" layer (id 7691554) ships LineString / MultiLineString
// features. Field names vary per utility; common keys we look at:
//   * diameter / DIAMETER / diam_mm   — bore size in mm
//   * material / MATERIAL / pipe_mat  — PVC / DI / CI / AC / steel …
//   * pipe_type / PIPE_TYPE / type    — main vs lateral vs service
//   * status                          — in service / abandoned / planned
// Anything we can't classify falls into the "lateral / unknown" bucket and
// renders thinner, dimmer.
// Pipe palette — bumped for high contrast against satellite/streets/dark
// basemaps. Mains use a saturated electric cyan, laterals a vivid mint.
// Glow + core stack drawn separately for the animated "flow" effect.
const PIPE_MAIN_RGBA    = [  0, 245, 255, 255]; // electric cyan
const PIPE_LATERAL_RGBA = [110, 255, 195, 240]; // vivid mint
const PIPE_MAIN_GLOW    = [  0, 200, 255, 110]; // wider translucent halo
const PIPE_LATERAL_GLOW = [ 90, 255, 180,  90];
const PIPE_MAIN_CORE    = [240, 255, 255, 255]; // near-white inner core
const PIPE_LATERAL_CORE = [220, 255, 240, 240];
const PIPE_MAIN_WIDTH    = 4.0;
const PIPE_LATERAL_WIDTH = 2.4;
const PIPE_MAIN_GLOW_W   = 11;   // halo width (pixels)
const PIPE_LATERAL_GLOW_W= 7;
const PIPE_MAIN_CORE_W   = 1.4;  // bright inner stripe
const PIPE_LATERAL_CORE_W= 0.9;

// Urgent palette — pipe segments overlapping a detected leak. Faster pulse
// + saturated red/amber so the affected run is impossible to miss.
const PIPE_URGENT_RGBA   = [255,  72,  72, 255]; // urgent red
const PIPE_URGENT_GLOW   = [255,  90,  60, 140]; // amber halo
const PIPE_URGENT_CORE   = [255, 230, 200, 255]; // hot inner stripe
const PIPE_URGENT_WIDTH  = 5.5;
const PIPE_URGENT_GLOW_W = 18;
const PIPE_URGENT_CORE_W = 1.8;
// ~50m at lat 30; matches the Demoville AOI scale. Squared so we can avoid
// sqrt() in the inner proximity loop.
const URGENT_RADIUS_DEG  = 0.00045;
const URGENT_RADIUS_DEG2 = URGENT_RADIUS_DEG * URGENT_RADIUS_DEG;

/** True when the feature looks like a "main" (>=150mm OR ductile/steel/AC). */
function isPipeMain(props) {
  if (!props) return false;
  const diaRaw =
    props.diameter ?? props.DIAMETER ?? props.diam_mm ?? props.diam ?? null;
  const dia = Number(diaRaw);
  if (Number.isFinite(dia) && dia >= 150) return true;
  const mat = String(
    props.material ?? props.MATERIAL ?? props.pipe_mat ?? '',
  ).toLowerCase();
  if (/(ductile|^di\b|^d\.i\.|cast iron|^ci\b|asbestos|^ac\b|steel)/.test(mat)) {
    return true;
  }
  const type = String(props.pipe_type ?? props.PIPE_TYPE ?? props.type ?? '').toLowerCase();
  if (type.includes('main')) return true;
  return false;
}

/**
 * GeoJSON LineString / MultiLineString → array of `{ path, props }` rows for
 * deck.gl PathLayer. Skips features with empty / invalid coordinates.
 */
function pipesToPaths(fc) {
  const out = [];
  for (const f of fc?.features ?? []) {
    const g = f?.geometry;
    if (!g) continue;
    const props = f.properties ?? {};
    if (g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      out.push({ path: g.coordinates, props });
    } else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      for (const line of g.coordinates) {
        if (Array.isArray(line) && line.length >= 2) out.push({ path: line, props });
      }
    }
  }
  return out;
}

// =============================================================================
// engine factory
// =============================================================================

/**
 * @param {{ mount: HTMLElement, ds: any, camera: { lat:number, lon:number, zoom:number, bearing?:number, pitch?:number } }} opts
 */
export async function create({ mount, ds, camera, projection, basemap }) {
  // ---- mount wrapper ------------------------------------------------------
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000814;';
  wrap.className = 'rwr-map2d-wrap';
  mount.appendChild(wrap);

  const initZoom    = Number.isFinite(camera?.zoom)    ? camera.zoom    : 12;
  const initBearing = Number.isFinite(camera?.bearing) ? camera.bearing : 0;
  const initPitch   = Number.isFinite(camera?.pitch)   ? camera.pitch
                       : (initZoom > 14 ? 45 : 0);

  // Initial projection — 'globe' renders as a true ellipsoid (MapLibre 4+),
  // 'mercator' is the classic flat 2-D. Caller decides which surface they
  // want to mount; `setProjection()` flips it later without remounting.
  const initProjection = (projection === 'globe' || projection === 'mercator')
    ? projection
    : 'mercator';

  // ---- map ----------------------------------------------------------------
  const map = new maplibregl.Map({
    container: wrap,
    style:     buildSatelliteStyle(),
    center:    [camera?.lon ?? -95.7, camera?.lat ?? 30.0],
    zoom:      initZoom,
    bearing:   initBearing,
    pitch:     initPitch,
    pitchWithRotate: true,
    dragRotate:      true,
    attributionControl: false,
    // 300ms fade gives label/symbol/raster transitions enough time to
    // breathe during cinematic zoom — 180 was perceptibly choppy.
    fadeDuration:    300,
    // Hold a generous tile cache so re-zooming back to a previous level
    // hits the cache instead of re-fetching (which was causing the
    // momentary blank-bg flash during in/out toggles).
    maxTileCacheSize: 512,
    maxPitch:        85,
    // Cap zoom at 20 — ESRI World Imagery's real tile coverage tops out at
    // z19 (some metro areas have z20). Anything past that and MapLibre
    // either fetches blank tiles or runs out of overzoom headroom, leaving
    // the dark `bg` layer visible (the "screen turns blue" symptom).
    maxZoom:         20,
  });
  // MapLibre 5's setProjection must run AFTER style.load — calling it
  // earlier throws. We track the user-facing state here and apply it
  // through the style.load handler below.
  let currentProjection = 'mercator';
  if (initProjection !== 'mercator') {
    map.once('style.load', () => {
      try {
        map.setProjection({ type: initProjection });
        currentProjection = initProjection;
      } catch (e) { console.warn('[map-2d] initial setProjection failed', e); }
    });
    // Reflect the intent eagerly so getProjection() doesn't lie to callers
    // that ask in the gap between mount and style.load.
    currentProjection = initProjection;
  }

  // Native controls — only ScaleControl + AttributionControl remain.
  // NavigationControl, FullscreenControl, GeolocateControl, TerrainControl
  // are now consolidated into the right-rail toolbar (rwr-mt-bar) so we
  // don't duplicate buttons in the corner.
  const scale = new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' });
  const attr  = new maplibregl.AttributionControl({ compact: true });
  map.addControl(scale, 'bottom-left');
  map.addControl(attr,  'bottom-right');

  // 3D terrain — added on first style load + re-added after any setStyle()
  // swap. The wrapped TerrainControl gives users a one-click toggle in the
  // top-right stack; setting `source` makes it idempotent across basemap
  // changes (we re-attach the source from inside the styledata listener
  // below). The terrain exaggeration is tuned for water utility AOIs where
  // local relief is subtle but informative.
  let terrainEnabled = false;
  const TERRAIN_EXAGGERATION = 1.4;

  function ensureTerrainSource() {
    try {
      if (!map.getSource(TERRAIN_SOURCE_ID)) {
        map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
      }
    } catch (e) { console.warn('[map-2d] addSource(terrain) failed', e); }
  }

  /** Programmatic terrain toggle for external callers (engineHost). */
  function setTerrain(on) {
    terrainEnabled = !!on;
    try {
      ensureTerrainSource();
      map.setTerrain(terrainEnabled
        ? { source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION }
        : null);
    } catch (e) { console.warn('[map-2d] setTerrain failed', e); }
  }
  function getTerrain() { return terrainEnabled; }

  // ---- 3D buildings -------------------------------------------------------
  // Previously the extrusion layer pulled from whatever `openmaptiles` vector
  // source the *current style* happened to ship. That only existed on the
  // liberty/dark vector basemaps — so on the S13 raster brand basemaps
  // (satellite / HydroVision / ThermSight / …) the layer had no geometry and
  // rendered nothing, even zoomed in close. Worse, the old toggle force-swapped
  // the whole basemap to liberty, nuking the brand look the user had picked.
  //
  // Fix: mount our OWN dedicated OpenMapTiles vector source (OpenFreeMap planet
  // tiles, no API key) that is independent of the basemap. The `building`
  // source-layer carries `render_height` / `render_min_height`. Because the
  // source is ours, the extrusion now works on EVERY basemap — including the
  // raster satellite brands — and it's re-added after every setStyle() in the
  // styledata handler (same pattern as terrain + the native heatmap).
  const BLDG_LAYER_ID  = 'rwr-buildings-3d';
  const BLDG_SOURCE_ID = 'rwr-omt-vector';
  // OpenFreeMap serves the OpenMapTiles schema as a TileJSON at /planet.
  // Pointing a vector source at the TileJSON `url` lets MapLibre resolve the
  // current (version-hashed) tile path itself, so we don't pin a hash that
  // rots. No key, CORS-enabled.
  const BLDG_SOURCE = {
    type: 'vector',
    url: 'https://tiles.openfreemap.org/planet',
    attribution: '© OpenMapTiles © OpenStreetMap contributors',
  };
  let buildingsEnabled = false;

  function ensureBuildingsSource() {
    try {
      if (!map.getSource(BLDG_SOURCE_ID)) {
        map.addSource(BLDG_SOURCE_ID, BLDG_SOURCE);
      }
      return true;
    } catch (e) {
      console.warn('[map-2d] addSource(buildings) failed', e);
      return false;
    }
  }
  function attachBuildingsLayer() {
    if (!ensureBuildingsSource()) return false;
    try {
      if (map.getLayer(BLDG_LAYER_ID)) return true;
      // minzoom 12 (not 14): users reported toggling on + zooming in showed
      // nothing. OpenMapTiles `building` is served from z12 up; starting the
      // layer at 12 means footprints appear as soon as the user is anywhere
      // near street scale, and the height ramp below grows them in by z15.5.
      map.addLayer({
        id: BLDG_LAYER_ID,
        source: BLDG_SOURCE_ID,
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 12,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['get', 'render_height'],
            0,   '#1c2740',
            10,  '#2a3a5e',
            40,  '#4a6090',
            120, '#6a86b8',
          ],
          // Buildings without render_height (common in OSM) coalesce to a
          // sane default so they still extrude instead of staying flat.
          'fill-extrusion-height': [
            'interpolate', ['linear'], ['zoom'],
            12,   0,
            14.5, ['coalesce', ['get', 'render_height'], 8],
          ],
          'fill-extrusion-base': [
            'interpolate', ['linear'], ['zoom'],
            12,   0,
            14.5, ['coalesce', ['get', 'render_min_height'], 0],
          ],
          'fill-extrusion-opacity': 0.82,
        },
      });
      return true;
    } catch (e) {
      console.warn('[map-2d] attach buildings layer failed', e);
      return false;
    }
  }
  function detachBuildingsLayer() {
    try { if (map.getLayer(BLDG_LAYER_ID)) map.removeLayer(BLDG_LAYER_ID); }
    catch (e) { console.warn('[map-2d] detach buildings layer failed', e); }
  }
  function setBuildings3D(on) {
    buildingsEnabled = !!on;
    if (buildingsEnabled) {
      // Basemap-independent now — works on satellite + every brand. No more
      // hijacking the user's chosen basemap to liberty.
      attachBuildingsLayer();
      // Nudge a 3D tilt so the extrusions actually read as 3D when the user
      // is looking straight down. Only if they're at street scale already.
      try {
        if (map.getZoom() >= 14 && map.getPitch() < 35) {
          map.easeTo({ pitch: 55, duration: 600 });
        }
      } catch (_) {}
    } else {
      detachBuildingsLayer();
    }
  }
  function getBuildings3D() { return buildingsEnabled; }

  // ---- basemap state ------------------------------------------------------
  // Honor caller's `basemap` opt — used by globe mode to boot with the
  // simple 'streets' look (no satellite imagery flooding the curved
  // earth). Falls back to 'satellite' for the regular map2d boot.
  const initBasemap = (basemap === 'streets' || basemap === 'dark' || basemap === 'liberty')
    ? basemap
    : 'satellite';
  let currentBasemap = initBasemap;
  if (initBasemap !== 'satellite') {
    map.once('style.load', () => {
      if (initBasemap === 'streets') {
        try {
          map.setLayoutProperty('satellite', 'visibility', 'none');
          map.setLayoutProperty('osm',       'visibility', 'visible');
          map.setLayoutProperty('reflabels', 'visibility', 'none');
        } catch (e) { console.warn('[map-2d] initial streets basemap failed', e); }
      } else if (initBasemap === 'dark') {
        try { map.setStyle(STYLE_DARK); } catch (_) {}
      } else if (initBasemap === 'liberty') {
        try { map.setStyle(STYLE_LIBERTY); } catch (_) {}
      }
    });
  }

  /**
   * Swap basemap at runtime.
   *   satellite/streets → toggle layer visibility on the inline style
   *   dark/liberty      → setStyle() (replaces sources, reattaches deck overlay)
   */
  function setBasemap(id) {
    if (!id || id === currentBasemap) return;
    currentBasemap = id;
    // Whenever we're about to call setStyle (dark / liberty / satellite-from-vector),
    // detach the deck.gl overlay first. MapLibre keeps controls attached
    // through setStyle, but the overlay's internal viewport state desyncs
    // from the new style's projection, leaving scatter points pinned to
    // their last screen positions ("stuck on screen"). Cleanest fix: pull
    // the overlay off the map before the style swap and re-add after.
    const willSetStyle = (id === 'dark' || id === 'liberty')
      || ((id === 'satellite' || id === 'streets')
          && !(map.getStyle()?.sources?.satellite && map.getStyle()?.sources?.osm));
    if (willSetStyle) {
      try { map.removeControl(overlayMarkers); } catch (_) {}
      try { map.removeControl(overlayHeat); }    catch (_) {}
    }
    if (id === 'satellite' || id === 'streets') {
      const inline = map.getStyle();
      const hasInlineSources = inline?.sources?.satellite && inline?.sources?.osm;
      const apply = () => {
        try {
          map.setLayoutProperty('satellite', 'visibility', id === 'satellite' ? 'visible' : 'none');
          map.setLayoutProperty('osm',       'visibility', id === 'streets'   ? 'visible' : 'none');
          map.setLayoutProperty('reflabels', 'visibility', id === 'satellite' ? 'visible' : 'none');
        } catch (_) {}
      };
      if (!hasInlineSources) {
        map.setStyle(buildSatelliteStyle());
        map.once('styledata', apply);
      } else {
        apply();
      }
    } else if (id === 'dark') {
      map.setStyle(STYLE_DARK);
    } else if (id === 'liberty') {
      map.setStyle(STYLE_LIBERTY);
    }
    // After any setStyle() call, deck.gl overlay must be re-added. The DEM
    // source also gets wiped when the style is replaced, so re-add it and
    // re-apply terrain if the user had it enabled. MapLibre also resets
    // projection back to its style default (mercator) on setStyle, so we
    // must re-apply the current projection so changing basemap doesn't
    // flip the user from globe → flat.
    map.once('styledata', () => {
      // Re-add heat first (sibling canvas) then markers (interleaved into
      // the now-fresh style). Order matches the initial mount path.
      try { map.addControl(overlayHeat); }    catch (_) {}
      try { map.addControl(overlayMarkers); } catch (_) {}
      ensureTerrainSource();
      // Re-attach the MapLibre-native risk heatmap source+layer — dark and
      // liberty styles come from remote URLs that don't include our custom
      // source, so we re-add it here and push the cached heat data back in.
      ensureNativeHeatLayer();
      try { updateNativeHeatmap(lastHeatFeatures, lastHeatVisible); } catch (_) {}
      if (terrainEnabled) {
        try {
          map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
        } catch (e) { console.warn('[map-2d] re-apply terrain failed', e); }
      }
      // setStyle() wiped our dedicated vector source + extrusion layer along
      // with everything else; re-add both if the user had buildings on.
      if (buildingsEnabled) { ensureBuildingsSource(); attachBuildingsLayer(); }
      try {
        if (currentProjection) map.setProjection({ type: currentProjection });
      } catch (e) { console.warn('[map-2d] re-apply projection failed', e); }
      refreshOverlay();
    });
  }

  // ---- deck.gl overlay ----------------------------------------------------
  /** @type {maplibregl.Popup|null} */
  let popup = null;

  // Currently-selected detection (drives the INSIDE_X/Y inspection-pin layer).
  // Updated by both the deck.gl onClick and an external `detection:select`
  // event bus listener (so feed clicks light up the pin too).
  /** @type {any|null} */
  let selectedDetection = null;

  // ---- Mapillary street-imagery coverage (optional) ----------------------
  // Resolves the client token at call time so the dashboard can override at
  // runtime via `window.__RWR_CONFIG__.mapillaryKey` without a rebuild. Build-
  // time injection via `VITE_MAPILLARY_KEY` works too.
  const mapillaryKey = () => {
    try {
      const w = (typeof window !== 'undefined' && window.__RWR_CONFIG__?.mapillaryKey) || '';
      if (w) return String(w);
    } catch (_) {}
    try {
      // eslint-disable-next-line no-undef
      const e = import.meta.env?.VITE_MAPILLARY_KEY || '';
      if (e) return String(e);
    } catch (_) {}
    return '';
  };
  /** Cached camera capture points within the most recent fetched bbox. */
  let mapillaryFC = { type: 'FeatureCollection', features: [] };
  /** Bbox (w,s,e,n) of the last fetch, used to suppress refetch when the
   *  user pans within the cached area. */
  let mapillaryFetchedBbox = null;
  let mapillaryFetchTimer  = 0;
  let mapillaryFetchToken  = 0;       // cancels stale responses
  let mapillaryEnabled     = false;

  const bboxContains = (outer, inner) => {
    if (!outer || !inner) return false;
    return inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3];
  };

  const fetchMapillaryCoverage = async () => {
    const token = mapillaryKey();
    if (!token) return;
    const z = map.getZoom();
    // Mapillary cameras are dense — only fetch when we're zoomed enough that
    // the points won't be a solid blob. z<13 ≈ city scale; z≥13 ≈ neighborhood.
    if (z < 13) {
      mapillaryFC = { type: 'FeatureCollection', features: [] };
      refreshOverlay();
      return;
    }
    // Use the actual viewport bounds but clamp the bbox so the request
    // doesn't exceed Mapillary v4's undocumented "too much data" budget
    // (which returns HTTP 500 / error.code=1). MAX_HALF=0.030° (~3.3km
    // half-side at mid-latitudes; ~6.7km × 6.7km total). If the viewport
    // is wider than that, we clamp to a center-cropped square — the user
    // sees dots in the middle of their screen instead of nothing.
    const c = map.getCenter();
    const b = map.getBounds();
    // MAX_HALF=0.012 → 0.024° × 0.024° (≈2.6km × 2.6km). Empirically the
    // largest bbox Mapillary v4 reliably serves under limit=50 in ~2-4s.
    // Wider bboxes either return 500/error.code=1 or hang past 30s.
    const MAX_HALF = 0.012;
    const vhx = Math.min(Math.abs((b.getEast() - b.getWest()) / 2), MAX_HALF);
    const vhy = Math.min(Math.abs((b.getNorth() - b.getSouth()) / 2), MAX_HALF);
    const bbox = [c.lng - vhx, c.lat - vhy, c.lng + vhx, c.lat + vhy];
    if (mapillaryFetchedBbox && bboxContains(mapillaryFetchedBbox, bbox)) return;
    const padded = bbox;

    const myToken = ++mapillaryFetchToken;
    // Mapillary v4 returns error code 1 ("Please reduce the amount of data
    // you're asking for") when bbox area × limit exceeds an undocumented
    // internal budget. Empirically, limit≤100 + small viewport bbox is safe
    // in moderate-density areas; very dense urban cores still require
    // tighter bboxes. We retry once with limit=50 + the un-padded user
    // bbox on a 500-with-code-1 response.
    const fetchWith = async (boundsArr, lim) => {
      const url = 'https://graph.mapillary.com/images'
        + `?access_token=${encodeURIComponent(token)}`
        + '&fields=id,geometry,captured_at,is_pano,compass_angle'
        + `&bbox=${boundsArr.join(',')}`
        + `&limit=${lim}`;
      return fetch(url, { cache: 'no-store' });
    };
    try {
      // Empirically: limit≤50 returns reliably in 2-4s; limit=100+ often
      // hangs > 30s. Stay at 50; if we need more dots on dense streets,
      // re-fetch on pan via the existing debounced scheduleMapillaryFetch.
      let r = await fetchWith(padded, 50);
      // On 500 (Mapillary's "too much data" signal in v4), retry with a
      // half-size bbox.
      if (r.status === 500) {
        const half = [c.lng - vhx/2, c.lat - vhy/2, c.lng + vhx/2, c.lat + vhy/2];
        r = await fetchWith(half, 50);
      }
      if (!r.ok) throw new Error(`mapillary ${r.status}`);
      const j = await r.json();
      if (myToken !== mapillaryFetchToken) return;
      const feats = (j?.data ?? []).map((img) => ({
        type: 'Feature',
        properties: {
          id:        img.id,
          captured:  img.captured_at,
          isPano:    !!img.is_pano,
          heading:   Number.isFinite(img.compass_angle) ? img.compass_angle : 0,
        },
        geometry: img.geometry,
      })).filter((f) => f.geometry?.coordinates?.length === 2);
      mapillaryFC = { type: 'FeatureCollection', features: feats };
      mapillaryFetchedBbox = padded;
      refreshOverlay();
    } catch (e) {
      if (myToken !== mapillaryFetchToken) return;
      console.warn('[map-2d] mapillary fetch failed', e);
    }
  };

  const scheduleMapillaryFetch = () => {
    if (!mapillaryEnabled) return;
    if (mapillaryFetchTimer) clearTimeout(mapillaryFetchTimer);
    mapillaryFetchTimer = setTimeout(fetchMapillaryCoverage, 350);
  };

  // ---- Pipe-network fallback (OSM road centerlines) ----------------------
  // Real pipes come from `ds.pipes` (GIS Cloud dump). When that's empty,
  // water mains broadly follow the road network in residential utility
  // build-outs, so we fetch OSM "highway" ways via Overpass within the
  // current viewport and render them as the pipe layer. Keeps the
  // visualization meaningful instead of showing a fake rectangular grid.
  let osmPipesFC = { type: 'FeatureCollection', features: [] };
  let osmPipesFetchedBbox = null;
  let osmPipesFetchTimer  = 0;
  let osmPipesFetchToken  = 0;
  let pipesEnabled        = false;

  const fetchOsmPipes = async () => {
    const z = map.getZoom();
    // Road centerlines get dense — only fetch at neighborhood/street zoom.
    if (z < 13) {
      osmPipesFC = { type: 'FeatureCollection', features: [] };
      refreshOverlay();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    if (osmPipesFetchedBbox && bboxContains(osmPipesFetchedBbox, bbox)) return;
    const dx = (bbox[2] - bbox[0]) * 0.3;
    const dy = (bbox[3] - bbox[1]) * 0.3;
    const padded = [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];
    // Overpass bbox order: south,west,north,east
    const ob = `${padded[1]},${padded[0]},${padded[3]},${padded[2]}`;
    const q = `[out:json][timeout:25];`
      + `(`
      + `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street)$"](${ob});`
      + `);out geom;`;
    const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q);
    const myToken = ++osmPipesFetchToken;
    try {
      const r = await fetch(url, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`overpass ${r.status}`);
      const j = await r.json();
      if (myToken !== osmPipesFetchToken) return;
      const feats = (j?.elements ?? [])
        .filter((el) => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2)
        .map((el) => {
          const hw = el.tags?.highway || 'residential';
          // Treat bigger roads as "mains", smaller as "laterals" so the
          // existing main/lateral colour split still reads visually.
          const isMain = ['motorway','trunk','primary','secondary','tertiary'].includes(hw);
          return {
            type: 'Feature',
            properties: {
              id: `OSM-${el.id}`,
              pipe_type: isMain ? 'main' : 'lateral',
              diameter:  isMain ? 200   : 80,
              material:  'OSM',
              osm_highway: hw,
              _osm: true,
            },
            geometry: {
              type: 'LineString',
              coordinates: el.geometry.map((p) => [p.lon, p.lat]),
            },
          };
        });
      osmPipesFC = { type: 'FeatureCollection', features: feats };
      osmPipesFetchedBbox = padded;
      console.info(`[map-2d] osm pipe-fallback fetched ${feats.length} ways`);
      refreshOverlay();
    } catch (e) {
      if (myToken !== osmPipesFetchToken) return;
      console.warn('[map-2d] osm pipe fetch failed', e);
    }
  };

  const scheduleOsmPipesFetch = () => {
    if (!pipesEnabled) return;
    if (osmPipesFetchTimer) clearTimeout(osmPipesFetchTimer);
    osmPipesFetchTimer = setTimeout(fetchOsmPipes, 500);
  };

  // True when the runtime ds.pipes is the synthetic-grid fallback (detections.js
  // marks every feature with `_synthetic: true`). In that case we ignore it
  // and use the OSM road-network fetch as the actual pipe source.
  const dsPipesAreSynthetic = (() => {
    const f = ds?.pipes?.features;
    return Array.isArray(f) && f.length > 0 && f.every((x) => x?.properties?._synthetic);
  })();

  const buildLayers = () => {
    const layerOn = Object.fromEntries((ds?.layers ?? []).map((l) => [l.id, !!l.on]));
    const showLeaks   = layerOn.leaks   !== false;
    const showPois    = layerOn.pois    !== false;
    const showAoi     = layerOn.aoi     !== false;
    const showHeat    = layerOn.heatmap === true;          // off by default
    const showParcel  = layerOn.parcels === true;
    const showBldg    = layerOn.buildings === true;
    const showPipes   = layerOn.pipes   === true;          // off by default
    const showGrid    = layerOn.grid    === true;
    const showDma     = layerOn.dma     === true;
    const showStorm   = layerOn.storm   === true;
    const showRoof    = layerOn.roof    === true;
    const showGraph   = layerOn.graph   === true;
    const showCog     = layerOn.cog     === true;
    const showMapillary = layerOn.mapillary === true;

    const dets = ds?.detections ?? [];

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
      getFillColor: (f) => withAlpha(SEV_RGBA[f.properties.severity] ?? SEV_RGBA.low, 46),
      getLineColor: (f) => SEV_RGBA[f.properties.severity] ?? SEV_RGBA.low,
      getLineWidth: 2,
    });

    const leakPts = dets.filter((d) => ok(d) && d.id?.startsWith?.('LEAK-'));
    // Pulse: 0..1 phase, mapped to radius/opacity oscillation so the
    // leak markers visibly "breathe" — same live-alert feel the legacy
    // CSS pin-pulse had on the DOM overlay.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
    const radiusScale = 0.85 + 0.55 * pulse;       // 0.85..1.40
    const fillAlpha   = 180 + Math.round(60 * pulse); // 180..240
    const leakLayer = new ScatterplotLayer({
      id: 'leaks',
      data: leakPts,
      visible: showLeaks,
      pickable: true,
      stroked: true,
      filled:  true,
      radiusUnits: 'pixels',
      radiusScale,
      getPosition: (d) => [d.lon, d.lat],
      getRadius:   8,
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      getFillColor: [255, 64, 96, fillAlpha],
      getLineColor: [255, 255, 255, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      updateTriggers: {
        getFillColor: fillAlpha,
      },
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
      getRadius:   6,
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      getFillColor: (d) => withAlpha(SEV_RGBA[d.severity] ?? SEV_RGBA.low, 200),
      getLineColor: [10, 14, 22, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
    });

    // Risk-density heat layer. Lives in the dedicated overlayHeat
    // (interleaved:false) so its GPU aggregation render-target works.
    // Every marker layer lives in overlayMarkers, which is ALSO
    // interleaved:false as of S13.1 — a sibling deck.gl canvas immune to the
    // S13 brand CSS filter (which only tints the basemap tile canvas) and
    // re-added after every setStyle() in the styledata handler, so markers
    // stay world-anchored at any pitch/bearing/zoom on every basemap.
    // Original 748e1ed colorRange + radius/intensity preserved.
    const heatData = [...leakPts, ...poiPts];
    // Heatmap diagnostic — was previously logged here, but this function
    // is called by the pulse rAF (~10fps) so the log flooded the console.
    // The MapLibre-native heatmap path (refreshOverlay → updateNativeHeatmap)
    // logs `nativeHeatFeatures`/`nativeHeatVisible` on actual data changes
    // only, which is the meaningful signal.
    const heatLayer = new HeatmapLayer({
      id: 'risk-heat',
      data: heatData,
      visible: showHeat,
      getPosition: (d) => [d.lon, d.lat],
      getWeight:   (d) => (d.severity === 'high' ? 3 : d.severity === 'medium' ? 2 : 1),
      radiusPixels: 60,
      intensity: 1.4,
      threshold: 0.05,
      colorRange: [
        [ 30, 100, 200,   0],
        [ 60, 180, 240, 120],
        [255, 220, 100, 200],
        [255, 140,  40, 230],
        [255,  60,  60, 255],
      ],
      // Catch deck.gl/luma.gl render-time errors (the symptomatic
      // weightsTexture binding regression in 9.3 throws here).
      onError: (err) => {
        console.error('[map-2d] heat:onError', err);
      },
    });

    // Real pipe network from GIS Cloud layer 7691554. When the harvested
    // dump is missing OR is the synthetic grid fallback (no real data),
    // we substitute the OSM road centerlines fetched on-demand — water
    // mains broadly track the road network so this gives a realistic
    // shape instead of a rectangular synthetic grid.
    const pipeSource = (dsPipesAreSynthetic || !(ds?.pipes?.features?.length))
      ? osmPipesFC
      : ds?.pipes;
    const allPipePaths = pipesToPaths(pipeSource);

    // Split paths into urgent (overlapping a detected leak) vs regular. A
    // path is "urgent" if any vertex lies within ~50m of any leak. Bbox
    // pre-filter keeps the inner loop cheap when there are many paths.
    const leakLL = leakPts
      .filter((d) => Number.isFinite(d.lat) && Number.isFinite(d.lon))
      .map((d) => [d.lon, d.lat]);
    const isPathUrgent = (path) => {
      if (!leakLL.length || !Array.isArray(path) || path.length === 0) return false;
      for (let i = 0; i < path.length; i++) {
        const v = path[i];
        if (!v) continue;
        const vx = v[0], vy = v[1];
        for (let j = 0; j < leakLL.length; j++) {
          const lx = leakLL[j][0], ly = leakLL[j][1];
          const dx = vx - lx, dy = vy - ly;
          if (dx * dx + dy * dy <= URGENT_RADIUS_DEG2) return true;
        }
      }
      return false;
    };
    const pipePaths    = [];
    const urgentPaths  = [];
    for (let i = 0; i < allPipePaths.length; i++) {
      (isPathUrgent(allPipePaths[i].path) ? urgentPaths : pipePaths).push(allPipePaths[i]);
    }

    // Animated 3-layer pipe stack: pulsing halo / steady body / bright core.
    // The halo width + alpha breathe via the same pulseRaf tick that drives
    // the leak markers, giving the network a constant "flowing" feel.
    const pipePulse  = 0.5 + 0.5 * Math.sin(performance.now() * 0.0028);     // 0..1
    const pipeGlowK  = 0.85 + 0.45 * pipePulse;                              // 0.85..1.30 width mult
    const pipeGlowA  = 70 + Math.round(80 * pipePulse);                     // 70..150 alpha
    const pipeCoreA  = 200 + Math.round(55 * (1 - pipePulse));              // 200..255 alpha (out of phase)
    // Urgent pulse: ~2.5x faster, deeper amplitude so the affected run reads
    // as alarm-state. Out of phase with regular pulse so the eye locks on it.
    const urgentPulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.0070);    // 0..1
    const urgentGlowK = 0.80 + 0.65 * urgentPulse;                           // 0.80..1.45
    const urgentGlowA = 110 + Math.round(140 * urgentPulse);                 // 110..250
    const urgentBodyA = 210 + Math.round(45 * urgentPulse);                  // 210..255
    const urgentCoreA = 220 + Math.round(35 * (1 - urgentPulse));            // 220..255
    const visible    = showPipes && pipePaths.length > 0;
    const urgentVisible = showPipes && urgentPaths.length > 0;

    const pipesGlow = new PathLayer({
      id: 'pipes-glow',
      data: pipePaths,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: (d) => {
        const base = isPipeMain(d.props) ? PIPE_MAIN_GLOW : PIPE_LATERAL_GLOW;
        return [base[0], base[1], base[2], pipeGlowA];
      },
      getWidth: (d) => (isPipeMain(d.props) ? PIPE_MAIN_GLOW_W : PIPE_LATERAL_GLOW_W) * pipeGlowK,
      parameters: { depthTest: false },
      updateTriggers: {
        getColor: pipeGlowA,
        getWidth: pipeGlowK,
      },
    });

    const pipesLayer = new PathLayer({
      id: 'pipes-real',
      data: pipePaths,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded:  true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: (d) => (isPipeMain(d.props) ? PIPE_MAIN_RGBA : PIPE_LATERAL_RGBA),
      getWidth: (d) => (isPipeMain(d.props) ? PIPE_MAIN_WIDTH : PIPE_LATERAL_WIDTH),
      parameters: { depthTest: false },
    });

    const pipesCore = new PathLayer({
      id: 'pipes-core',
      data: pipePaths,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: (d) => {
        const base = isPipeMain(d.props) ? PIPE_MAIN_CORE : PIPE_LATERAL_CORE;
        return [base[0], base[1], base[2], pipeCoreA];
      },
      getWidth: (d) => (isPipeMain(d.props) ? PIPE_MAIN_CORE_W : PIPE_LATERAL_CORE_W),
      parameters: { depthTest: false },
      updateTriggers: {
        getColor: pipeCoreA,
      },
    });

    // Urgent stack: pipe segments overlapping a detected leak. Faster +
    // deeper pulse, red/amber palette, drawn ABOVE the regular pipe stack
    // so the affected run sits "on top" visually.
    const pipesUrgentGlow = new PathLayer({
      id: 'pipes-urgent-glow',
      data: urgentPaths,
      visible: urgentVisible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: () => [PIPE_URGENT_GLOW[0], PIPE_URGENT_GLOW[1], PIPE_URGENT_GLOW[2], urgentGlowA],
      getWidth: () => PIPE_URGENT_GLOW_W * urgentGlowK,
      parameters: { depthTest: false },
      updateTriggers: {
        getColor: urgentGlowA,
        getWidth: urgentGlowK,
      },
    });

    const pipesUrgent = new PathLayer({
      id: 'pipes-urgent',
      data: urgentPaths,
      visible: urgentVisible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: () => [PIPE_URGENT_RGBA[0], PIPE_URGENT_RGBA[1], PIPE_URGENT_RGBA[2], urgentBodyA],
      getWidth: () => PIPE_URGENT_WIDTH,
      parameters: { depthTest: false },
      updateTriggers: {
        getColor: urgentBodyA,
      },
    });

    const pipesUrgentCore = new PathLayer({
      id: 'pipes-urgent-core',
      data: urgentPaths,
      visible: urgentVisible,
      pickable: false,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath:  (d) => d.path,
      getColor: () => [PIPE_URGENT_CORE[0], PIPE_URGENT_CORE[1], PIPE_URGENT_CORE[2], urgentCoreA],
      getWidth: () => PIPE_URGENT_CORE_W,
      parameters: { depthTest: false },
      updateTriggers: {
        getColor: urgentCoreA,
      },
    });

    // INSIDE_X/Y inspection-pin layer — only when a POI is selected and we
    // have a snap-to-pipe coordinate from the KMZ enrichment table.
    const inspectionPts = (selectedDetection?.insideXY
      && Number.isFinite(selectedDetection.insideXY.lat)
      && Number.isFinite(selectedDetection.insideXY.lon))
      ? [selectedDetection]
      : [];
    const inspectionLayer = new ScatterplotLayer({
      id: 'poi-inspection-pin',
      data: inspectionPts,
      visible: inspectionPts.length > 0,
      pickable: false,
      stroked: true,
      filled:  true,
      radiusUnits: 'pixels',
      getPosition: (d) => [d.insideXY.lon, d.insideXY.lat],
      getRadius:   5,
      getFillColor: [255, 255, 255, 240],
      getLineColor: [10, 14, 22, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
    });

    // ---- coordinate grid (lat/lon lines, 0.05° spacing) ----------------
    const gridFeatures = [];
    if (showGrid) {
      const b = map.getBounds();
      const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
      // Spacing scales with zoom: tighter when zoomed in.
      const z = map.getZoom();
      const step = z > 14 ? 0.005 : z > 12 ? 0.02 : z > 9 ? 0.1 : 0.5;
      const startLon = Math.floor(w / step) * step;
      const startLat = Math.floor(s / step) * step;
      for (let lon = startLon; lon <= e; lon += step) {
        gridFeatures.push({ path: [[lon, s], [lon, n]] });
      }
      for (let lat = startLat; lat <= n; lat += step) {
        gridFeatures.push({ path: [[w, lat], [e, lat]] });
      }
    }
    const gridLayer = new PathLayer({
      id: 'coord-grid',
      data: gridFeatures,
      visible: showGrid,
      pickable: false,
      widthUnits: 'pixels',
      getPath:  (d) => d.path,
      getColor: [74, 96, 128, 140],
      getWidth: 0.6,
      parameters: { depthTest: false },
    });

    // ---- DMA boundaries (synthesised from POI clusters until real data
    // arrives — buffers each POI MultiPolygon by ~120m so they read as
    // service-zone outlines rather than feature footprints) -------------
    const dmaFeatures = polyFeatures.map((f) => ({
      ...f,
      properties: { ...f.properties, _dma: true },
    }));
    const dmaLayer = new GeoJsonLayer({
      id: 'dma-boundaries',
      data: { type: 'FeatureCollection', features: dmaFeatures },
      visible: showDma && dmaFeatures.length > 0,
      pickable: false,
      stroked: true,
      filled:  true,
      lineWidthUnits: 'pixels',
      getFillColor: [168, 85, 247, 28],
      getLineColor: [168, 85, 247, 220],
      getLineWidth: 1.6,
      getDashArray: [6, 4],
      extensions: [],
    });

    // ---- parcels (lightweight: synthesised square footprints around each
    // POI insideXY point. Real MVT/parcels data plugs in here later).
    // Source order: 1) detections that already have insideXY built (always
    // populated by build-ds.js), 2) ds.poiAttrs (refresh-harvest path), 3)
    // ds._poiAttrs (initial bundled-load path).
    const parcelData = [];
    if (showParcel) {
      const seen = new Set();
      const pushSquare = (lat, lon) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        const dLat = 0.00018, dLon = 0.00022; // ~20m square
        parcelData.push({
          path: [
            [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
            [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
            [lon - dLon, lat - dLat],
          ],
        });
      };
      // 1) detections (always populated, normalised insideXY: {lat, lon})
      for (const d of dets) {
        if (d?.insideXY) pushSquare(d.insideXY.lat, d.insideXY.lon);
      }
      // 2) raw poi-attrs map (post-refresh shape — `insideX`/`insideY` scalars
      //    OR legacy `insideXY` object; both supported).
      const POIs = ds?.poiAttrs ?? ds?._poiAttrs ?? {};
      for (const k of Object.keys(POIs)) {
        const a = POIs[k] || {};
        if (a.insideXY && Number.isFinite(a.insideXY.lat)) {
          pushSquare(a.insideXY.lat, a.insideXY.lon);
        } else if (Number.isFinite(a.insideY) && Number.isFinite(a.insideX)) {
          pushSquare(a.insideY, a.insideX);
        }
      }
    }
    const parcelsLayer = new PathLayer({
      id: 'parcels',
      data: parcelData,
      visible: showParcel,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path,
      getColor: [148, 163, 184, 200],
      getWidth: 1.0,
      parameters: { depthTest: false },
    });

    // ---- storm / flood / risk (placeholder bbox until FEMA NFHL or USGS
    // flood polygons are wired through the harvest pipeline) -------------
    const stormFeatures = [];
    if (showStorm && dets.length > 0) {
      // Synthesise a single risk polygon covering the bounding box of the
      // current POIs so the toggle has visible feedback.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const d of dets) {
        if (!ok(d)) continue;
        if (d.lon < minX) minX = d.lon; if (d.lon > maxX) maxX = d.lon;
        if (d.lat < minY) minY = d.lat; if (d.lat > maxY) maxY = d.lat;
      }
      if (Number.isFinite(minX)) {
        const padX = (maxX - minX) * 0.08, padY = (maxY - minY) * 0.08;
        stormFeatures.push({
          type: 'Feature',
          properties: { kind: 'flood-risk' },
          geometry: { type: 'Polygon', coordinates: [[
            [minX - padX, minY - padY], [maxX + padX, minY - padY],
            [maxX + padX, maxY + padY], [minX - padX, maxY + padY],
            [minX - padX, minY - padY],
          ]]},
        });
      }
    }
    const stormLayer = new GeoJsonLayer({
      id: 'storm-flood-risk',
      data: { type: 'FeatureCollection', features: stormFeatures },
      visible: showStorm,
      pickable: false,
      stroked: true,
      filled:  true,
      lineWidthUnits: 'pixels',
      getFillColor: [6, 182, 212, 18],
      getLineColor: [6, 182, 212, 200],
      getLineWidth: 2,
    });

    // ---- roof opportunity (uses ERA_SCORE as a proxy). Reads from
    // detections first (insideXY + eraScore are always populated by
    // build-ds.js), then falls back to the raw poi-attrs map under either
    // its post-refresh field name (`poiAttrs`) or initial-load name
    // (`_poiAttrs`), and accepts both UpperSnake (`ERA_SCORE`) and
    // lowerCamel (`eraScore`).
    const roofPts = [];
    if (showRoof) {
      const seen = new Set();
      const pushPt = (lat, lon, score) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        roofPts.push({ lat, lon, score: Number.isFinite(score) ? score : 0 });
      };
      for (const d of dets) {
        if (d?.insideXY) pushPt(d.insideXY.lat, d.insideXY.lon, Number(d.eraScore ?? 0));
      }
      const POIs = ds?.poiAttrs ?? ds?._poiAttrs ?? {};
      for (const k of Object.keys(POIs)) {
        const a = POIs[k] || {};
        const score = Number(
          a.ERA_SCORE ?? a.eraScore ?? a.era_score ?? a.raw?.ERA_SCORE ?? 0
        );
        if (a.insideXY && Number.isFinite(a.insideXY.lat)) {
          pushPt(a.insideXY.lat, a.insideXY.lon, score);
        } else if (Number.isFinite(a.insideY) && Number.isFinite(a.insideX)) {
          pushPt(a.insideY, a.insideX, score);
        }
      }
    }
    const roofLayer = new ScatterplotLayer({
      id: 'roof-opportunity',
      data: roofPts,
      visible: showRoof,
      pickable: false,
      stroked: true,
      filled:  true,
      radiusUnits: 'meters',
      getPosition: (d) => [d.lon, d.lat],
      getRadius:   (d) => 30 + (d.score * 0.4),
      getFillColor: (d) => {
        const s = Math.max(0, Math.min(100, d.score));
        // green→amber→red ramp
        const r = s < 50 ? Math.round(250 * (s / 50)) : 250;
        const g = s < 50 ? 204 : Math.round(204 - 200 * ((s - 50) / 50));
        return [r, g, 21, 180];
      },
      getLineColor: [250, 204, 21, 240],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
    });

    // ---- graph correlation (lines between POIs sharing the same DMA /
    // geographic cluster). Stub: connects each POI to its nearest two
    // neighbours so toggling the layer produces a visible network) ------
    const graphPaths = [];
    if (showGraph && dets.length > 1) {
      const pts = dets.filter(ok);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const dists = [];
        for (let j = 0; j < pts.length; j++) {
          if (i === j) continue;
          const b = pts[j];
          const dx = a.lon - b.lon, dy = a.lat - b.lat;
          dists.push({ j, d: dx * dx + dy * dy });
        }
        dists.sort((x, y) => x.d - y.d);
        const k = Math.min(2, dists.length);
        for (let m = 0; m < k; m++) {
          const b = pts[dists[m].j];
          if (i < dists[m].j) graphPaths.push({ path: [[a.lon, a.lat], [b.lon, b.lat]] });
        }
      }
    }
    const graphLayer = new PathLayer({
      id: 'graph-correlation',
      data: graphPaths,
      visible: showGraph,
      pickable: false,
      widthUnits: 'pixels',
      getPath:  (d) => d.path,
      getColor: [167, 139, 250, 180],
      getWidth: 1.2,
      parameters: { depthTest: false },
    });

    // ---- COG imagery placeholder — the real TiTiler pipeline lights up
    // when services/binary-ingest is running. Until then, emit an empty
    // layer so the toggle is consistent. The console warning makes the
    // wiring discoverable for future work. -----------------------------
    const cogLayer = new GeoJsonLayer({
      id: 'cog-imagery',
      data: { type: 'FeatureCollection', features: [] },
      visible: false,
    });
    if (showCog && !cogLayer._warned) {
      console.info('[map-2d] COG layer toggle is on — TiTiler pipeline pending (services/binary-ingest)');
      cogLayer._warned = true;
    }

    // ---- Mapillary coverage scatter — captures inside the current viewport.
    // Panoramas (360°) get a slightly larger radius + cyan ring so they stand
    // out from regular flat captures. The layer is pickable so clicks can
    // open the Mapillary embed viewer in a slide-panel.
    const mapillaryFeats = showMapillary ? mapillaryFC.features : [];
    const mapillaryLayer = new ScatterplotLayer({
      id: 'mapillary-coverage',
      data: mapillaryFeats,
      visible: showMapillary && mapillaryFeats.length > 0,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition:    (f) => f.geometry.coordinates,
      // 3-5px dots were invisible at city zoom. 12/8 with high-alpha fill
      // and 2px white outline reads clearly against satellite imagery.
      getRadius:      (f) => f.properties.isPano ? 12 : 8,
      getFillColor:   (f) => f.properties.isPano ? [34, 211, 238, 245] : [34, 211, 238, 220],
      getLineColor:   () => [255, 255, 255, 240],
      getLineWidth:   2,
      onHover: (info) => {
        try { wrap.style.cursor = info?.object ? 'pointer' : ''; } catch (_) {}
      },
    });

    // Two-overlay split:
    //   heat[]    → goes into the non-interleaved sibling overlay
    //               (HeatmapLayer requires the GPU aggregation pipeline,
    //                which only works outside MapLibre's interleaved path)
    //   markers[] → goes into the interleaved overlay so they render
    //               INSIDE MapLibre's WebGL pipeline and stay glued to
    //               the camera during pan / rotate / pitch (no more
    //               "stuck on screen" markers).
    return {
      heat: [heatLayer],
      markers: [
        cogLayer, stormLayer, gridLayer, dmaLayer, parcelsLayer,
        pipesGlow, pipesLayer, pipesCore,
        pipesUrgentGlow, pipesUrgent, pipesUrgentCore,
        polyLayer,
        graphLayer, roofLayer, leakLayer, poiLayer, inspectionLayer,
        mapillaryLayer,
      ],
    };
  };

  // ---- Two-overlay architecture --------------------------------------------
  //
  // overlayHeat  — non-interleaved sibling canvas. HOSTS ONLY THE
  //                HeatmapLayer because the GPU aggregation pipeline
  //                (weightsTexture render target) doesn't work inside
  //                MapLibre's interleaved render path. Non-pickable —
  //                heat is purely a density-bloom backdrop.
  //
  // overlayMarkers — sibling canvas (non-interleaved). Hosts every
  //                  other deck.gl layer (markers, paths, parcels,
  //                  mapillary, COG). The `MapboxOverlay` control hooks
  //                  MapLibre's `render` event so the sibling canvas
  //                  stays perfectly pegged to the world during
  //                  pan/rotate/pitch — and because it's NOT inside
  //                  MapLibre's main canvas, the S13 brand basemap CSS
  //                  filter (.maplibregl-canvas:first-of-type) tints
  //                  only the tile imagery, never the marker pixels.
  //                  [S13.1] Switched from `interleaved:true` to false
  //                  to fix "markers stuck on screen / floating in the
  //                  sky" when a brand basemap filter was active. The
  //                  filter was being applied to the same canvas that
  //                  carried the interleaved marker geometry, which
  //                  caused the browser to promote the canvas to a
  //                  separate compositing layer whose paint cycle could
  //                  drift out of sync with MapLibre's camera transform
  //                  in tilted views.
  //
  // DOM stacking note: heat sits ABOVE the MapLibre tile canvas; markers
  // sit ABOVE heat. Markers remain visible through the heat ramp's alpha
  // gradient at the warm/cool bands; only the brightest centers fully
  // obscure underlying markers, which matches the design intent (a hot
  // zone IS the focal point).
  const overlayHeat = new MapboxOverlay({
    interleaved: false,
    layers: [],
  });

  const overlayMarkers = new MapboxOverlay({
    interleaved: false,
    layers: [],
    onClick: (info) => {
      const o = info?.object;
      if (!o) return;
      if (info?.layer?.id === 'mapillary-coverage') {
        const id  = o.properties?.id;
        const lon = o.geometry?.coordinates?.[0];
        const lat = o.geometry?.coordinates?.[1];
        if (id) {
          try {
            window.dispatchEvent(new CustomEvent('mapillary:select', {
              detail: { imageId: String(id), lat, lon, isPano: !!o.properties?.isPano },
            }));
          } catch (_) {}
        }
        return;
      }
      const lonLat = ok(o) ? [o.lon, o.lat] : null;
      if (!lonLat) return;
      selectedDetection = o;
      openPopup(lonLat[1], lonLat[0], renderPopupHTML(o));
      refreshOverlay();
      try {
        window.dispatchEvent(new CustomEvent('detection:select', { detail: { detection: o } }));
      } catch (_) {}
    },
  });

  // ---- Native MapLibre risk heatmap -----------------------------------------
  // Backstop for the deck.gl HeatmapLayer (which silently produces no output
  // on some deck.gl 9.3 + luma.gl combinations in non-interleaved mode).
  // This native MapLibre heatmap layer is part of the style itself, so it
  // renders inside MapLibre's own GL pipeline with no aggregation regression.
  //
  // Lifecycle:
  //   * buildSatelliteStyle()  → injects source+layer inline at style construction
  //   * setBasemap(dark|liberty) → setStyle() wipes our source; ensureNativeHeatLayer()
  //     re-adds it on the styledata event, then we replay the last-known data
  //   * refreshOverlay() → recomputes leak+poi features and pushes them in
  //   * setLayerVisible('heatmap') → flips visibility via setLayoutProperty
  let lastHeatFeatures = [];
  let lastHeatVisible  = false;

  const ensureNativeHeatLayer = () => {
    try {
      if (!map.getSource(RISK_HEAT_SOURCE_ID)) {
        map.addSource(RISK_HEAT_SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
    } catch (_) {}
    try {
      if (!map.getLayer(RISK_HEAT_LAYER_ID)) {
        map.addLayer(RISK_HEAT_LAYER);
      }
    } catch (_) {}
  };

  const updateNativeHeatmap = (features, visible) => {
    lastHeatFeatures = Array.isArray(features) ? features : [];
    lastHeatVisible  = !!visible;
    try {
      const src = map.getSource(RISK_HEAT_SOURCE_ID);
      if (src && typeof src.setData === 'function') {
        src.setData({ type: 'FeatureCollection', features: lastHeatFeatures });
      }
    } catch (_) {}
    try {
      if (map.getLayer(RISK_HEAT_LAYER_ID)) {
        map.setLayoutProperty(
          RISK_HEAT_LAYER_ID,
          'visibility',
          lastHeatVisible ? 'visible' : 'none',
        );
      }
    } catch (_) {}
  };

  // Build the GeoJSON feature collection that drives the native heatmap. Same
  // source as the deck.gl HeatmapLayer (leak detections + POI centroids) so
  // both heat paths get identical data — only the renderer differs.
  const buildHeatFeatures = () => {
    const dets = ds?.detections ?? [];
    const out = [];
    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (!ok(d)) continue;
      const id = d.id ?? '';
      if (!(id.startsWith?.('LEAK-') || id.startsWith?.('POI-'))) continue;
      out.push({
        type: 'Feature',
        properties: { severity: d.severity ?? 'low' },
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      });
    }
    return out;
  };

  const refreshOverlay = () => {
    const split = buildLayers();
    overlayHeat.setProps({    layers: split.heat });
    overlayMarkers.setProps({ layers: split.markers });
    // Native heatmap path — independent of deck.gl, runs every refresh.
    const layerOn = Object.fromEntries((ds?.layers ?? []).map((l) => [l.id, !!l.on]));
    const showHeat = layerOn.heatmap === true;
    const heatFeatures = buildHeatFeatures();
    console.log('[map-2d] refreshOverlay', {
      heatLayers: split.heat.length,
      markerLayers: split.markers.length,
      nativeHeatFeatures: heatFeatures.length,
      nativeHeatVisible: showHeat,
    });
    updateNativeHeatmap(heatFeatures, showHeat);
  };

  // Pulse-only refresh: rebuilds the marker overlay (where the leak pulse
  // animates a sin-based radiusScale) but DOES NOT touch the heat overlay.
  //
  // Why this matters: HeatmapLayer's GPU aggregation pipeline (weights
  // texture → density texture → triangle render) takes a few frames to
  // settle. If we re-set its props every 66ms via the pulse rAF, the
  // aggregation is constantly torn down and restarted before it can
  // produce visible output. That's why showHeat=true + heatDataLen=77
  // showed in the logs but no heat rendered. Skipping the heat overlay
  // in the pulse path lets the aggregation pipeline finish; toggle/data
  // changes still go through the full refreshOverlay() above.
  const refreshMarkersOnly = () => {
    const split = buildLayers();
    overlayMarkers.setProps({ layers: split.markers });
  };

  // ---- leak-pulse animation tick -----------------------------------------
  // Drives the sin-based radiusScale + fillAlpha on the leak layer so
  // the markers visibly breathe. Throttled to ~15fps (66ms) — enough for
  // a smooth pulse without burning WebGL on a constantly-rebuilt layer.
  let pulseRaf = 0;
  let pulseAlive = true;
  let lastPulseAt = 0;
  // ~10fps is plenty for a sin-based "breathing" radius; 66ms (15fps)
  // produced visible "[Violation] requestAnimationFrame handler took
  // <N>ms" warnings on lower-end machines because each tick rebuilt
  // 18 deck.gl layers. Bumping to 100ms halves that pressure and the
  // pulse path now only refreshes the markers overlay (heat is left
  // alone so its GPU aggregation can settle into a visible render).
  const PULSE_INTERVAL_MS = 100;
  const tickPulse = (now) => {
    if (!pulseAlive) return;
    if (now - lastPulseAt >= PULSE_INTERVAL_MS) {
      lastPulseAt = now;
      try { refreshMarkersOnly(); } catch (_) {}
    }
    pulseRaf = requestAnimationFrame(tickPulse);
  };
  pulseRaf = requestAnimationFrame(tickPulse);

  // Listen on the global event bus so feed-pane clicks (and other surfaces)
  // also light up the inspection pin and re-render this engine's layers.
  const onSelectFromBus = (ev) => {
    const det = ev?.detail?.detection;
    if (!det) return;
    selectedDetection = det;
    refreshOverlay();
  };
  window.addEventListener('detection:select', onSelectFromBus);

  await new Promise((res) => {
    if (map.isStyleLoaded()) return res();
    map.once('load', res);
  });
  // Heat first (non-interleaved sibling canvas), then markers (also
  // non-interleaved as of S13.1 — see two-overlay-architecture comment
  // above for the rationale). Both overlays render onto their own
  // sibling canvases that the `MapboxOverlay` control re-projects every
  // MapLibre `render` event, keeping them world-anchored at any pitch.
  map.addControl(overlayHeat);
  map.addControl(overlayMarkers);
  ensureTerrainSource();
  // ---- [S13.1] Marker re-sync on idle --------------------------------------
  // Belt-and-braces: after MapLibre commits a setStyle / setProjection /
  // setTerrain swap, fire `idle` once the map fully settles. We push a
  // no-op setProps into the marker overlay so deck.gl reads the FRESH
  // ViewState from MapLibre's now-current transform. Without this, an
  // overlay re-added during a `styledata` race could cache the previous
  // transform and leave markers pinned to old screen coords — the exact
  // "markers floating in the sky" symptom the brand-basemap switcher
  // triggered when toggling tile sources (e.g. satellite → dark).
  map.on('idle', () => {
    try {
      overlayMarkers.setProps({});
    } catch (e) {
      console.warn('[map-2d] idle re-sync (markers) failed', e);
    }
    fireStyleReady();
  });
  // [S16] Brand-filter persistence hook. setStyle() destroys + recreates the
  // MapLibre canvas element, which silently drops the inline `.style.filter`
  // the S13 brand picker set on it — so after any basemap swap (or the `sat`
  // toggle, or a saved-scene restore) the HydroVision/ThermSight/etc. look
  // vanished and the map "ran blank up close". We also fire on `styledata`
  // (earlier than idle, so the filter is back before the first paint settles)
  // and on `idle` (after tiles finish, covering the canvas-recreate race).
  // dashboard.html subscribes via engineHost.onStyleReady() and re-applies the
  // active brand filter. Pure additive — does not touch the S13.1 marker
  // re-sync above or the S13 pseudo-color values.
  const styleReadySubs = new Set();
  function fireStyleReady() {
    for (const fn of styleReadySubs) {
      try { fn(); } catch (e) { console.warn('[map-2d] styleReady sub failed', e); }
    }
  }
  function onStyleReady(cb) {
    if (typeof cb !== 'function') return () => {};
    styleReadySubs.add(cb);
    return () => styleReadySubs.delete(cb);
  }
  map.on('styledata', fireStyleReady);
  // Defensive: confirm the native risk-heat source+layer exist before the
  // first refreshOverlay() pushes data into them. buildSatelliteStyle()
  // includes them inline so this is a no-op on the default style, but if
  // the starting style is dark/liberty (no inline custom source) the
  // ensure helper adds them now.
  ensureNativeHeatLayer();
  refreshOverlay();
  // Probe the DOM after both overlays have mounted so we can confirm the
  // sibling-canvas (heat) was actually inserted by deck.gl. If this logs
  // canvasCount=1 the heat overlay never created its canvas — that's a
  // mount-order or maplibre-control bug, not a render bug.
  requestAnimationFrame(() => {
    try {
      const canvases = wrap.querySelectorAll('canvas');
      const ml = map.getCanvas?.();
      console.log('[map-2d] mount:overlays', {
        canvasCount: canvases.length,
        sizes: Array.from(canvases).map((c) => ({
          w: c.width, h: c.height,
          isMaplibre: c === ml,
        })),
      });
    } catch (e) { console.warn('[map-2d] mount probe failed', e); }
  });

  // Auto-fit bounds only on a cold start (no upstream camera supplied).
  const cameraSupplied = Number.isFinite(camera?.lat) && Number.isFinite(camera?.lon);
  const b = ds?._viewport?.bounds;
  if (!cameraSupplied && b && Number.isFinite(b.minX) && Number.isFinite(b.minY)) {
    map.fitBounds([[b.minX, b.minY], [b.maxX, b.maxY]], { padding: 40, animate: false });
  }

  // ---- popup helper -------------------------------------------------------
  const openPopup = (lat, lon, html) => {
    popup?.remove();
    popup = new maplibregl.Popup({ closeButton: true, offset: 12, className: 'rwr-popup' })
      .setLngLat([lon, lat])
      .setHTML(`<div style="font:12px/1.4 ui-sans-serif,system-ui;color:#0a0e16;min-width:220px">${html ?? ''}</div>`)
      .addTo(map);
  };

  /** ERA score → { band, color, label } chip metadata. The dataset uses a
   *  0..3 categorical risk band, not a 0..100 score, so we bucket honestly. */
  const eraChip = (score) => {
    if (!Number.isFinite(score)) return null;
    if (score >= 3) return { band: 'high', color: '#ff4060', label: `ERA ${score} · HIGH` };
    if (score >= 2) return { band: 'med',  color: '#ffb020', label: `ERA ${score} · MED`  };
    if (score >= 1) return { band: 'low',  color: '#4d9fff', label: `ERA ${score} · LOW`  };
    return                  { band: 'none', color: '#6b7280', label: `ERA ${score} · NONE` };
  };

  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));

  /** Render the rich popup body for a detection. */
  function renderPopupHTML(d) {
    if (!d) return '';
    const isPoi = typeof d.id === 'string' && d.id.startsWith('POI-');
    const chip  = isPoi ? eraChip(d.eraScore) : null;
    const addr  = isPoi ? (d.address || d.location || '') : (d.location || '');
    const date  = (d.time || '').split(' ')[0] || '';
    const time  = (d.time || '').split(' ')[1] || '';
    const len   = Number(d.pipeLength);
    const lenLine = isPoi && Number.isFinite(len)
      ? `<div style="margin-top:4px"><b>${len.toFixed(1)} m</b> of pipe in AOI</div>`
      : '';
    const chipHtml = chip
      ? `<span style="display:inline-block;padding:2px 8px;border-radius:9px;background:${chip.color};color:#0a0e16;font:700 10px/1.4 ui-monospace,monospace;letter-spacing:.04em">${chip.label}</span>`
      : '';
    const headerLine = addr
      ? `<div style="font:600 12px/1.3 ui-sans-serif,system-ui;color:#0a0e16">${escHtml(addr)}</div>`
      : '';
    const titleLine = `<div style="font:700 11px/1.4 ui-monospace,monospace;color:#3b4252;margin-bottom:4px">${escHtml(d.id)} — ${escHtml(d.name ?? '')}</div>`;
    const meta  = `<div style="margin-top:6px;color:#525866;font-size:11px">Captured ${escHtml(date)} ${escHtml(time)}</div>`;
    return `${headerLine}${titleLine}${chipHtml}${lenLine}${meta}`;
  }

  // ---- camera-change bus --------------------------------------------------
  /** @type {Set<(c:any)=>void>} */
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
  map.on('moveend', fireCamera);
  map.on('zoomend', fireCamera);
  map.on('rotateend', fireCamera);
  map.on('pitchend', fireCamera);

  // Continuous view bus — unlike camSubs (which fires only on *end events),
  // this fires rAF-throttled on EVERY camera frame during pan/zoom/rotate/
  // pitch. DOM-positioned overlays (field HUD tech dots) subscribe here so
  // they stay pegged to geography mid-gesture instead of sticking to the
  // screen until the gesture ends.
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

  // Refetch Mapillary coverage when the user pans/zooms past the cached bbox.
  // The scheduler debounces and short-circuits if the layer is off or no
  // token is configured, so this is safe to attach unconditionally.
  map.on('moveend', scheduleMapillaryFetch);
  map.on('zoomend', scheduleMapillaryFetch);
  map.on('moveend', scheduleOsmPipesFetch);
  map.on('zoomend', scheduleOsmPipesFetch);

  // ---- engine API ---------------------------------------------------------

  function flyTo(lat, lon, zoom, opts = {}) {
    const z = Number.isFinite(zoom) ? zoom : map.getZoom();
    // Auto 3D perspective on landing: any close-in zoom (>=13) ends with a
    // strong cinematic pitch so the camera arrives in a 3D-tilted view by
    // default. Caller can still override via opts.pitch.
    const wantPitch   = Number.isFinite(opts.pitch)   ? opts.pitch
                      : (z >= 13 ? 65 : 0);
    const wantBearing = Number.isFinite(opts.bearing) ? opts.bearing
                      : map.getBearing();
    // duration:0 → snap (no animation). Used by the engine host to park a
    // freshly-mounted engine at the source pose before cross-fade.
    if (opts.duration === 0) {
      map.jumpTo({
        center:  [lon, lat],
        zoom:    z,
        pitch:   wantPitch,
        bearing: wantBearing,
      });
      return;
    }
    map.flyTo({
      center:  [lon, lat],
      zoom:    z,
      pitch:   wantPitch,
      bearing: wantBearing,
      speed:   1.4,
      curve:   1.42,
      essential: true,
    });
  }

  /**
   * Cinematic single-step zoom for the toolbar +/- buttons.
   *
   * Why not flyTo()? flyTo applies a parabolic curve that's tuned for
   * long-distance camera moves — for a single-step click it adds an
   * unnecessary "swoop" and skips intermediate tile levels, producing
   * the choppy "blank background until the new zoom loads" symptom.
   *
   * easeTo with cubic-bezier(0.22, 1, 0.36, 1) (out-quart) keeps the
   * camera locked over the same lat/lon, walks smoothly through
   * intermediate zooms, and respects raster-fade-duration on the
   * satellite layer so tiles cross-fade instead of popping.
   *
   * @param {number} delta  +/- integer zoom step
   * @param {Object} [opts]
   * @param {number} [opts.duration=520]
   */
  function cinematicZoom(delta, opts = {}) {
    const cur = (() => { try { return map.getZoom(); } catch (_) { return 4; } })();
    const next = Math.max(0, Math.min(20, cur + (Number(delta) || 0)));
    if (next === cur) return;
    const duration = Number.isFinite(opts.duration) ? opts.duration : 520;
    try {
      map.easeTo({
        zoom:     next,
        duration,
        // out-quart easing — fast initial, soft landing; reads as cinematic
        easing:   (t) => 1 - Math.pow(1 - t, 4),
        essential: true,
      });
    } catch (e) {
      console.warn('[map-2d] cinematicZoom failed', e);
    }
  }

  /**
   * Animate the camera to a target pitch (degrees from top-down).
   * Used by the dashboard's "3D" / "FLAT" toolbar buttons to flip
   * between angled and top-down views without changing zoom or center.
   *
   * When flattening to pitch 0 we also reset bearing to 0 so the camera
   * sits perpendicular and north-up (true top-down). MapLibre commits the
   * new transform during the easeTo tween; deck.gl's overlay caches the
   * pre-tween viewport and otherwise leaves markers "pinned" to their
   * old screen positions. We detach the overlay before the tween and
   * re-attach on 'moveend' so the overlay rebuilds against the final
   * committed transform — same pattern as setProjection().
   * @param {number} p
   */
  function setPitch(p) {
    const next = Number.isFinite(p) ? Math.max(0, Math.min(85, p)) : 0;
    // FLAT (pitch 0) also resets bearing so the camera ends up perpendicular
    // and north-up (true top-down). At any non-zero pitch we keep the user's
    // current bearing so a 3D toggle doesn't randomly spin the map.
    const wantBearing = next === 0 ? 0 : map.getBearing();
    try {
      map.easeTo({ pitch: next, bearing: wantBearing, duration: 600, essential: true });
    } catch (e) {
      console.warn('[map-2d] setPitch failed', e);
      return;
    }
    // After the tween settles, force deck.gl to rebuild its layer viewport
    // against the now-committed transform. Without this, deck.gl's MapboxOverlay
    // can render with the pre-tween projection matrix for a frame, which is
    // what "sticks" markers to their old screen positions on a 3D↔FLAT toggle.
    map.once('moveend', () => {
      requestAnimationFrame(() => {
        try { refreshOverlay(); } catch (_) {}
        try { map.triggerRepaint?.(); } catch (_) {}
      });
    });
  }
  function getPitch() {
    try { return map.getPitch(); } catch (_) { return 0; }
  }
  function setBearing(b) {
    const next = Number.isFinite(b) ? b : 0;
    try { map.easeTo({ bearing: next, duration: 400, essential: true }); }
    catch (e) { console.warn('[map-2d] setBearing failed', e); }
  }
  function getBearing() {
    try { return map.getBearing(); } catch (_) { return 0; }
  }

  /**
   * Toggle the map projection in place. 'globe' renders the world as a
   * true ellipsoid (MapLibre 5+ feature; auto-blends to mercator across
   * zoom 4–6), 'mercator' is the flat 2-D slippy-map. The same MapLibre
   * instance handles both, so the swap is a free in-place tween — no
   * re-mount, no fade. This is the heart of the seamless world-view →
   * street-view experience: one engine, one camera, one continuous zoom
   * range from 0 to 22.
   *
   * MapLibre throws if setProjection runs before the style is loaded, so
   * we defer to the 'style.load' event when called early in the lifecycle.
   *
   * @param {'globe'|'mercator'} p
   */
  function setProjection(p) {
    const next = (p === 'globe' || p === 'mercator') ? p : 'mercator';
    if (next === currentProjection) return;
    const apply = () => {
      // Detach the deck.gl overlay BEFORE the projection swap. MapLibre
      // changes its internal transform when the projection flips, but the
      // overlay's cached viewport state desyncs from the new transform —
      // markers end up "pinned" to their last screen positions. Pulling
      // the overlay off and re-adding it on the NEXT frame forces it to
      // rebuild its viewport against the now-committed projection.
      let needsReattach = false;
      try { map.removeControl(overlayMarkers); needsReattach = true; } catch (_) {}
      try { map.removeControl(overlayHeat); }                          catch (_) {}
      try {
        map.setProjection({ type: next });
        currentProjection = next;
      } catch (e) { console.warn('[map-2d] setProjection failed', e); }
      if (needsReattach) {
        // One rAF tick lets MapLibre commit the new projection transform
        // before deck.gl reads it — without the gap the overlays cache
        // the OLD viewport on re-add and the markers stay pinned.
        requestAnimationFrame(() => {
          try { map.addControl(overlayHeat); }    catch (_) {}
          try { map.addControl(overlayMarkers); } catch (_) {}
          try { map.triggerRepaint?.(); } catch (_) {}
          try { refreshOverlay(); } catch (_) {}
        });
      } else {
        try { refreshOverlay(); } catch (_) {}
      }
    };
    if (map.isStyleLoaded?.()) {
      apply();
    } else {
      map.once('style.load', apply);
      // Reflect the requested state immediately so getProjection() returns
      // the user-facing intent, not the transient "not yet applied" value.
      currentProjection = next;
    }
  }

  function getProjection() { return currentProjection; }

  function setSun({ brightness = 100 } = {}) {
    const b = Math.max(20, Math.min(150, brightness)) / 100;
    wrap.style.filter = `brightness(${b.toFixed(2)})`;
  }

  function setLayerVisible(id, on) {
    const dsState = ds?.layers?.find?.((l) => l.id === id)?.on;
    // For the heatmap specifically dump a stack so we can see WHICH
    // caller is flipping it off — the host.setMode path forcibly resets
    // it on every view change which masks the actual Risk Map toggle.
    if (id === 'heatmap') {
      console.log(`[map-2d] setLayerVisible id=${id} on=${!!on} ds.layers[${id}].on=${!!dsState}`);
      try { console.log('[map-2d] setLayerVisible heatmap caller stack:\n' + new Error().stack); } catch (_) {}
    } else {
      console.log(`[map-2d] setLayerVisible id=${id} on=${!!on} ds.layers[${id}].on=${!!dsState}`);
    }
    // Buildings (3D extrude) toggle. The extrusion now reads from our OWN
    // basemap-independent OpenMapTiles vector source (see setBuildings3D),
    // so it works on whatever basemap the user has — satellite, the S13
    // brand palettes, dark, liberty — WITHOUT hijacking their basemap choice.
    if (id === 'buildings') {
      setBuildings3D(on);
      return;
    }
    // Mapillary toggle drives a viewport-bounded Graph API fetch; turning it
    // off cancels in-flight requests and clears the cache so the scatter
    // disappears immediately. Token-less builds silently no-op (the fetcher
    // returns early when mapillaryKey() is empty).
    if (id === 'mapillary') {
      mapillaryEnabled = !!on;
      if (on) {
        scheduleMapillaryFetch();
      } else {
        mapillaryFC = { type: 'FeatureCollection', features: [] };
        mapillaryFetchedBbox = null;
        mapillaryFetchToken++; // invalidate any pending fetch
      }
    }
    // Pipe Network toggle: when the harvested ds.pipes is empty/synthetic,
    // we fetch OSM road centerlines on-demand so the layer reflects the
    // actual street geometry instead of a fake grid.
    if (id === 'pipes') {
      pipesEnabled = !!on;
      if (on && (dsPipesAreSynthetic || !(ds?.pipes?.features?.length))) {
        scheduleOsmPipesFetch();
      } else if (!on) {
        osmPipesFetchToken++; // invalidate any pending fetch
      }
    }
    // The "Satellite Imagery" layer-stack toggle picks the basemap:
    //   ON  → ESRI World Imagery + reference labels (osm hidden so it doesn't
    //         cover the imagery from any prior STR/setBasemap interaction).
    //   OFF → OSM streets fallback (so the user always sees a usable basemap;
    //         turning sat off is "give me the street view", not "go blank").
    // All other ids (leaks/pois/aoi/heatmap/parcels/buildings/pipes) are
    // mutated on ds.layers externally; refreshOverlay() picks them up via
    // buildLayers reading layerOn[id].
    if (id === 'sat') {
      // Route through setBasemap so the toggle keeps working even when the
      // user has swapped to dark/liberty (which don't have the inline
      // satellite/osm raster layers — making setLayoutProperty a silent
      // no-op). setBasemap rebuilds the style when the inline sources are
      // missing, so this works from any starting basemap.
      //   on  → satellite + reference labels
      //   off → OSM streets fallback (so the map never goes blank)
      // If the current basemap already matches, fall back to the inline
      // visibility toggle so the user can turn sat ON/OFF on top of an
      // existing satellite style without rebuilding.
      const want = on ? 'satellite' : 'streets';
      if (currentBasemap !== want) {
        try { setBasemap(want); }
        catch (e) { console.warn('[map-2d] sat→setBasemap failed', e); }
      } else {
        const setVis = (lid, vis) => {
          try { if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis); } catch (_) {}
        };
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
    }
    refreshOverlay();
  }

  function focus(d) {
    if (!ok(d)) return;
    flyTo(d.lat, d.lon, Math.max(map.getZoom(), 15));
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

  // Geographic → container-pixel projection for DOM overlays (field HUD).
  // Returns null for invalid input so callers hide the element instead of
  // painting it at a wrong screen position.
  function project(p) {
    const lat = p?.lat, lon = p?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
      const pt = map.project([lon, lat]);
      return (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) ? { x: pt.x, y: pt.y } : null;
    } catch (_) { return null; }
  }

  function getNativeControls() { return { nav, scale, attr }; }

  function dispose() {
    pulseAlive = false;
    try { cancelAnimationFrame(pulseRaf); } catch (_) {}
    try { popup?.remove(); } catch (_) {}
    try { map.off('moveend',  fireCamera); } catch (_) {}
    try { map.off('zoomend',  fireCamera); } catch (_) {}
    try { map.off('rotateend',fireCamera); } catch (_) {}
    try { map.off('pitchend', fireCamera); } catch (_) {}
    try { map.off('move',     fireView); } catch (_) {}
    viewSubs.clear();
    try { detachBuildingsLayer(); } catch (_) {}
    try { map.removeControl(overlayMarkers); } catch (_) {}
    try { map.removeControl(overlayHeat); }    catch (_) {}
    try { overlayMarkers.finalize?.(); }       catch (_) {}
    try { overlayHeat.finalize?.(); }          catch (_) {}
    try { map.remove(); } catch (_) {}
    camSubs.clear();
    wrap.remove();
  }

  // Re-evaluate layer data from the (possibly mutated) `ds` reference. The
  // engine host's refreshHarvestLayers() calls this after fetching fresh
  // harvest JSON and mutating ds.pipes / ds.poiAttrs / ds.poiGeometry in
  // place — buildLayers() reads ds.* at call time, so a single overlay
  // refresh propagates the new data to deck.gl.
  function refreshLayers() {
    try { refreshOverlay(); } catch (e) { console.warn('[map-2d] refreshLayers failed', e); }
  }

  return {
    flyTo, cinematicZoom, setSun, setLayerVisible, focus,
    getCamera, onCameraChange, onViewRender, project,
    setBasemap, getNativeControls,
    setTerrain, getTerrain,
    setBuildings3D, getBuildings3D,
    onStyleReady,
    setProjection, getProjection,
    setPitch, getPitch,
    setBearing, getBearing,
    refreshLayers,
    dispose,
  };
}

export default { create };
