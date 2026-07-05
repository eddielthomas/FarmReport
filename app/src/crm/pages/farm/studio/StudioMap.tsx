// =============================================================================
// StudioMap — the property placement editor (the heart of the Twin Studio).
// -----------------------------------------------------------------------------
// 1. SELECT YOUR PROPERTY — pick one of your onboarded farms; its real boundary
//    (from /api/farm/farms) loads onto the satellite map and the view flies to it.
// 2. PLACE TWINS ON IT — pick an object from the library and click inside the
//    property to digitize an area with a purpose (a pivot here, an orchard block
//    there, a soil sensor over there). Placed twins carry the property id, render
//    on the map, and persist to the studio library.
// Same WebGL-failure guard as the other map surfaces.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  MousePointerClick, X, Boxes, ExternalLink, Trash2, MapPinned, Layers, ChevronDown, Sprout,
  Satellite, Activity, Loader2,
} from 'lucide-react';
import { apiGet } from '@crm/lib/api';
import {
  useTwins, CATALOG, CATEGORY_LABEL, makeTwinFromCatalog, twinsToGeoJSON,
  type TwinCategory, type CatalogItem, type Twin,
} from '@crm/lib/twins-store';
import {
  fetchSignals, runScan, pollJob, bboxFromAoi,
  type SignalFeature, type ScanSignal,
} from '@crm/lib/gateway-signals';
import { StudioHeader } from './studio-ui';

interface FarmProperty {
  id: string;
  name: string;
  boundaries: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  aoi_west: number | null; aoi_south: number | null; aoi_east: number | null; aoi_north: number | null;
  crops?: string[];
}

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Esri, Maxar, Earthstar Geographics' },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0a08' } },
    { id: 'esri', type: 'raster', source: 'esri' },
  ],
};

const CATS: TwinCategory[] = ['structure', 'equipment', 'crop', 'livestock', 'water'];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// Real EO producers the operator can launch from the property surface. ndvi/evi
// are deliberately omitted (the gateway records them as an honest no_producer).
const SCAN_OPTIONS: { id: ScanSignal; label: string }[] = [
  { id: 'sar', label: 'SAR' },
  { id: 'moisture', label: 'Moisture' },
  { id: 'thermal', label: 'Thermal' },
];

// Live-signals fetch lifecycle for the selected property's bbox.
type SignalsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; features: SignalFeature[] };

function aoiCenter(p: FarmProperty): [number, number] {
  if (p.aoi_west != null && p.aoi_east != null && p.aoi_south != null && p.aoi_north != null) {
    return [(p.aoi_west + p.aoi_east) / 2, (p.aoi_south + p.aoi_north) / 2];
  }
  return [-93.63, 42.03];
}

