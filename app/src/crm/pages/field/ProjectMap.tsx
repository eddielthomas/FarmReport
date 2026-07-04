// =============================================================================
// ProjectMap — the field "project" map (S9B, extracted for the S18 dual-map).
// -----------------------------------------------------------------------------
// Renders the field agronomist's GPS, assigned-job pins (status -> color), and a
// geofence circle per job. Tap a pin -> onOpenJob(job). Pure presentational:
// the caller owns the GPS fix + job list so it can be shared with DirectionsMap.
// =============================================================================

import * as React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type FieldJob } from '@crm/lib/field-types';
import { type GeoFix } from '@crm/lib/useGeolocation';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export function statusColor(status: FieldJob['status']) {
  switch (status) {
    case 'assigned':    return '#4DA3FF';
    case 'en_route':    return '#66FFED';
    case 'on_site':     return '#2FCB73';
    case 'in_progress': return '#B9FF66';
    case 'paused':      return '#F6D34A';
    case 'completed':   return '#7B7E86';
    case 'cancelled':   return '#F04949';
    default:            return '#B5B7BD';
  }
}

interface ProjectMapProps {
  fix: GeoFix | null;
  jobs: FieldJob[];
  onOpenJob: (job: FieldJob) => void;
}

export function ProjectMap({ fix, jobs, onOpenJob }: ProjectMapProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const markersRef = React.useRef<Map<string, maplibregl.Marker>>(new Map());
  const meMarkerRef = React.useRef<maplibregl.Marker | null>(null);
  // Keep the latest jobs in a ref so the onOpenJob closure stays current.
  const onOpenRef = React.useRef(onOpenJob);
  onOpenRef.current = onOpenJob;

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
      map.addSource('geofences', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'geofence-fill', type: 'circle', source: 'geofences',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, ['/', ['get', 'radius_m'], 4], 18, ['/', ['get', 'radius_m'], 1]],
          'circle-color': '#B9FF66', 'circle-opacity': 0.18,
          'circle-stroke-color': '#B9FF66', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.6,
        },
      });
      map.resize();
    });
    return () => {
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null; markersRef.current = new Map(); meMarkerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix) return;
    if (!meMarkerRef.current) {
      const dot = document.createElement('div');
      Object.assign(dot.style, {
        width: '20px', height: '20px', borderRadius: '9999px', background: '#66FFED',
        boxShadow: '0 0 0 4px rgba(102,255,237,0.25), 0 0 0 12px rgba(102,255,237,0.1)', border: '2px solid #0B0C0F',
      });
      dot.setAttribute('aria-label', 'My location');
      meMarkerRef.current = new maplibregl.Marker({ element: dot }).setLngLat([fix.lon, fix.lat]).addTo(map);
      map.flyTo({ center: [fix.lon, fix.lat], zoom: 14, essential: true });
    } else {
      meMarkerRef.current.setLngLat([fix.lon, fix.lat]);
    }
  }, [fix]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const seen = new Set<string>();
      for (const j of jobs) {
        if (j.lat == null || j.lon == null) continue;
        seen.add(j.id);
        let marker = markersRef.current.get(j.id);
        const color = statusColor(j.status);
        if (!marker) {
          const el = document.createElement('button');
          el.type = 'button';
          el.setAttribute('aria-label', j.title);
          Object.assign(el.style, {
            width: '32px', height: '32px', borderRadius: '9999px', background: color, color: '#0A0A0A',
            fontSize: '14px', fontWeight: '700', display: 'grid', placeItems: 'center',
            boxShadow: '0 6px 16px rgba(0,0,0,0.45), 0 0 0 2px #0B0C0F', cursor: 'pointer',
          });
          el.textContent = (j.title || '?').charAt(0).toUpperCase();
          el.addEventListener('click', (e) => { e.stopPropagation(); onOpenRef.current(j); });
          marker = new maplibregl.Marker({ element: el }).setLngLat([j.lon, j.lat]).addTo(map);
          markersRef.current.set(j.id, marker);
        } else {
          marker.setLngLat([j.lon, j.lat]);
          marker.getElement().style.background = color;
        }
      }
      for (const [id, m] of markersRef.current.entries()) {
        if (!seen.has(id)) { m.remove(); markersRef.current.delete(id); }
      }
      const src = map.getSource('geofences') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({
        type: 'FeatureCollection',
        features: jobs.filter((j) => j.lat != null && j.lon != null).map((j) => ({
          type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [j.lon!, j.lat!] },
          properties: { id: j.id, radius_m: j.geofence_radius_m },
        })),
      });
    };
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
  }, [jobs]);

  return (
    <div className="relative h-full w-full bg-[var(--bg)]" style={{ minHeight: 240 }}>
      <div ref={containerRef} className="absolute inset-0" style={{ minHeight: 240 }} aria-label="Project map" />
      {fix && (
        <button
          type="button" aria-label="Recenter on my location"
          onClick={() => { const m = mapRef.current; if (m && fix) m.flyTo({ center: [fix.lon, fix.lat], zoom: 15 }); }}
          className="absolute right-3 bottom-3 grid place-items-center size-12 rounded-[var(--radius-full)] bg-[var(--accent)] text-[var(--fg-on-accent)] shadow-[var(--shadow-accent)]"
        >●</button>
      )}
      {!fix && (
        <div className="absolute left-3 right-3 top-3 p-3 rounded-[var(--radius-lg)] bg-[var(--surface)]/85 text-[var(--fg)] text-[12px] backdrop-blur">
          Waiting for GPS…
        </div>
      )}
    </div>
  );
}
