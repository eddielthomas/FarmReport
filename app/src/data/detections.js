// =============================================================================
// satellite harvest -> concept-dashboard DS adapter (entry point)
// -----------------------------------------------------------------------------
// Reads the real harvested satellite data (Demoville A, sub-project 676251,
// Data Release 2 - April 2026) and shapes it into the `DS` object the
// SpectraCore concept dashboard renders.
//
// Two data sources are supported, switched via Vite env var
// VITE_DATA_SOURCE:
//   * 'bundled' (default)  — loads JSON via vite static import (no infra)
//   * 'api'                — fetches from `mvp/api` server in front of PostGIS
//                            (falls back to bundled JSON on network failure)
//
// Other env vars when source='api':
//   VITE_API_BASE          — default 'http://localhost:5180'
//   VITE_SUB_PROJECT_ID    — default '676251'
//
// Bundled JSONs that have no PostGIS counterpart (charts, dashboard, leak
// detail rows, sharepoint-index) are always loaded from the harvest tree
// regardless of source.
// =============================================================================

import manifest         from './harvest/manifest.json'             with { type: 'json' };
import poisRawBundled   from './harvest/pois.json'                 with { type: 'json' };
import frBundled        from './harvest/field-results.json'        with { type: 'json' };
import overallBundled   from './harvest/recover-overall.json'      with { type: 'json' };
import linksBundled     from './harvest/links.json'                with { type: 'json' };
import charts           from './harvest/charts.json'               with { type: 'json' };
import dashboard        from './harvest/dashboard.json'            with { type: 'json' };
import leak489654       from './harvest/leaks/489654.json'         with { type: 'json' };
import leak489656       from './harvest/leaks/489656.json'         with { type: 'json' };
import spIndex          from './harvest/sharepoint-index.json'     with { type: 'json' };
// New harvested surfaces (closes satellite data-coverage gaps).
// poi-geometry is .geojson — Vite doesn't auto-parse that extension, so we
// import it as raw text and JSON.parse once at module init.
import poiGeometryRaw   from './harvest/poi-geometry.geojson?raw';
import headerCounts     from './harvest/header-counts.json'        with { type: 'json' };
import headerFilters    from './harvest/header-filters.json'       with { type: 'json' };
import metricsValues    from './harvest/metrics-values.json'       with { type: 'json' };
import homeProjectIndex from './harvest/home-project-index.json'   with { type: 'json' };
import region           from './harvest/region.json'               with { type: 'json' };

const poiGeometry = JSON.parse(poiGeometryRaw);

// -- Optional harvest surfaces (may not exist on every checkout) -------------
// These two are produced by separate one-shot adapters and may be missing in
// a fresh clone. Vite's import.meta.glob lets us load them eagerly when present
// and fall back to empty values without throwing at module init.
//   * pipes.geojson      — Track A's GIS Cloud dump (layer 7691554).
//   * poi-attrs.json     — `mvp/scripts/extract-poi-attrs.mjs` output.
const pipesGlob = import.meta.glob('./harvest/pipes.geojson', {
  eager: true, query: '?raw', import: 'default',
});
const poiAttrsGlob = import.meta.glob('./harvest/poi-attrs.json', {
  eager: true, import: 'default',
});

let pipes = { type: 'FeatureCollection', features: [] };
const pipesRaw = pipesGlob['./harvest/pipes.geojson'];
if (typeof pipesRaw === 'string' && pipesRaw.trim().length > 0) {
  try {
    const parsed = JSON.parse(pipesRaw);
    if (parsed && Array.isArray(parsed.features)) pipes = parsed;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[satellite] pipes.geojson present but failed to parse:', e);
  }
} else {
  // eslint-disable-next-line no-console
  console.info(
    '[satellite] pipes.geojson not found — Pipe Network layer will render empty.\n' +
    '         Run scripts/dump-demoville-pipes.sh to populate it from GIS Cloud.',
  );
}

