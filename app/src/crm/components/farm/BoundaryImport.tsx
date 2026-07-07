// =============================================================================
// BoundaryImport — the boundary-acquisition control for onboarding.
// -----------------------------------------------------------------------------
// Three ways in, one way out:
//   • Import a file   — GeoJSON (.geojson/.json), KML (@tmcw/togeojson),
//                       Shapefile (.zip via shpjs).
//   • Paste GeoJSON   — a raw FeatureCollection/Feature/Geometry blob.
//   • Preview         — a MapLibre satellite canvas that renders the parsed
//                       polygon in cobalt and springs to fit its bounds.
// Whatever comes in is normalized to a single GeoJSON Polygon or MultiPolygon
// and handed up via onGeometry(). Anything that isn't valid polygon geometry
// gets a clean inline error — we never emit a half-parsed shape.
//
// Design: matches PortfolioDashboard conventions (tokens only, tabular-nums,
// spring hover). The over-map controls read as frosted glass on the dark
// imagery canvas per DESIGN_SYSTEM §4.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import shp from 'shpjs';
import { kml } from '@tmcw/togeojson';
import { UploadCloud, ClipboardPaste, FileWarning, MapPin, X, Layers2 } from 'lucide-react';
import { cn } from '@crm/lib/utils';
import { Button } from '@crm/components/ui/button';
import { Textarea } from '@crm/components/ui/input';

// True satellite imagery (keyless) so the boundary reads over real ground —
// the "satellite-native" substrate the design system asks for.
const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'esri-imagery': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0B0A08' } },
    { id: 'esri-imagery', type: 'raster', source: 'esri-imagery' },
  ],
};

type Polygonal = GeoJSON.Polygon | GeoJSON.MultiPolygon;

// -----------------------------------------------------------------------------
// Geometry helpers (exported — the copilot review step reuses bbox/area).
// -----------------------------------------------------------------------------

/** Walk any GeoJSON object and collect every Polygon coordinate array. */
function collectPolygons(g: unknown, acc: GeoJSON.Position[][][]): void {
  if (!g || typeof g !== 'object') return;
  const node = g as { type?: string; features?: unknown[]; geometry?: unknown; geometries?: unknown[]; coordinates?: unknown };
  switch (node.type) {
    case 'FeatureCollection': node.features?.forEach((f) => collectPolygons(f, acc)); break;
    case 'Feature':           collectPolygons(node.geometry, acc); break;
    case 'GeometryCollection': node.geometries?.forEach((x) => collectPolygons(x, acc)); break;
    case 'Polygon':           acc.push(node.coordinates as GeoJSON.Position[][]); break;
    case 'MultiPolygon':      (node.coordinates as GeoJSON.Position[][][])?.forEach((c) => acc.push(c)); break;
    default: break;
  }
}

/** Reduce arbitrary GeoJSON to a single Polygon (1 ring-set) or MultiPolygon. */
export function extractPolygonal(gj: unknown): Polygonal | null {
  const acc: GeoJSON.Position[][][] = [];
  collectPolygons(gj, acc);
  const valid = acc.filter((rings) => Array.isArray(rings) && rings[0]?.length >= 4);
  if (valid.length === 0) return null;
  if (valid.length === 1) return { type: 'Polygon', coordinates: valid[0] };
  return { type: 'MultiPolygon', coordinates: valid };
}

/** Keep only the largest polygon (by outer-ring area) — for Polygon-only sinks. */
export function toSinglePolygon(geom: Polygonal): { polygon: GeoJSON.Polygon; dropped: number } {
  if (geom.type === 'Polygon') return { polygon: geom, dropped: 0 };
  const polys = geom.coordinates.map((rings) => ({ type: 'Polygon', coordinates: rings } as GeoJSON.Polygon));
  polys.sort((a, b) => polygonAreaM2(b) - polygonAreaM2(a));
  return { polygon: polys[0], dropped: polys.length - 1 };
}

