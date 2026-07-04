// =============================================================================
// DirectionsMap — turn-by-turn-ish directions from the agronomist's GPS to the field.
// -----------------------------------------------------------------------------
// Draws a routed polyline (OSRM public router, straight-line haversine fallback)
// from the caller's current position to the assigned job's location, with a
// distance + ETA banner, a collapsible step list, and an "Open in Maps" button
// that hands off to the device's native turn-by-turn via a geo: deep-link.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Navigation, ChevronDown, ChevronUp } from 'lucide-react';
import { type FieldJob } from '@crm/lib/field-types';
import { type GeoFix } from '@crm/lib/useGeolocation';
// Sprint A3 — pack-driven vocabulary. The rendered noun is resolved from the
// active SolutionPack: `vocab('detection', …)`. The farm pack resolves this to
// "observation"; the 'observation' fallback below only shows when the pack key
// is absent. (Reskinning the live label happens in the pack, not this file.)
import { t as vocab, tCap as vocabCap } from '@crm/lib/vocab';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

interface RouteStep { instruction: string; distance_m: number; }
interface RouteResult {
  coords: [number, number][];
  distance_m: number;
  duration_s: number | null;
  steps: RouteStep[];
  straightLine: boolean;
}

function haversine(a: GeoFix, lat: number, lon: number) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat - a.lat) * toR, dLon = (lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function fmtDist(m: number) { return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; }
function fmtEta(s: number | null) { if (s == null) return '—'; const min = Math.round(s / 60); return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${min % 60}m`; }

function maneuverText(step: { maneuver?: { type?: string; modifier?: string }; name?: string }): string {
  const t = step.maneuver?.type ?? 'continue';
  const mod = step.maneuver?.modifier ? ` ${step.maneuver.modifier}` : '';
  const road = step.name ? ` onto ${step.name}` : '';
  if (t === 'depart')  return `Head out${road}`;
  if (t === 'arrive')  return `Arrive at the ${vocab('detection', 'observation')}`;
  if (t === 'turn')    return `Turn${mod}${road}`;
  if (t === 'roundabout' || t === 'rotary') return `Take the roundabout${road}`;
  if (t === 'merge')   return `Merge${mod}${road}`;
  if (t === 'fork')    return `Keep${mod}${road}`;
  return `Continue${mod}${road}`;
}

async function fetchRoute(fix: GeoFix, job: FieldJob): Promise<RouteResult> {
  const lat = job.lat!, lon = job.lon!;
  const straight: RouteResult = {
    coords: [[fix.lon, fix.lat], [lon, lat]],
    distance_m: haversine(fix, lat, lon), duration_s: null, steps: [], straightLine: true,
  };
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fix.lon},${fix.lat};${lon},${lat}?overview=full&geometries=geojson&steps=true`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const route = j?.routes?.[0];
    if (j?.code !== 'Ok' || !route?.geometry?.coordinates?.length) return straight;
    const steps: RouteStep[] = (route.legs?.[0]?.steps ?? [])
      .map((s: { maneuver?: { type?: string; modifier?: string }; name?: string; distance?: number }) =>
        ({ instruction: maneuverText(s), distance_m: s.distance ?? 0 }))
      .filter((s: RouteStep) => s.instruction);
    return {
      coords: route.geometry.coordinates as [number, number][],
      distance_m: route.distance ?? straight.distance_m,
      duration_s: route.duration ?? null,
      steps, straightLine: false,
    };
  } catch {
    return straight;
  }
}

interface DirectionsMapProps { fix: GeoFix | null; job: FieldJob | null; }