// ---- synthetic pipe fallback -------------------------------------------------
// GIS Cloud layer 7691554 is private (HTTP 403 unanonymously). When a real
// dump isn't available the Pipe Network toggle would render empty, which
// makes demos look broken. Generate a small grid of synthetic mains +
// laterals centered on the demo AOI so the layer always has something to
// show. Real harvested data, when present, takes precedence (we only
// generate when `pipes.features` is empty).
function syntheticPipes(centerLat, centerLon) {
  const features = [];
  // ~250 m per 0.0025° at this latitude — covers a ~5 km square AOI so
  // the grid spans the typical demoville extent (most leaks live within
  // a couple of km of the centroid).
  const step = 0.0025;
  const cols = 21;
  const rows = 21;
  let id = 1;
  for (let r = 0; r < rows; r++) {
    const lat = centerLat + (r - rows / 2) * step;
    features.push({
      type: 'Feature',
      properties: { id: `SYN-MAIN-E${id}`, pipe_type: 'main', diameter: 200, material: 'DI', _synthetic: true },
      geometry: {
        type: 'LineString',
        coordinates: [
          [centerLon - (cols / 2) * step, lat],
          [centerLon + (cols / 2) * step, lat],
        ],
      },
    });
    id++;
  }
  for (let c = 0; c < cols; c++) {
    const lon = centerLon + (c - cols / 2) * step;
    features.push({
      type: 'Feature',
      properties: { id: `SYN-MAIN-N${id}`, pipe_type: 'main', diameter: 200, material: 'DI', _synthetic: true },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, centerLat - (rows / 2) * step],
          [lon, centerLat + (rows / 2) * step],
        ],
      },
    });
    id++;
  }
  // Sprinkle a few diagonal laterals (thinner, mint-colored in the renderer).
  for (let k = 0; k < 18; k++) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    const lat = centerLat + (r - rows / 2) * step;
    const lon = centerLon + (c - cols / 2) * step;
    const dLat = (Math.random() - 0.5) * step * 1.4;
    const dLon = (Math.random() - 0.5) * step * 1.4;
    features.push({
      type: 'Feature',
      properties: { id: `SYN-LAT-${id}`, pipe_type: 'lateral', diameter: 50, material: 'PVC', _synthetic: true },
      geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + dLon, lat + dLat]] },
    });
    id++;
  }
  return { type: 'FeatureCollection', features };
}

if (!pipes.features?.length) {
  // No real pipe data — leave the FeatureCollection empty. The map-2d
  // engine detects this and substitutes the OSM road network at runtime
  // (via Overpass) so the Pipe Network layer reflects actual street
  // geometry instead of a synthetic rectangular grid.
  // eslint-disable-next-line no-console
  console.info('[satellite] pipes.geojson empty — map-2d will fall back to OSM road centerlines via Overpass on-demand.');
}

const poiAttrs = poiAttrsGlob['./harvest/poi-attrs.json'] ?? null;
if (!poiAttrs) {
  // eslint-disable-next-line no-console
  console.info(
    '[satellite] poi-attrs.json not found — POI ERA score / inspection point /\n' +
    '         pipe length / address will be unavailable. Run\n' +
    '         `node mvp/scripts/extract-poi-attrs.mjs` to generate it.',
  );
}

import { buildDS } from './build-ds.js';

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const useApi  = env.VITE_DATA_SOURCE === 'api';
const apiBase = (env.VITE_API_BASE ?? 'http://localhost:5180').replace(/\/+$/, '');
const subId   = env.VITE_SUB_PROJECT_ID ?? '676251';

let pois            = poisRawBundled;
let fieldResults    = frBundled;
let recoverOverall  = overallBundled;
let links           = linksBundled;
let dataSource      = 'bundled';

if (useApi) {
  const url = (path) => `${apiBase}${path}`;
  const j   = async (path) => {
    const r = await fetch(url(path));
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
  };
  try {
    const [p, f, o, l] = await Promise.all([
      j(`/api/sub-projects/${subId}/pois`),
      j(`/api/sub-projects/${subId}/field-results`),
      j(`/api/sub-projects/${subId}/overall`),
      j(`/api/sub-projects/${subId}/links`),
    ]);
    pois = p; fieldResults = f; recoverOverall = o; links = l;
    dataSource = 'api';
    // eslint-disable-next-line no-console
    console.info(`[satellite] data source: api  (base=${apiBase}  sub=${subId})`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[satellite] API fetch failed; falling back to bundled JSON:', err);
  }
}

export const DS = buildDS({
  pois,
  fieldResults,
  recoverOverall,
  links,
  charts,
  dashboard,
  leakDetails: [leak489654, leak489656],
  manifest,
  spIndex,
  source: dataSource,
  poiGeometry,
  headerCounts,
  headerFilters,
  metricsValues,
  homeProjectIndex,
  region,
  pipes,
  poiAttrs,
});

export default DS;