export function StudioMap() {
  const { twins, addTwin, removeTwin } = useTwins();
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [cat, setCat] = React.useState<TwinCategory>('equipment');
  const [armed, setArmed] = React.useState<CatalogItem | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  // Property selection
  const [farms, setFarms] = React.useState<FarmProperty[] | null>(null);
  const [propertyId, setPropertyId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const property = farms?.find((f) => f.id === propertyId) ?? null;

  // Live gateway signals for the selected property's bbox.
  const [signals, setSignals] = React.useState<SignalsState>({ kind: 'idle' });
  const [refetchTick, setRefetchTick] = React.useState(0);
  const [scanPick, setScanPick] = React.useState<Set<ScanSignal>>(() => new Set<ScanSignal>(['sar', 'moisture', 'thermal']));
  const [scanBusy, setScanBusy] = React.useState(false);
  const [scanMsg, setScanMsg] = React.useState<string | null>(null);
  const bbox = React.useMemo(() => (property ? bboxFromAoi(property) : null), [property]);
  const bboxKey = bbox ? bbox.join(',') : '';
  const aliveRef = React.useRef(true);
  React.useEffect(() => () => { aliveRef.current = false; }, []);

  // Twins belonging to the selected property (parcelId === propertyId).
  const propertyTwins = React.useMemo(
    () => (propertyId ? twins.filter((t) => t.parcelId === propertyId) : twins.filter((t) => !t.parcelId)),
    [twins, propertyId],
  );

  // Refs so the once-bound map click handler sees current state.
  const armedRef = React.useRef<CatalogItem | null>(null); armedRef.current = armed;
  const propRef = React.useRef<string | null>(null); propRef.current = propertyId;
  const placeRef = React.useRef<(lngLat: [number, number]) => void>(() => {});
  placeRef.current = (lngLat) => {
    const item = armedRef.current;
    if (!item) return;
    const twin = makeTwinFromCatalog(item, propRef.current);
    if (twin.geom.type === 'point') { twin.geom.lng = lngLat[0]; twin.geom.lat = lngLat[1]; }
    else if (twin.geom.type === 'circle' || twin.geom.type === 'rect') twin.geom.center = lngLat;
    else if (twin.geom.type === 'polyline') twin.geom.points = [lngLat, [lngLat[0] + 0.0008, lngLat[1] + 0.0005]];
    addTwin(twin);
    setSelected(twin.id);
    setArmed(null);
  };

  // Fetch the operator's farms (properties).
  React.useEffect(() => {
    let live = true;
    apiGet<FarmProperty[]>('/farm/farms')
      .then((rows) => { if (!live) return; setFarms(rows); if (rows.length && !propertyId) setPropertyId(rows[0].id); })
      .catch(() => { if (live) setFarms([]); });
    return () => { live = false; };
  }, []);

  // Init map once.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({ container: el, style: SATELLITE_STYLE, center: [-93.63, 42.03], zoom: 13, attributionControl: { compact: true }, maxPitch: 0 });
    } catch (e) { console.warn('[StudioMap] WebGL unavailable', e); setFailed(true); return; }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('error', (ev) => console.warn('[StudioMap] map error', ev?.error ?? ev));
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('property', { type: 'geojson', data: EMPTY_FC });
      map.addSource('twin-poly', { type: 'geojson', data: EMPTY_FC });
      map.addSource('twin-line', { type: 'geojson', data: EMPTY_FC });
      map.addSource('twin-point', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: 'property-fill', type: 'fill', source: 'property', paint: { 'fill-color': '#4C7EFF', 'fill-opacity': 0.06 } });
      map.addLayer({ id: 'property-line', type: 'line', source: 'property', paint: { 'line-color': '#6E97FF', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'twin-poly-fill', type: 'fill', source: 'twin-poly', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 } });
      map.addLayer({ id: 'twin-poly-line', type: 'line', source: 'twin-poly', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
      map.addLayer({ id: 'twin-line', type: 'line', source: 'twin-line', paint: { 'line-color': ['get', 'color'], 'line-width': 3 } });
      map.addLayer({ id: 'twin-point', type: 'circle', source: 'twin-point', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'twin-label', type: 'symbol', source: 'twin-point', layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top' }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
      // Live gateway signals overlay (drawn under twins so twins stay clickable).
      map.addSource('signals', { type: 'geojson', data: EMPTY_FC });
      map.addLayer({ id: 'signals-glow', type: 'circle', source: 'signals', paint: { 'circle-radius': 9, 'circle-color': '#2DD4BF', 'circle-opacity': 0.18, 'circle-blur': 0.6 } }, 'twin-poly-fill');
      map.addLayer({ id: 'signals-dot', type: 'circle', source: 'signals', paint: { 'circle-radius': 4, 'circle-color': '#2DD4BF', 'circle-stroke-color': '#04201c', 'circle-stroke-width': 1 } }, 'twin-poly-fill');
      setReady(true);
      map.resize();
    });
    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['twin-poly-fill', 'twin-point', 'twin-line'] });
      const hit = hits.find((f) => f.properties && (f.properties as { id?: string }).id);
      if (hit) { setArmed(null); setSelected(String((hit.properties as { id: string }).id).replace(/__c$/, '')); return; }
      if (armedRef.current) placeRef.current([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on('mousemove', (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['twin-poly-fill', 'twin-point', 'twin-line'] });
      map.getCanvas().style.cursor = armedRef.current ? 'crosshair' : hits.length ? 'pointer' : '';
    });
    return () => { try { map.remove(); } catch { /* ignore */ } mapRef.current = null; };
  }, []);

  // Draw the selected property boundary + fly to it.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !property) return;
    const feat: GeoJSON.FeatureCollection = property.boundaries
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: property.boundaries }] }
      : EMPTY_FC;
    (map.getSource('property') as maplibregl.GeoJSONSource | undefined)?.setData(feat);
    if (property.aoi_west != null && property.aoi_east != null && property.aoi_south != null && property.aoi_north != null) {
      map.fitBounds([[property.aoi_west, property.aoi_south], [property.aoi_east, property.aoi_north]], { padding: 80, maxZoom: 16, duration: 900 });
    } else {
      map.flyTo({ center: aoiCenter(property), zoom: 15 });
    }
  }, [property, ready]);

  // Push property twins → map sources.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc = twinsToGeoJSON(propertyTwins);
    (map.getSource('twin-poly') as maplibregl.GeoJSONSource | undefined)?.setData(fc.polygons);
    (map.getSource('twin-line') as maplibregl.GeoJSONSource | undefined)?.setData(fc.lines);
    (map.getSource('twin-point') as maplibregl.GeoJSONSource | undefined)?.setData(fc.points);
  }, [propertyTwins, ready]);

  // Fetch live gateway signals for the property's bbox (re-runs after a scan).
  React.useEffect(() => {
    if (!bbox) { setSignals({ kind: 'idle' }); return; }
    let live = true;
    setSignals({ kind: 'loading' });
    fetchSignals(bbox)
      .then((r) => {
        if (!live) return;
        if (!r.configured) { setSignals({ kind: 'unconfigured' }); return; }
        setSignals({ kind: 'ready', features: r.collection.features ?? [] });
      })
      .catch((e) => { if (live) setSignals({ kind: 'error', message: (e as Error)?.message ?? 'fetch_failed' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bboxKey, refetchTick]);

  // Push signal features (those carrying geometry) onto the map overlay.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const feats = signals.kind === 'ready' ? signals.features.filter((f) => f && f.geometry) : [];
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: feats as unknown as GeoJSON.Feature[] };
    (map.getSource('signals') as maplibregl.GeoJSONSource | undefined)?.setData(fc);
  }, [signals, ready]);

  // Launch a real scan for the property bbox, then poll the job and refresh signals.
  async function handleScan() {
    if (!bbox || scanBusy) return;
    const picked = SCAN_OPTIONS.map((o) => o.id).filter((id) => scanPick.has(id));
    if (picked.length === 0) { setScanMsg('Pick at least one signal'); return; }
    setScanBusy(true); setScanMsg('Queuing scan…');
    try {
      const r = await runScan(bbox, picked);
      if (!aliveRef.current) return;
      if (!r.configured) { setSignals({ kind: 'unconfigured' }); setScanMsg(null); return; }
      const jobId = r.ack.jobId;
      setScanMsg(`Scan ${r.ack.status ?? 'queued'} · ${jobId.slice(0, 16)}`);
      // Poll-fallback (browser EventSource can't send the bearer header). Bounded.
      let tries = 0;
      const poll = async () => {
        if (!aliveRef.current) return;
        tries += 1;
        try {
          const jr = await pollJob(jobId);
          if (aliveRef.current && jr.configured) {
            const st = String(jr.job.status ?? 'running');
            setScanMsg(`Scan ${st} · ${jobId.slice(0, 16)}`);
            if (/complete|done|success|finished|error|failed/i.test(st)) { setRefetchTick((t) => t + 1); return; }
          }
        } catch { /* transient — keep polling */ }
        if (tries < 6) setTimeout(poll, 5000);
        else if (aliveRef.current) setRefetchTick((t) => t + 1);
      };
      setTimeout(poll, 4000);
    } catch (e) {
      if (aliveRef.current) setScanMsg((e as Error)?.message ?? 'Scan failed');
    } finally {
      if (aliveRef.current) setScanBusy(false);
    }
  }

  const signalCount = signals.kind === 'ready' ? signals.features.length : 0;

  const sel = twins.find((t) => t.id === selected) ?? null;
  const items = CATALOG.filter((i) => i.category === cat);
  const canPlace = !!propertyId;

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <StudioHeader
        crumbs={<><a href="/studio.html?view=explorer" className="hover:text-[var(--fg)]">Studio</a><span className="mx-2 opacity-40">/</span><span className="text-[var(--fg)]">Property Map</span></>}
        right={
          <>
            {/* Property selector */}
            <div className="relative">
              <button onClick={() => setPickerOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--fg)] hover:border-[var(--accent)]">
                <Sprout className="size-3.5 text-[var(--accent)]" />
                {property ? property.name : farms === null ? 'Loading…' : 'Select property'}
                <ChevronDown className="size-3.5 opacity-60" />
              </button>
              {pickerOpen && (
                <div className="absolute right-0 top-full z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-1 shadow-[var(--shadow-popover)]">
                  {(farms ?? []).length === 0 ? (
                    <div className="px-3 py-3 text-xs text-[var(--fg-muted)]">No farms yet. <a href="/operations.html?view=onboard" className="text-[var(--accent)] hover:underline">Onboard a farm →</a></div>
                  ) : (
                    (farms ?? []).map((f) => (
                      <button key={f.id} onClick={() => { setPropertyId(f.id); setPickerOpen(false); setSelected(null); }} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${f.id === propertyId ? 'bg-[color-mix(in_oklch,var(--accent)_12%,transparent)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--surface-sunken)]'}`}>
                        <MapPinned className="size-3.5 text-[var(--accent)]" /><span className="flex-1 truncate">{f.name}</span>
                        {f.id === propertyId && <span className="text-[var(--accent)]">✓</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <a href="/studio.html?view=explorer" className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)] hover:text-[var(--accent)]"><Boxes className="size-3.5" /> Explorer</a>
            <a href="/operations.html" className="text-xs text-[var(--fg-muted)] hover:text-[var(--accent)]">← Portfolio</a>
          </>
        }
      />

      <div className="relative flex-1">
        {failed ? (
          <div className="grid h-full min-h-[70vh] place-items-center"><div className="text-center text-[var(--fg-muted)]"><MapPinned className="mx-auto size-6" /><p className="mt-2 text-sm">Map preview needs WebGL, which this browser couldn't start.</p></div></div>
        ) : (
          <div ref={containerRef} className="absolute inset-0" style={{ minHeight: '70vh' }} aria-label="Property placement map" />
        )}

        {/* No-property prompt */}
        {!canPlace && !failed && (
          <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center">
            <div className="pointer-events-auto rounded-[var(--radius-xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] px-4 py-3 text-center text-sm text-[var(--fg-muted)] shadow-[var(--shadow-popover)] backdrop-blur-xl">
              <Sprout className="mx-auto size-5 text-[var(--accent)]" />
              <div className="mt-1 font-medium text-[var(--fg)]">Select your property to begin</div>
              <div className="text-xs">Use the property picker (top-right), then place twins on it.</div>
            </div>
          </div>
        )}

        {/* Object library palette */}
        <div className={`absolute left-4 top-4 w-64 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] p-3 shadow-[var(--shadow-popover)] backdrop-blur-xl transition ${canPlace ? '' : 'opacity-50'}`}>
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--accent)]"><Layers className="size-3.5" /> Object library</div>
          <div className="mb-2 flex flex-wrap gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5 text-[10px]">
            {CATS.map((c) => <button key={c} onClick={() => setCat(c)} className={`rounded-full px-2 py-0.5 transition ${cat === c ? 'bg-[var(--accent)] text-[var(--fg-on-accent)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]'}`}>{CATEGORY_LABEL[c].split(' ')[0]}</button>)}
          </div>
          <div className="grid max-h-[280px] grid-cols-2 gap-1.5 overflow-y-auto">
            {items.map((item) => {
              const on = armed?.kind === item.kind;
              return (
                <button key={item.kind} disabled={!canPlace} onClick={() => setArmed(on ? null : item)} className={`flex flex-col items-center gap-1 rounded-[var(--radius-lg)] border p-2 text-center text-[11px] transition disabled:cursor-not-allowed ${on ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_14%,transparent)]' : 'border-[var(--border)] bg-[var(--surface-sunken)] hover:border-[var(--accent)]'}`}>
                  <span className="text-lg">{item.icon}</span><span className="text-[var(--fg)]">{item.name}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--fg-subtle)]">
            <MousePointerClick className="size-3" />
            {!canPlace ? 'Select a property first' : armed ? <span className="text-[var(--accent)]">Click the property to place “{armed.name}”</span> : 'Pick an object, then click the property'}
          </p>
        </div>

        {/* Right-side column: twin summary/selection + live gateway signals */}
        <div className="absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-64 flex-col gap-3 overflow-y-auto">
        <div className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] p-3 shadow-[var(--shadow-popover)] backdrop-blur-xl">
          {sel ? (
            <div>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex size-8 items-center justify-center rounded-lg text-lg" style={{ background: sel.color + '22', border: `1px solid ${sel.color}55` }}>{sel.icon}</span>
                  <div><div className="text-sm font-medium text-[var(--fg)]">{sel.name}</div><div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{CATEGORY_LABEL[sel.category]}</div></div>
                </div>
                <button onClick={() => setSelected(null)} className="text-[var(--fg-muted)] hover:text-[var(--fg)]"><X className="size-4" /></button>
              </div>
              <div className="mt-3 flex flex-col gap-1.5">
                <a href={`/studio.html?twin=${sel.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--fg-on-accent)] hover:brightness-110"><ExternalLink className="size-3.5" /> Open workspace</a>
                <button onClick={() => { removeTwin(sel.id); setSelected(null); }} className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] px-3 py-2 text-xs text-[var(--fg-muted)] hover:border-[var(--risk-critical)] hover:text-[var(--risk-critical)]"><Trash2 className="size-3.5" /> Remove from property</button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]"><Boxes className="size-3.5 text-[var(--accent)]" /> {property ? property.name : 'Property'}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-[var(--fg)]">{propertyTwins.length}</div>
              <div className="text-[11px] text-[var(--fg-subtle)]">twins on this property</div>
              {propertyTwins.length > 0 && (
                <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                  {propertyTwins.slice(0, 12).map((t) => (
                    <button key={t.id} onClick={() => { setSelected(t.id); mapRef.current?.flyTo({ center: centerOf(t), zoom: 16 }); }} className="flex w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1.5 text-left text-xs hover:border-[var(--accent)]">
                      <span>{t.icon}</span><span className="flex-1 truncate text-[var(--fg)]">{t.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Live gateway signals + Run scan — driven by the property's bbox. */}
        {property && (
          <div className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[color-mix(in_oklch,var(--surface)_92%,transparent)] p-3 shadow-[var(--shadow-popover)] backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-muted)]">
                <Satellite className="size-3.5 text-[var(--accent)]" /> Live signals
              </div>
              {signals.kind === 'loading' && <Loader2 className="size-3.5 animate-spin text-[var(--fg-subtle)]" />}
              {signals.kind === 'ready' && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,var(--risk-healthy)_45%,transparent)] bg-[color-mix(in_oklch,var(--risk-healthy-fill)_55%,transparent)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--risk-healthy)]">
                  <Activity className="size-3" /> {signalCount}
                </span>
              )}
            </div>

            {!bbox ? (
              <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">This property has no bounding box yet — add one to pull live signals.</p>
            ) : signals.kind === 'unconfigured' ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--fg-subtle)]">Connect the AlphaGeo gateway to see live signals.</p>
            ) : signals.kind === 'error' ? (
              <p className="mt-2 text-[11px] text-[var(--risk-high)]">Couldn’t load signals — {signals.message}</p>
            ) : signals.kind === 'ready' && signalCount === 0 ? (
              <p className="mt-2 text-[11px] text-[var(--fg-subtle)]">No signals yet for this area. Run a scan to launch EO producers.</p>
            ) : signals.kind === 'ready' ? (
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {signals.features.slice(0, 12).map((f, i) => {
                  const p = f.properties ?? {};
                  const val = typeof p.value === 'number' ? p.value.toFixed(2) : null;
                  return (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px]">
                      <span className="flex-1 truncate text-[var(--fg)]">{p.measurement ?? p.name ?? 'signal'}</span>
                      {val != null && <span className="tabular-nums text-[var(--fg-muted)]">{val}</span>}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Run scan — only meaningful when the gateway is reachable + bbox exists. */}
            {bbox && signals.kind !== 'unconfigured' && (
              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <div className="mb-1.5 text-[10px] uppercase tracking-[var(--tracking-wide)] text-[var(--fg-subtle)]">Run scan</div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {SCAN_OPTIONS.map((o) => {
                    const on = scanPick.has(o.id);
                    return (
                      <button
                        key={o.id}
                        disabled={scanBusy}
                        onClick={() => setScanPick((prev) => { const next = new Set(prev); if (next.has(o.id)) next.delete(o.id); else next.add(o.id); return next; })}
                        className={`rounded-full border px-2 py-0.5 text-[10px] transition disabled:opacity-50 ${on ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_16%,transparent)] text-[var(--fg)]' : 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--fg-muted)] hover:border-[var(--accent)]'}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={handleScan}
                  disabled={scanBusy || scanPick.size === 0}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--fg-on-accent)] transition hover:brightness-110 disabled:opacity-50"
                >
                  {scanBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Satellite className="size-3.5" />}
                  {scanBusy ? 'Scanning…' : 'Run scan'}
                </button>
                {scanMsg && <p className="mt-2 truncate text-[10px] text-[var(--fg-subtle)]" title={scanMsg}>{scanMsg}</p>}
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function centerOf(t: Twin): [number, number] {
  if (t.geom.type === 'point') return [t.geom.lng, t.geom.lat];
  if (t.geom.type === 'rect' || t.geom.type === 'circle') return t.geom.center;
  return t.geom.points[0];
}