export function DirectionsMap({ fix, job }: DirectionsMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const meRef = React.useRef<maplibregl.Marker | null>(null);
  const fieldRef = React.useRef<maplibregl.Marker | null>(null);
  const [route, setRoute] = React.useState<RouteResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [stepsOpen, setStepsOpen] = React.useState(false);

  const hasEnds = !!fix && !!job && job.lat != null && job.lon != null;

  // ---- map bootstrap ------------------------------------------------------
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = new maplibregl.Map({
      container: el, style: STYLE_URL, center: [-98.5, 39.8], zoom: 3,
      attributionControl: { compact: true }, maxPitch: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#66FFED', 'line-width': 5, 'line-opacity': 0.9 },
      });
      map.resize();
    });
    return () => { try { map.remove(); } catch { /* ignore */ } mapRef.current = null; meRef.current = null; fieldRef.current = null; };
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- fetch the route whenever the endpoints change ----------------------
  React.useEffect(() => {
    if (!hasEnds) { setRoute(null); return; }
    let alive = true;
    setLoading(true);
    fetchRoute(fix!, job!).then((r) => { if (alive) { setRoute(r); setLoading(false); } });
    return () => { alive = false; };
  }, [hasEnds, fix?.lat, fix?.lon, job?.id, job?.lat, job?.lon]);

  // ---- paint route + markers + fit bounds ---------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !route || !fix || !job) return;
    const paint = () => {
      const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: {} });
      // tech marker (start)
      if (!meRef.current) {
        const d = document.createElement('div');
        Object.assign(d.style, { width: '18px', height: '18px', borderRadius: '9999px', background: '#66FFED', border: '2px solid #0B0C0F', boxShadow: '0 0 0 4px rgba(102,255,237,0.25)' });
        meRef.current = new maplibregl.Marker({ element: d }).setLngLat([fix.lon, fix.lat]).addTo(map);
      } else meRef.current.setLngLat([fix.lon, fix.lat]);
      // field marker (end)
      if (!fieldRef.current) {
        const d = document.createElement('div');
        Object.assign(d.style, { width: '30px', height: '30px', borderRadius: '9999px 9999px 9999px 2px', transform: 'rotate(45deg)', background: '#F04949', border: '2px solid #0B0C0F', boxShadow: '0 6px 16px rgba(0,0,0,0.45)' });
        d.setAttribute('aria-label', `${vocabCap('detection', 'observation')} location`);
        fieldRef.current = new maplibregl.Marker({ element: d, anchor: 'bottom' }).setLngLat([job.lon!, job.lat!]).addTo(map);
      } else fieldRef.current.setLngLat([job.lon!, job.lat!]);
      // fit
      const b = new maplibregl.LngLatBounds();
      for (const c of route.coords) b.extend(c as [number, number]);
      if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
    };
    if (map.isStyleLoaded()) paint(); else map.once('load', paint);
  }, [route, fix?.lat, fix?.lon, job?.id]);

  const mapsHref = job && job.lat != null && job.lon != null
    ? `geo:${job.lat},${job.lon}?q=${job.lat},${job.lon}(${encodeURIComponent(job.title ?? vocabCap('detection', 'observation'))})`
    : '#';

  return (
    <div className="relative h-full w-full bg-[var(--bg)]" style={{ minHeight: 240 }}>
      <div ref={containerRef} className="absolute inset-0" style={{ minHeight: 240 }} aria-label="Directions map" />

      {!hasEnds && (
        <div className="absolute left-3 right-3 top-3 p-3 rounded-[var(--radius-lg)] bg-[var(--surface)]/90 text-[var(--fg)] text-[12px] backdrop-blur">
          {!fix ? 'Waiting for GPS…' : 'No assigned job with a location to navigate to.'}
        </div>
      )}

      {/* Directions banner */}
      {hasEnds && (
        <div className="absolute left-3 right-3 top-3 rounded-[var(--radius-xl)] bg-[var(--surface)]/92 border border-[var(--border)] backdrop-blur shadow-[var(--shadow-card)] overflow-hidden">
          <div className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-[var(--tracking-wider)] text-[var(--fg-muted)]">Directions to {vocab('detection', 'observation')}</div>
              <div className="text-[14px] font-semibold truncate">{job!.title}</div>
              <div className="mt-0.5 text-[12px] text-[var(--fg-muted)] flex items-center gap-2 font-mono">
                <span>{loading ? '…' : fmtDist(route?.distance_m ?? 0)}</span>
                <span aria-hidden>·</span>
                <span>ETA {loading ? '…' : fmtEta(route?.duration_s ?? null)}</span>
                {route?.straightLine && <span className="text-[10px] not-italic text-[var(--amber,#F6D34A)]">(direct)</span>}
              </div>
            </div>
            <a
              href={mapsHref}
              className="grid place-items-center gap-0.5 px-3 py-2 rounded-[var(--radius-lg)] bg-[var(--accent)] text-[var(--fg-on-accent)] text-[11px] font-semibold"
              aria-label="Open turn-by-turn in Maps"
            >
              <Navigation className="size-4" />
              Maps
            </a>
          </div>
          {route && route.steps.length > 0 && (
            <div className="border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setStepsOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-[var(--fg-muted)]"
                aria-expanded={stepsOpen}
              >
                <span>{route.steps.length} steps</span>
                {stepsOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {stepsOpen && (
                <ol className="max-h-[180px] overflow-y-auto px-3 pb-2 space-y-1.5">
                  {route.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12px]">
                      <span className="mt-0.5 grid place-items-center size-5 shrink-0 rounded-[var(--radius-full)] bg-[var(--bg-elevated)] text-[10px] font-mono">{i + 1}</span>
                      <span className="flex-1">{s.instruction}</span>
                      <span className="font-mono text-[11px] text-[var(--fg-subtle)]">{fmtDist(s.distance_m)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