/** [west, south, east, north] over every ring, or null if empty. */
export function geometryBbox(geom: Polygonal): [number, number, number, number] | null {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const ring of rings) {
    for (const pos of ring) {
      const [x, y] = pos;
      if (x < w) w = x; if (x > e) e = x;
      if (y < s) s = y; if (y > n) n = y;
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

// Geodesic ring area (spherical excess, WGS84) — same formula Turf uses.
const R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;
function ringAreaM2(coords: GeoJSON.Position[]): number {
  const len = coords.length;
  if (len < 3) return 0;
  let total = 0;
  for (let i = 0; i < len; i++) {
    const [lo1, la1] = coords[i];
    const [lo2, la2] = coords[(i + 1) % len];
    total += rad(lo2 - lo1) * (2 + Math.sin(rad(la1)) + Math.sin(rad(la2)));
  }
  return Math.abs((total * R * R) / 2);
}
function polygonAreaM2(p: GeoJSON.Polygon): number {
  if (!p.coordinates.length) return 0;
  const [outer, ...holes] = p.coordinates;
  return holes.reduce((a, h) => a - ringAreaM2(h), ringAreaM2(outer));
}
/** Approximate area in hectares across all rings (outer minus holes). */
export function geometryAreaHa(geom: Polygonal): number {
  const polys = geom.type === 'Polygon' ? [geom] : geom.coordinates.map((c) => ({ type: 'Polygon', coordinates: c } as GeoJSON.Polygon));
  return polys.reduce((a, p) => a + polygonAreaM2(p), 0) / 10_000;
}
/** Total vertex count (all rings) — a light "how detailed" readout. */
export function geometryVertexCount(geom: Polygonal): number {
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
  return rings.reduce((a, r) => a + r.length, 0);
}

// -----------------------------------------------------------------------------
// GeometryPreview — a lazily-mounted MapLibre canvas (only rendered once there
// is geometry, so a screen full of zone editors doesn't spin up empty maps).
// -----------------------------------------------------------------------------

export function GeometryPreview({ geometry, height = 260, className }: {
  geometry: Polygonal;
  height?: number;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    // `new maplibregl.Map()` throws when the browser cannot create a WebGL
    // context — hardware acceleration disabled, VM / remote desktop, driver
    // issues, or context exhaustion. This preview is non-essential, so a failure
    // must degrade to a static fallback rather than propagate as an uncaught
    // render error that unmounts the entire onboarding tree (no error boundary).
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el, style: SATELLITE_STYLE, center: [0, 20], zoom: 1.4,
        attributionControl: { compact: true }, maxPitch: 0,
      });
    } catch (e) {
      console.warn('[GeometryPreview] map init failed; showing static fallback', e);
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    // Swallow non-fatal runtime map errors (tile fetch, WebGL context lost)
    // so they never bubble into React's render error path.
    map.on('error', (ev) => { console.warn('[GeometryPreview] map error', ev?.error ?? ev); });
    map.on('load', () => {
      try {
        map.addSource('boundary', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
          id: 'boundary-fill', type: 'fill', source: 'boundary',
          paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.22 },
        });
        map.addLayer({
          id: 'boundary-line', type: 'line', source: 'boundary',
          paint: { 'line-color': '#6E97FF', 'line-width': 2.5 },
        });
        map.resize();
      } catch { /* layer setup best-effort */ }
    });
    return () => { try { map.remove(); } catch { /* ignore */ } mapRef.current = null; };
  }, []);

  // Keep the map sized to its (responsive / sheet) container.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Repaint + fly to the current geometry whenever it changes.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('boundary') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({ type: 'Feature', geometry, properties: {} } as GeoJSON.Feature);
      const bb = geometryBbox(geometry);
      if (bb) {
        map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], {
          padding: 40, maxZoom: 16, duration: 900, essential: true,
        });
      }
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }, [geometry]);

  // Graceful fallback when the browser can't render the WebGL map — the boundary
  // itself is valid and already handed up, so onboarding continues uninterrupted.
  if (failed) {
    return (
      <div
        className={cn('relative flex flex-col items-center justify-center gap-1.5 w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] text-center px-4', className)}
        style={{ height }}
        aria-label="Boundary preview unavailable"
      >
        <MapPin className="size-5 text-[var(--fg-subtle)]" />
        <div className="text-[12px] font-medium text-[var(--fg-muted)]">Map preview unavailable in this browser</div>
        <div className="text-[11px] text-[var(--fg-subtle)]">
          {geometryAreaHa(geometry).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha · {geometry.type} — the boundary is valid and will be saved.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)]', className)}
      style={{ height }}
      aria-label="Boundary preview map"
    />
  );
}

// -----------------------------------------------------------------------------
// File parsing
// -----------------------------------------------------------------------------

async function parseFile(file: File): Promise<Polygonal> {
  const name = file.name.toLowerCase();
  let gj: unknown;
  if (name.endsWith('.zip')) {
    const buf = await file.arrayBuffer();
    gj = await shp(buf); // FeatureCollection | FeatureCollection[]
  } else if (name.endsWith('.kml')) {
    const text = await file.text();
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    if (dom.querySelector('parsererror')) throw new Error('That KML file could not be parsed as XML.');
    gj = kml(dom);
  } else {
    // .geojson / .json — or an unknown extension we optimistically try as JSON.
    const text = await file.text();
    try { gj = JSON.parse(text); }
    catch { throw new Error('That file is not valid JSON/GeoJSON.'); }
  }
  const poly = extractPolygonal(gj);
  if (!poly) throw new Error('No polygon geometry found in that file. Boundaries must be a Polygon or MultiPolygon.');
  return poly;
}

// -----------------------------------------------------------------------------
// BoundaryImport
// -----------------------------------------------------------------------------

export interface BoundaryImportProps {
  /** Called with the normalized geometry (or null when cleared). */
  onGeometry: (geom: Polygonal | null) => void;
  /** Current value — lets the parent own the geometry (controlled). */
  value?: Polygonal | null;
  /** Zones/parcels want a single Polygon; the largest ring-set is kept. */
  polygonOnly?: boolean;
  /** Preview height in px (default 260; use ~180 inside a zone row). */
  height?: number;
  /** Denser paddings for embedding inside a zone editor. */
  compact?: boolean;
  /** External error to surface (e.g. the server's 422 invalid_geometry). */
  error?: string | null;
  /** Hide the built-in read-only map preview (when an editable map renders it upstream). */
  hidePreview?: boolean;
  className?: string;
}

type Mode = 'file' | 'paste';

export function BoundaryImport({
  onGeometry, value = null, polygonOnly = false, height = 260, compact = false, error = null, hidePreview = false, className,
}: BoundaryImportProps) {
  const [mode, setMode] = React.useState<Mode>('file');
  const [dragOver, setDragOver] = React.useState(false);
  const [paste, setPaste] = React.useState('');
  const [localErr, setLocalErr] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [sourceLabel, setSourceLabel] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const emit = React.useCallback((geom: Polygonal, label: string) => {
    setLocalErr(null);
    if (polygonOnly) {
      const { polygon, dropped } = toSinglePolygon(geom);
      setNotice(dropped > 0 ? `Kept the largest of ${dropped + 1} polygons for this area.` : null);
      onGeometry(polygon);
    } else {
      setNotice(geom.type === 'MultiPolygon' ? `Loaded ${geom.coordinates.length} polygons.` : null);
      onGeometry(geom);
    }
    setSourceLabel(label);
  }, [onGeometry, polygonOnly]);

  const handleFiles = React.useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true); setLocalErr(null); setNotice(null);
    try {
      const geom = await parseFile(file);
      emit(geom, file.name);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : 'Could not read that file.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [emit]);

  const handlePaste = React.useCallback(() => {
    setLocalErr(null); setNotice(null);
    const text = paste.trim();
    if (!text) { setLocalErr('Paste some GeoJSON first.'); return; }
    let gj: unknown;
    try { gj = JSON.parse(text); }
    catch { setLocalErr('That is not valid JSON.'); return; }
    const geom = extractPolygonal(gj);
    if (!geom) { setLocalErr('No polygon geometry found. Expected a Polygon, MultiPolygon, Feature, or FeatureCollection.'); return; }
    emit(geom, 'Pasted GeoJSON');
  }, [paste, emit]);

  const clear = React.useCallback(() => {
    onGeometry(null);
    setSourceLabel(null); setNotice(null); setLocalErr(null); setPaste('');
  }, [onGeometry]);

  const shownErr = error ?? localErr;

  return (
    <div className={cn('space-y-3', className)}>
      {/* Mode toggle */}
      <div className="inline-flex rounded-[var(--radius-full)] bg-[var(--surface-sunken)] p-0.5 text-[12px]">
        {(['file', 'paste'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setLocalErr(null); }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] px-3 py-1 font-medium transition-colors duration-[var(--duration-fast)]',
              mode === m ? 'bg-[var(--surface)] text-[var(--fg)] shadow-[var(--shadow-soft)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {m === 'file' ? <UploadCloud className="size-3.5" /> : <ClipboardPaste className="size-3.5" />}
            {m === 'file' ? 'Import file' : 'Paste GeoJSON'}
          </button>
        ))}
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed text-center cursor-pointer',
            'transition-colors duration-[var(--duration-fast)]',
            compact ? 'px-4 py-5' : 'px-5 py-8',
            dragOver
              ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]'
              : 'border-[var(--border-strong)] bg-[var(--surface-sunken)]/40 hover:border-[var(--accent)]',
          )}
        >
          <UploadCloud className={cn('text-[var(--accent)]', compact ? 'size-5' : 'size-6')} />
          <div className="text-[13px] font-medium text-[var(--fg)]">
            {busy ? 'Reading…' : 'Drop a boundary file or click to browse'}
          </div>
          <div className="text-[11px] text-[var(--fg-muted)]">GeoJSON · KML · Shapefile (.zip)</div>
          <input
            ref={inputRef}
            type="file"
            accept=".geojson,.json,.kml,.zip,application/geo+json,application/vnd.google-earth.kml+xml,application/zip"
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder='{ "type": "Polygon", "coordinates": [ [ [lng, lat], … ] ] }'
            className="min-h-[110px] font-[var(--font-mono)] text-[12px]"
            spellCheck={false}
          />
          <Button type="button" variant="secondary" size="sm" onClick={handlePaste}>
            <ClipboardPaste className="size-3.5" /> Parse GeoJSON
          </Button>
        </div>
      )}

      {shownErr && (
        <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--risk-critical)_40%,transparent)] bg-[color-mix(in_oklch,var(--risk-critical-fill)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--risk-critical)]">
          <FileWarning className="mt-0.5 size-3.5 shrink-0" />
          <span>{shownErr}</span>
        </div>
      )}

      {value && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="inline-flex items-center gap-1.5 text-[var(--fg-muted)]">
              <MapPin className="size-3.5 text-[var(--risk-healthy)]" />
              <span className="font-medium text-[var(--fg)]">{sourceLabel ?? 'Boundary set'}</span>
            </span>
            <span className="inline-flex items-center gap-3 tabular-nums text-[var(--fg-subtle)]">
              <span>{geometryAreaHa(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} ha</span>
              <span className="inline-flex items-center gap-1"><Layers2 className="size-3" />{geometryVertexCount(value)} pts</span>
              <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-[var(--fg-muted)] hover:text-[var(--risk-critical)] transition-colors">
                <X className="size-3.5" /> Clear
              </button>
            </span>
          </div>
          {notice && <div className="text-[11px] text-[var(--fg-muted)]">{notice}</div>}
          {!hidePreview && <GeometryPreview geometry={value} height={height} />}
        </div>
      )}
    </div>
  );
}
